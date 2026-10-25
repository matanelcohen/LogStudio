using System;
using System.Threading;
using System.Threading.Tasks;
using LogStudio.Tool;

namespace LogStudio.Desktop;

internal sealed class DesktopSession : IAsyncDisposable
{
    private readonly object gate = new();
    private readonly RunningApplicationsCollector collector;
    private Task? disposeTask;

    private DesktopSession(RunningApplicationsCollector collector, ConsoleLogViewer viewer)
    {
        this.collector = collector;
        this.Viewer = viewer;
    }

    internal ConsoleLogViewer Viewer { get; }

    internal static async Task<DesktopSession> StartAsync(ToolOptions options, string? sessionsDirectory = null)
    {
        RunningApplicationsCollector collector = new();
        try
        {
            ConsoleLogViewer? viewer = await ViewerStartup.StartAsync(new ConsoleLogViewerOptions
            {
                CaptureConsole = false,
                RunningApplications = collector,
                Port = options.Port,
                Capacity = options.Capacity,
                FlushEveryEntries = options.FlushEveryEntries,
                ApplicationName = options.Name,
                OpenBrowser = false,
                SaveSession = true,
                SessionsDirectory = sessionsDirectory ?? Environment.GetEnvironmentVariable(ToolOptions.SessionsDirectoryEnvironmentVariable),
                Updater = new ReleaseUpdater(UpdateApplication.Desktop),
            }, CancellationToken.None, _ => Task.FromResult(true)).ConfigureAwait(false);
            collector.Viewer = viewer;
            return new DesktopSession(collector, viewer!);
        }
        catch
        {
            await collector.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    public ValueTask DisposeAsync()
    {
        lock (this.gate)
        {
            return new ValueTask(this.disposeTask ??= this.DisposeCoreAsync());
        }
    }

    private async Task DisposeCoreAsync()
    {
        try
        {
            await this.collector.DisposeAsync().ConfigureAwait(false);
        }
        finally
        {
            try
            {
                this.Viewer.Complete();
            }
            finally
            {
                await this.Viewer.DisposeAsync().ConfigureAwait(false);
            }
        }
    }
}
