using System;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace LogStudio;

internal interface IRunningApplications : IAsyncDisposable
{
    RunningApplicationsState GetState();

    Task<RunningApplicationsState> SelectAsync(int processId, long startedAtTicks, CancellationToken cancellationToken);
}

internal sealed record RunningApplication(int ProcessId, string Name,
    [property: JsonNumberHandling(JsonNumberHandling.WriteAsString)] long StartedAtTicks);

internal sealed record RunningApplicationsState(RunningApplication[] Applications, RunningApplication? Selected, string? Error);
