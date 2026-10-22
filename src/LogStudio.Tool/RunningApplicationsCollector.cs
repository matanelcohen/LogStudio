using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Diagnostics.Tracing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Diagnostics.NETCore.Client;
using Microsoft.Diagnostics.Tracing;

namespace LogStudio.Tool;

internal sealed class RunningApplicationsCollector : IRunningApplications
{
    private const string LoggingProvider = "Microsoft-Extensions-Logging";
    private static readonly TimeSpan AttachTimeout = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan StopTimeout = TimeSpan.FromSeconds(2);
    private readonly object stateGate = new();
    private readonly SemaphoreSlim selectionGate = new(1, 1);
    private readonly CancellationTokenSource shutdown = new();
    private readonly ConcurrentDictionary<(int ProcessId, long StartedAtTicks), ApplicationProcessMetadata> processMetadata = new();
    private readonly Task monitor;
    private Selection? selected;
    private string? error;
    private Task? disposeTask;

    internal ConsoleLogViewer? Viewer { get; set; }

    internal RunningApplicationsCollector()
    {
        this.monitor = Task.Run(this.MonitorAsync);
    }

    public RunningApplicationsState GetState()
    {
        RunningApplication[] applications;
        try
        {
            applications = this.Discover();
        }
        catch (Exception exception) when (IsDiagnosticFailure(exception))
        {
            applications = Array.Empty<RunningApplication>();
            lock (this.stateGate)
            {
                this.error = "Could not discover .NET applications. Check diagnostic permissions.";
            }
        }

        lock (this.stateGate)
        {
            return new RunningApplicationsState(applications, this.selected?.Snapshot(), this.error ?? this.selected?.Error);
        }
    }

