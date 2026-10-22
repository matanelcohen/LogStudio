using System;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;

namespace LogStudio;

internal interface IRunningApplications : IAsyncDisposable
{
    RunningApplicationsState GetState();

    Task<RunningApplicationsState> SelectAsync(int processId, long startedAtTicks, CancellationToken cancellationToken, bool includeRelated = false);
}

internal sealed record RunningApplication(int ProcessId, string Name,
    [property: JsonNumberHandling(JsonNumberHandling.WriteAsString)] long StartedAtTicks,
    string? Path = null, string? GroupId = null, RunningApplicationProcess[]? Processes = null, bool IsTool = false);

internal sealed record RunningApplicationProcess(int ProcessId, string Name,
    [property: JsonNumberHandling(JsonNumberHandling.WriteAsString)] long StartedAtTicks, string? Path = null);

internal sealed record RunningApplicationsState(RunningApplication[] Applications, RunningApplication? Selected, string? Error);
