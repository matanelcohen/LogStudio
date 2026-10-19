using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;

namespace LogStudio.Tool;

internal static class Program
{
    private const int InvalidArgumentsExitCode = 2;
    private const int ToolFailureExitCode = 1;
    private const int InterruptedExitCode = 130;
    private const int PumpBufferSize = 4096;
    private const int ExecutableNotFoundError = 2;
    private const int ExecutablePathNotFoundError = 3;
    private const int UnixExecutableFormatError = 8;
    private const int MacBadCpuTypeError = 86;
    private const string ExecutablePathGuidance =
        "Shell aliases and functions are not executable child commands. Use a full executable path, or invoke your shell explicitly.";
    private const string ExecutableArchitectureGuidance =
        "The executable's CPU architecture is not supported here. Use a native executable; x64 apps on Apple Silicon require compatible OS translation (Rosetta).";
    private static readonly TimeSpan OutputDrainTimeout = TimeSpan.FromSeconds(5);

    private static async Task<int> Main(string[] args)
    {
        ToolOptions options;
        try
        {
            options = ToolOptions.Parse(args);
        }
        catch (ArgumentException exception)
        {
            Console.Error.WriteLine(exception.Message);
            Console.Error.WriteLine($"Run {ToolOptions.CommandName} {ToolOptions.HelpSwitch} for usage.");
            return InvalidArgumentsExitCode;
        }

        if (options.Help)
        {
            PrintHelp();
            return 0;
        }

        if (options.Version)
        {
            string? version = typeof(Program).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
            Console.WriteLine(version?.Split('+')[0] ?? typeof(Program).Assembly.GetName().Version?.ToString());
            return 0;
        }

        using CancellationTokenSource cancellation = new();
        ConsoleCancelEventHandler handler = (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            cancellation.Cancel();
        };
        Console.CancelKeyPress += handler;
        try
        {
            return await RunAsync(options, cancellation.Token).ConfigureAwait(false);
        }
        catch (ArgumentException exception)
        {
            Console.Error.WriteLine($"Invalid viewer options: {exception.Message}");
            return InvalidArgumentsExitCode;
        }
        catch (HttpListenerException exception)
        {
            Console.Error.WriteLine($"Could not start the localhost viewer: {exception.Message}");
            return ToolFailureExitCode;
        }
        catch (Win32Exception exception)
        {
            Console.Error.WriteLine($"Could not launch '{options.Command}': {exception.Message}");
            if (exception.NativeErrorCode is ExecutableNotFoundError or ExecutablePathNotFoundError)
            {
                Console.Error.WriteLine(ExecutablePathGuidance);
            }
            else if ((OperatingSystem.IsMacOS() && exception.NativeErrorCode == MacBadCpuTypeError) ||
                     (!OperatingSystem.IsWindows() && exception.NativeErrorCode == UnixExecutableFormatError))
            {
                Console.Error.WriteLine(ExecutableArchitectureGuidance);
            }

            return ToolFailureExitCode;
        }
        catch (IOException exception)
        {
            Console.Error.WriteLine($"Console capture failed: {exception.Message}");
            return ToolFailureExitCode;
        }
        catch (InvalidOperationException exception)
        {
            Console.Error.WriteLine($"The log wrapper failed: {exception.Message}");
            return ToolFailureExitCode;
        }
        finally
        {
            Console.CancelKeyPress -= handler;
        }
    }

    private static async Task<int> RunAsync(ToolOptions options, CancellationToken cancellationToken)
    {
        await using ConsoleLogViewer viewer = ConsoleLogViewer.Start(new ConsoleLogViewerOptions
        {
            CaptureConsole = false,
            Port = options.Port,
            Capacity = options.Capacity,
            FlushEveryEntries = options.FlushEveryEntries,
            ApplicationName = options.Name,
            OpenBrowser = options.OpenBrowser,
            SaveSession = true,
            SessionsDirectory = Environment.GetEnvironmentVariable(ToolOptions.SessionsDirectoryEnvironmentVariable),
            RunCommand = options.Command,
            RunArguments = options.Arguments,
            RunWorkingDirectory = Environment.CurrentDirectory,
        });
        using TextWriter stdout = viewer.CreateCaptureWriter(Console.Out, LogStream.Stdout);
        using TextWriter stderr = viewer.CreateCaptureWriter(Console.Error, LogStream.Stderr);
        ProcessStartInfo startInfo = new(options.Command)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
        };
        foreach (string argument in options.Arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }


        using Process child = new() { StartInfo = startInfo };
        if (!child.Start())
        {
            throw new InvalidOperationException($"The process '{options.Command}' did not start.");
        }

