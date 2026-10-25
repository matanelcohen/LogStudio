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
                  --check-updates       Show the latest stable release and its notes.
                  --update              Download, verify and install a desktop update.
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
        if (options.CheckUpdates)
            return Tool.Program.UpdateAsync(UpdateApplication.Desktop, options.Update).GetAwaiter().GetResult();

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

    internal static Size GetInitialWindowSize(Size workArea, DesktopWindowSettings? saved = null)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(workArea.Width, nameof(workArea));
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(workArea.Height, nameof(workArea));
        // Keep space for native title bars even on short displays.
        Size defaultSize = new(
            Math.Min(1280, workArea.Width - workArea.Width / 10),
            Math.Min(800, Math.Max(1, workArea.Height - Math.Max(80, workArea.Height / 10))));
        if (saved is null) return defaultSize;
        return new Size(
            Math.Clamp(saved.Width, Math.Min(640, defaultSize.Width), workArea.Width),
            Math.Clamp(saved.Height, Math.Min(400, defaultSize.Height), Math.Max(1, workArea.Height - 80)));
    }

    private static void ShowWindow(Uri url, Action shutdown)
    {
        string profile = Path.Combine(AppSettingsStore.DefaultDirectory, "WebView");
        Directory.CreateDirectory(profile);
        using DesktopWindowPreferences preferences = new(new AppSettingsStore(), Console.Error);
        void Close()
        {
            preferences.Flush();
            shutdown();
        }
        using IDisposable? termination = OperatingSystem.IsMacOS() ? new MacApplicationLifetime(Close) : null;
        PhotinoWindow window = new PhotinoWindow()
            .SetTitle("Log Studio")
            .SetIconFile(Path.Combine(AppContext.BaseDirectory, OperatingSystem.IsWindows() ? "logstudio.ico" : "logstudio.png"))
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
                bool maximized = preferences.Saved?.Maximized ?? false;
                Size size = GetInitialWindowSize(workArea.Size, preferences.Saved);
                // Native resizing can be asynchronous; center using the requested size.
                window.SetMinSize(Math.Min(640, size.Width), Math.Min(400, size.Height))
                    .SetSize(size)
                    .MoveTo(workArea.Left + (workArea.Width - size.Width) / 2,
                        workArea.Top + (workArea.Height - size.Height) / 2, allowOutsideWorkArea: true);
                preferences.Initialize(size);
                if (maximized) window.SetMaximized(true);
            })
            .RegisterSizeChangedHandler((_, size) => preferences.Update(size, window.Maximized, window.Minimized))
            .RegisterMaximizedHandler((_, _) => preferences.Update(window.Size, maximized: true, minimized: false))
            .RegisterRestoredHandler((_, _) => preferences.Update(window.Size, window.Maximized, window.Minimized))
            .RegisterWindowClosingHandler((_, _) =>
            {
                Close();
                return false;
            })
            .Load(url)
            .WaitForClose();
    }
}
