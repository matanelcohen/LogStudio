using System;
using System.Threading.Tasks;

namespace LogStudio;

internal sealed record ViewerSession(
    LogBuffer Logs,
    SessionCatalog Catalog,
    Func<LogClearResult> Clear,
    Func<string, SessionInfo> Rename);

internal sealed class LogChangeSignal
{
    private readonly object gate = new();
    private TaskCompletionSource changed = NewSignal();
    private long revision;

    internal Task Changed
    {
        get { lock (this.gate) return this.changed.Task; }
    }

    internal long Pulse()
    {
        lock (this.gate)
        {
            TaskCompletionSource previous = this.changed;
            this.changed = NewSignal();
            previous.TrySetResult();
            return ++this.revision;
        }
    }

    private static TaskCompletionSource NewSignal() => new(TaskCreationOptions.RunContinuationsAsynchronously);
}