    public async Task<RunningApplicationsState> SelectAsync(int processId, long startedAtTicks, CancellationToken cancellationToken, bool includeRelated = false)
    {
        using CancellationTokenSource cancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, this.shutdown.Token);
        Selection? candidate = null;
        bool entered = false;
        try
        {
            await this.selectionGate.WaitAsync(cancellation.Token).ConfigureAwait(false);
            entered = true;
            cancellation.Token.ThrowIfCancellationRequested();
            ConsoleLogViewer viewer = this.Viewer ?? throw this.Fail("The viewer is still starting. Try again.");
            RunningApplication[] applications = this.Discover();
            RunningApplication? application = applications.FirstOrDefault(item => item.Processes!.Any(process =>
                process.ProcessId == processId && process.StartedAtTicks == startedAtTicks));
            if (application is null)
            {
                throw this.Fail("This application exited or its process identity changed. Refresh the application list.");
            }

            if (!includeRelated)
            {
                RunningApplicationProcess process = application.Processes!.Single(process =>
                    process.ProcessId == processId && process.StartedAtTicks == startedAtTicks);
                application = new(process.ProcessId, process.Name, process.StartedAtTicks, process.Path, Processes: [process]);
            }

            Selection? current;
            lock (this.stateGate)
            {
                current = this.selected;
            }
            if (current is not null && current.IncludeRelated == includeRelated &&
                (includeRelated ? current.Application.GroupId == application.GroupId :
                    current.Application.ProcessId == processId && current.Application.StartedAtTicks == startedAtTicks))
            {
                await this.AddProcessesAsync(current, application, cancellation.Token, retryClosed: true).ConfigureAwait(false);
                lock (this.stateGate) this.error = null;
                return this.GetState();
            }

            candidate = new Selection(application, includeRelated);
            lock (this.stateGate)
            {
                if (this.selected is Selection active)
                {
                    // Reuse shared connections when changing scope instead of overlapping logging sessions.
                    foreach (Attachment attachment in active.Attachments.Where(attachment => !attachment.Ended &&
                        application.Processes!.Any(process => process.ProcessId == attachment.Application.ProcessId &&
                            process.StartedAtTicks == attachment.Application.StartedAtTicks)))
                    {
                        candidate.Attachments.Add(attachment);
                        candidate.Attempted.Add(RunningApplicationGroups.Identity(attachment.Application));
                    }
                }
            }
            await this.AddProcessesAsync(candidate, application, cancellation.Token).ConfigureAwait(false);
            cancellation.Token.ThrowIfCancellationRequested();
            Selection? previous;
            lock (this.stateGate)
            {
                if (candidate.Attachments.Count == 0)
                    throw this.Fail(candidate.Error ?? "The application's diagnostic connection closed. Select an application to try again.");
                previous = this.selected;
                previous?.Attachments.ExceptWith(candidate.Attachments);
                this.selected = null;
            }

            if (previous is not null)
            {
                await this.StopSelectionAsync(previous).ConfigureAwait(false);
            }

            cancellation.Token.ThrowIfCancellationRequested();
            lock (this.stateGate)
            {
                if (!candidate.Attachments.Any(attachment => !attachment.Ended))
                {
                    throw this.Fail("The application's diagnostic connection closed. Select an application to try again.");
                }
                else
                {
                    // Old callbacks are fenced out even if their IPC drain timed out.
                    string identity = includeRelated ? "group:" + application.GroupId :
                        $"process:{application.ProcessId}:{application.StartedAtTicks}";
                    viewer.SelectApplicationHistory(identity, application.Name);
                    candidate.Attachments.RemoveWhere(attachment => attachment.Ended);
                    candidate.Activated = true;
                    this.selected = candidate;
                    this.error = null;
                    candidate = null;
                }
            }

            return this.GetState();
        }
        catch (OperationCanceledException exception) when (!cancellation.IsCancellationRequested)
        {
            throw this.Fail("Attaching timed out. Check that diagnostics are enabled and the application is responding.", exception);
        }
        catch (OperationCanceledException) when (this.shutdown.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            lock (this.stateGate)
            {
                this.error = "The listener is shutting down.";
            }

            return this.GetState();
        }
        catch (Exception exception) when (IsDiagnosticFailure(exception) && exception is not SelectionException)
        {
            throw this.Fail("Could not attach. Check that the application is running, diagnostics are enabled, and you have permission.", exception);
        }
        finally
        {
            try
            {
                if (candidate is not null)
                {
                    await this.StopSelectionAsync(candidate).ConfigureAwait(false);
                }
            }
            finally
            {
                if (entered)
                {
                    this.selectionGate.Release();
                }
            }
        }
    }

    public ValueTask DisposeAsync()
    {
        lock (this.stateGate)
        {
            this.disposeTask ??= this.DisposeCoreAsync();
            return new ValueTask(this.disposeTask);
        }
    }

    private async Task DisposeCoreAsync()
    {
        this.shutdown.Cancel();
        await this.monitor.ConfigureAwait(false);
        await this.selectionGate.WaitAsync().ConfigureAwait(false);
        try
        {
            Selection? selection;
            lock (this.stateGate)
            {
                selection = this.selected;
                this.selected = null;
            }

            if (selection is not null)
            {
                await this.StopSelectionAsync(selection).ConfigureAwait(false);
            }
        }
        finally
        {
            this.selectionGate.Release();
        }
    }

    private RunningApplication[] Discover()
    {
        ApplicationProcessMetadata[] processes = DiagnosticsClient.GetPublishedProcesses()
            .Distinct()
            .Where(processId => processId != Environment.ProcessId)
            .Select(this.ReadMetadata)
            .OfType<ApplicationProcessMetadata>()
            .ToArray();
        HashSet<(int ProcessId, long StartedAtTicks)> identities = processes
            .Select(process => (process.Process.ProcessId, process.Process.StartedAtTicks)).ToHashSet();
        foreach ((int processId, long startedAtTicks) in this.processMetadata.Keys)
        {
            if (!identities.Contains((processId, startedAtTicks)))
            {
                this.processMetadata.TryRemove((processId, startedAtTicks), out _);
            }
        }

        return RunningApplicationGroups.Create(processes);
    }

    private ApplicationProcessMetadata? ReadMetadata(int processId)
    {
        try
        {
            using Process process = System.Diagnostics.Process.GetProcessById(processId);
            long startedAtTicks = process.StartTime.ToUniversalTime().Ticks;
            if (process.HasExited || startedAtTicks <= 0) return null;
            if (!this.processMetadata.TryGetValue((processId, startedAtTicks), out ApplicationProcessMetadata? metadata))
            {
                metadata = ApplicationProcessMetadata.Read(processId);
                if (metadata is null || metadata.Process.StartedAtTicks != startedAtTicks) return null;
                this.processMetadata.TryAdd((processId, startedAtTicks), metadata);
            }
            return process.HasExited ? null : metadata;
        }
        catch (Exception exception) when (IsDiagnosticFailure(exception) || exception is ArgumentException)
        {
            return null;
        }
    }

    private async Task AddProcessesAsync(Selection selection, RunningApplication application, CancellationToken cancellationToken, bool retryClosed = false)
    {
        RunningApplicationProcess[] missing;
        lock (this.stateGate)
        {
            if (selection.Activated && this.selected != selection) return;
            selection.Pending++;
            selection.Attempted.IntersectWith(application.Processes!.Select(RunningApplicationGroups.Identity));
            if (retryClosed)
                selection.Attempted.IntersectWith(selection.Attachments.Select(attachment => RunningApplicationGroups.Identity(attachment.Application)));
            missing = application.Processes!.Where(process => !selection.Attempted.Contains(RunningApplicationGroups.Identity(process))).ToArray();
        }

        Task<AttachmentResult>[] tasks = missing.Select(process => this.AttachAsync(process, cancellationToken)).ToArray();
        try
        {
            AttachmentResult[] results = await Task.WhenAll(tasks).ConfigureAwait(false);
            lock (this.stateGate)
            {
                selection.Application = application;
                selection.Attachments.RemoveWhere(attachment => attachment.Ended);
                List<string> failures = [];
                foreach (AttachmentResult result in results)
                {
                    if (result.Attachment is { Ended: false } attachment)
                    {
                        selection.Attachments.Add(attachment);
                        selection.Attempted.Add(RunningApplicationGroups.Identity(attachment.Application));
                    }
                    else
                    {
                        failures.Add(result.Error ?? $"PID {result.Attachment!.Application.ProcessId}'s diagnostic connection closed.");
                    }
                }
                foreach (RunningApplicationProcess process in application.Processes!)
                    if (selection.Attempted.Contains(RunningApplicationGroups.Identity(process)) &&
                        !selection.Attachments.Any(attachment => attachment.Application.ProcessId == process.ProcessId &&
                            attachment.Application.StartedAtTicks == process.StartedAtTicks))
                        failures.Add($"PID {process.ProcessId}'s diagnostic connection closed. Retry the app to reconnect.");
                selection.Error = failures.Count == 0 ? null : string.Join(" ", failures);
            }
            cancellationToken.ThrowIfCancellationRequested();
        }
        catch
        {
            Attachment[] unowned;
            lock (this.stateGate)
                unowned = tasks.Where(task => task.IsCompletedSuccessfully).Select(task => task.Result.Attachment)
                    .OfType<Attachment>().Where(attachment => !selection.Attachments.Contains(attachment)).ToArray();
            await Task.WhenAll(unowned.Select(StopAsync)).ConfigureAwait(false);
            throw;
        }
        finally
        {
            lock (this.stateGate)
            {
                selection.Pending--;
                if (this.selected == selection && selection.Attachments.Count == 0 && selection.Pending == 0)
                {
                    this.selected = null;
                    this.error = selection.Error ?? "The application exited or its diagnostic connection closed. Select an application to continue.";
                }
            }
        }
    }

    private async Task<AttachmentResult> AttachAsync(RunningApplicationProcess application, CancellationToken cancellationToken)
    {
        Attachment? candidate = null;
        try
        {
            if (!IsCurrent(application))
                return new(null, $"PID {application.ProcessId} exited or its process identity changed.");
            using CancellationTokenSource timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(AttachTimeout);
            EventPipeProvider provider = new(LoggingProvider, EventLevel.Verbose, keywords: 4,
                arguments: new Dictionary<string, string> { ["FilterSpecs"] = "*:Trace" });
            EventPipeSession session = await new DiagnosticsClient(application.ProcessId)
                .StartEventPipeSessionAsync(provider, requestRundown: false, circularBufferMB: 16, timeout.Token).ConfigureAwait(false);
            try
            {
                candidate = new Attachment(application, session);
            }
            catch
            {
                session.Dispose();
                throw;
            }
            Attachment attached = candidate;
            attached.Source.Dynamic.All += data => this.Record(attached, data);
            attached.Processing = Task.Factory.StartNew(() => this.Process(attached), CancellationToken.None,
                TaskCreationOptions.LongRunning, TaskScheduler.Default);
            if (!IsCurrent(application))
                return new(null, $"PID {application.ProcessId} exited or its process identity changed.");
            lock (this.stateGate)
            {
                if (attached.Ended) return new(null, $"PID {application.ProcessId}'s diagnostic connection closed.");
                candidate = null;
                return new(attached, null);
            }
        }
        catch (OperationCanceledException)
        {
            return new(null, $"Attaching to PID {application.ProcessId} timed out or was cancelled. Check that the application is responding.");
        }
        catch (Exception exception) when (IsDiagnosticFailure(exception))
        {
            return new(null, $"Could not attach to PID {application.ProcessId}. Check that diagnostics are enabled and you have permission.");
        }
        finally
        {
            if (candidate is not null) await StopAsync(candidate).ConfigureAwait(false);
        }
    }

    private static bool IsCurrent(RunningApplicationProcess application)
    {
        try
        {
            using Process process = System.Diagnostics.Process.GetProcessById(application.ProcessId);
            return !process.HasExited && process.StartTime.ToUniversalTime().Ticks == application.StartedAtTicks;
        }
        catch (Exception exception) when (IsDiagnosticFailure(exception) || exception is ArgumentException)
        {
            return false;
        }
    }

    private async Task MonitorAsync()
    {
        while (!this.shutdown.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(2), this.shutdown.Token).ConfigureAwait(false);
                await this.selectionGate.WaitAsync(this.shutdown.Token).ConfigureAwait(false);
                try
                {
                    Selection? selection;
                    lock (this.stateGate) selection = this.selected;
                    if (selection is not { IncludeRelated: true }) continue;
                    RunningApplication[] applications = this.Discover();
                    RunningApplication? application = applications.FirstOrDefault(app => app.GroupId == selection.Application.GroupId);
                    if (application is null)
                    {
                        lock (this.stateGate)
                            application = applications.FirstOrDefault(app => app.Processes!.Any(process =>
                                selection.Attachments.Any(attachment => attachment.Application.ProcessId == process.ProcessId &&
                                    attachment.Application.StartedAtTicks == process.StartedAtTicks)));
                    }
                    if (application is not null)
                        await this.AddProcessesAsync(selection, application, this.shutdown.Token).ConfigureAwait(false);
                }
                finally
                {
                    this.selectionGate.Release();
                }
            }
            catch (OperationCanceledException) when (this.shutdown.IsCancellationRequested)
            {
                return;
            }
            catch (Exception exception) when (IsDiagnosticFailure(exception))
            {
                lock (this.stateGate) this.error = "Could not refresh the selected application's processes. Check diagnostic permissions.";
            }
        }
    }

    private async Task StopSelectionAsync(Selection selection)
    {
        Attachment[] attachments;
        lock (this.stateGate)
        {
            attachments = selection.Attachments.Where(attachment =>
                this.selected is not Selection active || active == selection || !active.Attachments.Contains(attachment)).ToArray();
            selection.Attachments.Clear();
        }
        await Task.WhenAll(attachments.Select(StopAsync)).ConfigureAwait(false);
    }

    private SelectionException Fail(string message, Exception? innerException = null)
    {
        lock (this.stateGate)
        {
            this.error = message;
        }

        return new SelectionException(message, innerException);
    }

    private void Record(Attachment attachment, TraceEvent data)
    {
        if (data.ProviderName != LoggingProvider || data.EventName != "FormattedMessage")
        {
            return;
        }

        int level = Convert.ToInt32(data.PayloadByName("Level"), CultureInfo.InvariantCulture);
        LogSeverity? severity = level switch
        {
            0 => LogSeverity.Trace,
            1 => LogSeverity.Debug,
            2 => LogSeverity.Information,
            3 => LogSeverity.Warning,
            4 => LogSeverity.Error,
            5 => LogSeverity.Critical,
            _ => null,
        };
        if (severity is null || data.PayloadByName("FormattedMessage") is not string message)
        {
            return;
        }

        string? category = data.PayloadByName("LoggerName") as string;
        if (category?.Length > 512)
        {
            category = category[..512];
        }

        lock (this.stateGate)
        {
            if (this.selected is Selection selection && selection.Attachments.Contains(attachment) && !this.shutdown.IsCancellationRequested)
            {
                this.Viewer!.Record(selection.IncludeRelated ? $"[PID {attachment.Application.ProcessId}] {message}" : message,
                    severity: severity, category: category);
            }
        }
    }

    private void Process(Attachment attachment)
    {
        try
        {
            attachment.Source.Process();
        }
        catch (Exception exception) when (IsDiagnosticFailure(exception) || exception is OperationCanceledException or FormatException)
        {
        }
        finally
        {
            lock (this.stateGate)
            {
                attachment.Ended = true;
                if (this.selected is Selection selection && selection.Attachments.Remove(attachment) &&
                    selection.Attachments.Count == 0 && selection.Pending == 0)
                {
                    this.selected = null;
                    this.error = "The application exited or its diagnostic connection closed. Select an application to continue.";
                }
            }

            try
            {
                attachment.Source.Dispose();
            }
            finally
            {
                attachment.Session.Dispose();
            }
        }
    }

    private static async Task StopAsync(Attachment attachment)
    {
        using CancellationTokenSource timeout = new(StopTimeout);
        try
        {
            if (!attachment.Processing.IsCompleted)
            {
                await attachment.Session.StopAsync(timeout.Token).WaitAsync(StopTimeout).ConfigureAwait(false);
            }

            await attachment.Processing.WaitAsync(StopTimeout).ConfigureAwait(false);
        }
        catch (Exception exception) when (IsDiagnosticFailure(exception) || exception is OperationCanceledException)
        {
            // Closing the stream unblocks a reader even when the target cannot answer StopTracing.
            try
            {
                attachment.Source.StopProcessing();
                attachment.Session.EventStream.Dispose();
            }
            catch (Exception closeException) when (IsDiagnosticFailure(closeException))
            {
            }

            try
            {
                await attachment.Processing.WaitAsync(StopTimeout).ConfigureAwait(false);
            }
            catch (Exception drainException) when (IsDiagnosticFailure(drainException) || drainException is OperationCanceledException)
            {
            }
        }
    }

    private static bool IsDiagnosticFailure(Exception exception) => exception is
        DiagnosticsClientException or IOException or UnauthorizedAccessException or InvalidOperationException or
        Win32Exception or TimeoutException or System.Security.SecurityException;

    private sealed class SelectionException(string message, Exception? innerException) : InvalidOperationException(message, innerException)
    {
    }

    private sealed class Selection(RunningApplication application, bool includeRelated)
    {
        internal RunningApplication Application { get; set; } = application;
        internal bool IncludeRelated { get; } = includeRelated;
        internal bool Activated { get; set; }
        internal int Pending { get; set; }
        internal HashSet<Attachment> Attachments { get; } = [];
        internal HashSet<string> Attempted { get; } = new(StringComparer.Ordinal);
        internal string? Error { get; set; }
        internal RunningApplication Snapshot() => this.Application with
        {
            Processes = this.Attachments.Where(attachment => !attachment.Ended).Select(attachment => attachment.Application)
                .OrderBy(process => process.ProcessId).ToArray()
        };
    }

    private sealed record AttachmentResult(Attachment? Attachment, string? Error);

    private sealed class Attachment(RunningApplicationProcess application, EventPipeSession session)
    {
        internal RunningApplicationProcess Application { get; } = application;
        internal EventPipeSession Session { get; } = session;
        internal EventPipeEventSource Source { get; } = new(session.EventStream);
        internal Task Processing { get; set; } = Task.CompletedTask;
        internal bool Ended { get; set; }
    }
}
