using System;
using System.Drawing;
using System.IO;
using System.Reflection;
using LogStudio.Tool;
using Photino.NET;

namespace LogStudio.Desktop;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        ToolOptions options;
        try
        {
            options = DesktopOptions.Parse(args);
        }
        catch (ArgumentException exception)
        {
            Console.Error.WriteLine(exception.Message);
            Console.Error.WriteLine("Run LogStudio.Desktop --help for usage.");
            return 2;
        }

        if (options.Help)
        {
            Console.WriteLine("""
                Log Studio desktop — choose a running .NET application and capture new ILogger events.
                Usage: LogStudio.Desktop [options]
                  --port <number>       Localhost port (default 5177; automatically falls back if busy).
                  --capacity <number>   Maximum entries returned by normal history reads.
                  --flush-every <number> Flush disk history after this many entries.
                  --name <name>         Initial session name.
                  --help, -h            Show help without opening a window.
                  --version             Show version without opening a window.
                Closing the window disconnects capture; selected applications keep running.
                For command wrapping or browser-only use, run logstudio --help.
                """);
            return 0;
        }

        if (options.Version)
        {
            Console.WriteLine(typeof(Program).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
                .InformationalVersion.Split('+')[0]);
            return 0;
        }

        try
        {
            Run(options, ShowWindow);
            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"Could not start Log Studio desktop: {exception.Message}");
            try
            {
                string directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LogStudio");
                Directory.CreateDirectory(directory);
                string path = Path.Combine(directory, "desktop-error.log");
                File.WriteAllText(path, exception + Environment.NewLine);
                Console.Error.WriteLine($"Details: {path}");
            }
            catch (Exception loggingError) when (loggingError is IOException or UnauthorizedAccessException)
            {
                Console.Error.WriteLine($"Could not write startup diagnostics: {loggingError.Message}");
            }
            return 1;
        }
    }

    internal static void Run(ToolOptions options, Action<Uri, Action> showWindow, string? sessionsDirectory = null)
    {
        DesktopSession session = DesktopSession.StartAsync(options, sessionsDirectory).GetAwaiter().GetResult();
        try
        {
            // Keep Photino's message loop on the original STA/main thread on Windows and macOS.
            showWindow(session.Viewer.Url, () =>
            {
                try
                {
                    session.DisposeAsync().AsTask().GetAwaiter().GetResult();
                }
                catch (Exception exception)
                {
                    Console.Error.WriteLine($"Could not save the desktop session: {exception}");
                }
            });
        }
        finally
        {
            session.DisposeAsync().AsTask().GetAwaiter().GetResult();
        }
    }

    internal static Size GetInitialWindowSize(Size workArea)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(workArea.Width, nameof(workArea));
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(workArea.Height, nameof(workArea));
        // Keep space for native title bars even on short displays.
        return new Size(
            Math.Min(1280, workArea.Width - workArea.Width / 10),
            Math.Min(800, Math.Max(1, workArea.Height - Math.Max(80, workArea.Height / 10))));
    }

    private static void ShowWindow(Uri url, Action shutdown)
    {
        string profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LogStudio", "WebView");
        Directory.CreateDirectory(profile);
        using IDisposable? termination = OperatingSystem.IsMacOS() ? new MacApplicationLifetime(shutdown) : null;
        PhotinoWindow window = new PhotinoWindow()
            .SetTitle("Log Studio")
            .SetUseOsDefaultSize(true)
            .SetResizable(true)
            .SetTemporaryFilesPath(profile)
            .SetGrantBrowserPermissions(false)
            .SetMediaAutoplayEnabled(false)
            .SetMediaStreamEnabled(false)
            .SetNotificationsEnabled(false)
            .SetFileSystemAccessEnabled(false)
            .SetWebSecurityEnabled(true)
            .SetIgnoreCertificateErrorsEnabled(false)
            .SetDevToolsEnabled(false)
            .SetLogVerbosity(0);
        window
            .RegisterWindowCreatedHandler((_, _) =>
            {
                Rectangle workArea = window.MainMonitor.WorkArea;
                Size size = GetInitialWindowSize(workArea.Size);
                // Native resizing can be asynchronous; center using the requested size.
                window.SetMinSize(Math.Min(640, size.Width), Math.Min(400, size.Height))
                    .SetSize(size)
                    .MoveTo(workArea.Left + (workArea.Width - size.Width) / 2,
                        workArea.Top + (workArea.Height - size.Height) / 2, allowOutsideWorkArea: true);
            })
            .RegisterWindowClosingHandler((_, _) =>
            {
                shutdown();
                return false;
            })
            .Load(url)
            .WaitForClose();
    }
}
