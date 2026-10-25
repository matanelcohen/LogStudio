using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
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
        if (options.CheckUpdates)
            return await UpdateAsync(UpdateApplication.Cli, options.Update).ConfigureAwait(false);

        using CancellationTokenSource cancellation = new();
        ConsoleCancelEventHandler handler = (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            cancellation.Cancel();
        };
        Console.CancelKeyPress += handler;
        try
        {
            return options.ListenAll
                ? await ListenAsync(options, cancellation.Token).ConfigureAwait(false)
                : await RunAsync(options, cancellation.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
            return InterruptedExitCode;
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

    private static async Task<int> ListenAsync(ToolOptions options, CancellationToken cancellationToken)
    {
        await using RunningApplicationsCollector collector = new();
        await using ConsoleLogViewer? viewer = await ViewerStartup.StartAsync(new ConsoleLogViewerOptions
        {
            CaptureConsole = false,
            RunningApplications = collector,
            Port = options.Port,
            Capacity = options.Capacity,
            FlushEveryEntries = options.FlushEveryEntries,
            ApplicationName = options.Name,
            OpenBrowser = options.OpenBrowser,
            SaveSession = true,
            SessionsDirectory = Environment.GetEnvironmentVariable(ToolOptions.SessionsDirectoryEnvironmentVariable),
            Updater = new ReleaseUpdater(UpdateApplication.Cli),
        }, cancellationToken).ConfigureAwait(false);
        if (viewer is null) return 0;
        try
        {
            collector.Viewer = viewer;
            Console.Error.WriteLine("Select a running .NET application in the viewer to start capturing new ILogger events.");
            Console.Error.WriteLine("Press Ctrl+C to close the viewer. Selected applications will keep running.");
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        finally
        {
            await collector.DisposeAsync().ConfigureAwait(false);
        }

        viewer.Complete(InterruptedExitCode);
        return InterruptedExitCode;
    }

    private static async Task<int> RunAsync(ToolOptions options, CancellationToken cancellationToken)
    {
        using ProcessInput processInput = new();
        await using ConsoleLogViewer? viewer = await ViewerStartup.StartAsync(new ConsoleLogViewerOptions
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
            Input = processInput,
            Updater = new ReleaseUpdater(UpdateApplication.Cli),
        }, cancellationToken).ConfigureAwait(false);
        if (viewer is null) return 0;
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
        processInput.Attach(child.StandardInput.BaseStream, child.StandardInput.Encoding);
        child.Exited += (_, _) => processInput.Close();
        child.EnableRaisingEvents = true;

        using CancellationTokenSource outputStop = new();
        using CancellationTokenSource inputStop = new();
        Task input = PumpInputAsync(Console.OpenStandardInput(), processInput, inputStop.Token);
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

                processInput.Close();
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
        processInput.Close();

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

    private static async Task PumpInputAsync(Stream source, ProcessInput destination, CancellationToken cancellationToken)
    {
        try
        {
            byte[] buffer = new byte[PumpBufferSize];
            int count;
            while ((count = await source.ReadAsync(buffer.AsMemory(), cancellationToken).ConfigureAwait(false)) > 0)
            {
                await destination.WriteAsync(buffer.AsMemory(0, count), cancellationToken).ConfigureAwait(false);
            }
        }
        catch (Exception exception) when (!destination.CanWrite && exception is IOException or ObjectDisposedException or OperationCanceledException)
        {
        }
        finally
        {
            destination.Close();
        }
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

    internal static async Task<int> UpdateAsync(UpdateApplication application, bool install)
    {
        try
        {
            ReleaseUpdater updater = new(application);
            AppUpdateState state = await updater.CheckAsync(CancellationToken.None).ConfigureAwait(false);
            Console.WriteLine($"Installed: {state.CurrentVersion}. Latest stable: {state.Release!.Version}");
            Console.WriteLine(state.Release.Url);
            Console.WriteLine(state.Release.Notes);
            if (!state.UpdateAvailable)
            {
                Console.WriteLine("No newer stable version is available.");
                return 0;
            }
            if (state.InstallationUnavailableReason is not null)
                Console.WriteLine(state.InstallationUnavailableReason);
            if (!install)
            {
                Console.WriteLine("Use --update to download, verify and install this application's update.");
                return 0;
            }
            await updater.InstallAsync(state.Release.Version).ConfigureAwait(false);
            Console.WriteLine("Update installed. Close and relaunch Log Studio to use the new version. Other running sessions are unchanged.");
            return 0;
        }
        catch (Exception exception) when (exception is InvalidOperationException or HttpRequestException or IOException or UnauthorizedAccessException)
        {
            Console.Error.WriteLine($"Update failed: {exception.Message}");
            return ToolFailureExitCode;
        }
    }

    private static void PrintHelp()
    {
        Console.WriteLine(
            $"""
            Log Studio - live console log wrapper

            Usage:
              logstudio [options] -- <command> [arguments]
              logstudio --listen-all [options]
              logstudio --check-updates
              logstudio --update

            Options:
              --open             Open the browser automatically.
              --port <number>    Localhost port (default: {ToolOptions.DefaultPort}); 0 selects an available port.
              --capacity <count> Optional retention limit; 0 keeps all entries (default).
              --flush-every <n>  Flush journal buffers every n entries (default: 1000).
              --name <name>      Display name for this run (default: unique random name).
              --no-wait          Exit with the child's exit code when it finishes.
              --listen-all       Choose a running .NET application in the viewer.
              --help, -h         Show this help.
              --version          Show the installed Log Studio version.
              --check-updates    Check the latest stable release and display its notes.
              --update           Download, verify and install an update to this CLI.

            Examples:
              logstudio --open -- dotnet run --project path/to/ConsoleApp.csproj
              logstudio --name MyApp -- dotnet path/to/MyApp.dll --input="value with spaces"
              logstudio --no-wait -- dotnet path/to/MyApp.dll
              logstudio --listen-all --open

            Standard input is forwarded, so interactive console input still works.
            Browser Terminal input sends one line while the child's standard input is open.
            By default the viewer stays available after the child finishes.
            If the port is occupied, choose already running or start on a new port.
            Redirected input never prompts; use --port 0 for automatic selection.
            History is unlimited by default and stored in private temporary files.
            Reads and completion also flush pending entries. Files are deleted on exit.
            Use --no-wait in scripts to preserve normal process lifetime and exit codes.
            No shell expansion is performed; child arguments are passed individually.
            Listen-all never attaches automatically and captures only new ILogger events.
            Selecting another application replaces the current log history.
            Listen-all does not accept a child command or --no-wait.
            """
        );
    }
}