        using CancellationTokenSource outputStop = new();
        using CancellationTokenSource inputStop = new();
        Task input = PumpInputAsync(Console.OpenStandardInput(), child.StandardInput.BaseStream, inputStop.Token);
        Task output = PumpAsync(child.StandardOutput, stdout, child, outputStop.Token);
        Task error = PumpAsync(child.StandardError, stderr, child, outputStop.Token);
        Task waitForExit = child.WaitForExitAsync(cancellationToken);
        bool interrupted = false;
        try
        {
            if (await Task.WhenAny(waitForExit, input).ConfigureAwait(false) == input)
            {
                try
                {
                    await input.ConfigureAwait(false);
                }
                catch
                {
                    StopChild(child);
                    await child.WaitForExitAsync().ConfigureAwait(false);
                    throw;
                }

                CloseChildInput(child);
            }

            await waitForExit.ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            interrupted = true;
            StopChild(child);
            await child.WaitForExitAsync().ConfigureAwait(false);
        }

        inputStop.Cancel();
        if (!input.IsCompleted)
        {
            CloseChildInput(child);
        }

        if (input.IsCompleted)
        {
            try
            {
                await input.ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (inputStop.IsCancellationRequested)
            {
            }
            catch (IOException) when (child.HasExited)
            {
            }
            catch (ObjectDisposedException) when (child.HasExited)
            {
            }
        }

        Task pumps = Task.WhenAll(output, error);
        try
        {
            await pumps.WaitAsync(OutputDrainTimeout).ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            Console.Error.WriteLine("Output drain timed out: a descendant still holds a console pipe. Remaining output will not be captured.");
            outputStop.Cancel();
            try
            {
                await pumps.ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (outputStop.IsCancellationRequested)
            {
            }
        }

        int exitCode = interrupted ? InterruptedExitCode : child.ExitCode;
        viewer.Complete(exitCode);
        if (options.WaitAfterExit && !interrupted)
        {
            Console.Error.WriteLine($"Process finished with exit code {exitCode}. The viewer remains available at {viewer.Url}");
            Console.Error.WriteLine("Press Ctrl+C to close the viewer.");
            try
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
            }
        }

        return exitCode;
    }

    private static void CloseChildInput(Process child)
    {
        try
        {
            child.StandardInput.Close();
        }
        catch (IOException)
        {
        }
        catch (ObjectDisposedException)
        {
        }
    }

    private static async Task PumpInputAsync(Stream source, Stream destination, CancellationToken cancellationToken)
    {
        byte[] buffer = new byte[PumpBufferSize];
        int count;
        while ((count = await source.ReadAsync(buffer.AsMemory(), cancellationToken).ConfigureAwait(false)) > 0)
        {
            await destination.WriteAsync(buffer.AsMemory(0, count), cancellationToken).ConfigureAwait(false);
        }

        await destination.FlushAsync(cancellationToken).ConfigureAwait(false);
    }

    private static async Task PumpAsync(StreamReader source, TextWriter destination, Process child, CancellationToken cancellationToken)
    {
        try
        {
            char[] buffer = new char[PumpBufferSize];
            int count;
            while ((count = await source.ReadAsync(buffer.AsMemory(), cancellationToken).ConfigureAwait(false)) > 0)
            {
                await destination.WriteAsync(buffer.AsMemory(0, count), cancellationToken).ConfigureAwait(false);
            }

            await destination.FlushAsync().ConfigureAwait(false);
        }
        catch (IOException)
        {
            StopChild(child);
            throw;
        }
    }

    private static void StopChild(Process child)
    {
        try
        {
            if (!child.HasExited)
            {
                child.Kill(entireProcessTree: true);
            }
        }
        catch (InvalidOperationException) when (child.HasExited)
        {
            // The child can exit between HasExited and Kill.
        }
    }

    private static void PrintHelp()
    {
        Console.WriteLine(
            """
            Log Studio - live console log wrapper

            Usage:
              logstudio [options] -- <command> [arguments]

            Options:
              --open             Open the browser automatically.
              --port <number>    Localhost port; 0 selects an available port (default).
              --capacity <count> Optional retention limit; 0 keeps all entries (default).
              --flush-every <n>  Flush journal buffers every n entries (default: 1000).
              --name <name>      Display name for this run (default: unique random name).
              --no-wait          Exit with the child's exit code when it finishes.
              --help, -h         Show this help.
              --version          Show the installed Log Studio version.

            Examples:
              logstudio --open -- dotnet run --project path/to/ConsoleApp.csproj
              logstudio --name MyApp -- dotnet path/to/MyApp.dll --input="value with spaces"
              logstudio --no-wait -- dotnet path/to/MyApp.dll

            Standard input is inherited, so interactive console input still works.
            By default the viewer stays available after the child finishes.
            History is unlimited by default and stored in private temporary files.
            Reads and completion also flush pending entries. Files are deleted on exit.
            Use --no-wait in scripts to preserve normal process lifetime and exit codes.
            No shell expansion is performed; child arguments are passed individually.
            """
        );
    }
}
