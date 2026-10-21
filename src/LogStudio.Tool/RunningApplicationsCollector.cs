using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Diagnostics.Tracing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Diagnostics.NETCore.Client;
using Microsoft.Diagnostics.Tracing;

namespace LogStudio.Tool;

internal sealed class RunningApplicationsCollector : IRunningApplications
{
    private const string LoggingProvider = "Microsoft-Extensions-Logging";
    private const int MaximumApplicationNameLength = 128;
    private const int MaximumCommandLineBytes = 4096;
    private static readonly TimeSpan AttachTimeout = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan StopTimeout = TimeSpan.FromSeconds(2);
    private readonly object stateGate = new();
    private readonly SemaphoreSlim selectionGate = new(1, 1);
    private readonly CancellationTokenSource shutdown = new();
    private readonly ConcurrentDictionary<(int ProcessId, long StartedAtTicks), string> applicationNames = new();
    private Attachment? selected;
    private string? error;
    private Task? disposeTask;

    internal ConsoleLogViewer? Viewer { get; set; }

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
            return new RunningApplicationsState(applications, this.selected?.Application, this.error);
        }
    }

    public async Task<RunningApplicationsState> SelectAsync(int processId, long startedAtTicks, CancellationToken cancellationToken)
    {
        using CancellationTokenSource cancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, this.shutdown.Token);
        Attachment? candidate = null;
        bool entered = false;
        try
        {
            await this.selectionGate.WaitAsync(cancellation.Token).ConfigureAwait(false);
            entered = true;
            cancellation.Token.ThrowIfCancellationRequested();
            ConsoleLogViewer viewer = this.Viewer ?? throw this.Fail("The viewer is still starting. Try again.");
            RunningApplication[] applications = this.Discover();
            RunningApplication? application = applications.FirstOrDefault(item => item.ProcessId == processId && item.StartedAtTicks == startedAtTicks);
            if (application is null)
            {
                throw this.Fail("This application exited or its process identity changed. Refresh the application list.");
            }

            lock (this.stateGate)
            {
                if (this.selected?.Application is RunningApplication current &&
                    current.ProcessId == processId && current.StartedAtTicks == startedAtTicks)
                {
                    this.error = null;
                    return new RunningApplicationsState(applications, current, null);
                }
            }

            using CancellationTokenSource attachCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellation.Token);
            attachCancellation.CancelAfter(AttachTimeout);
            EventPipeProvider provider = new(LoggingProvider, EventLevel.Verbose, keywords: 4,
                arguments: new Dictionary<string, string> { ["FilterSpecs"] = "*:Trace" });
            EventPipeSession session = await new DiagnosticsClient(processId)
                .StartEventPipeSessionAsync(provider, requestRundown: false, circularBufferMB: 16, attachCancellation.Token)
                .ConfigureAwait(false);
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
            attached.Processing = Task.Run(() => this.Process(attached));
            if (this.ReadApplication(processId)?.StartedAtTicks != startedAtTicks)
            {
                throw this.Fail("This application exited or its process identity changed. Refresh the application list.");
            }

            cancellation.Token.ThrowIfCancellationRequested();
            Attachment? previous;
            lock (this.stateGate)
            {
                previous = this.selected;
                this.selected = null;
            }

            if (previous is not null)
            {
                await StopAsync(previous).ConfigureAwait(false);
            }

            cancellation.Token.ThrowIfCancellationRequested();
            lock (this.stateGate)
            {
                if (attached.Ended)
                {
                    throw this.Fail("The application's diagnostic connection closed. Select an application to try again.");
                }
                else
                {
                    // Old callbacks cannot append after this clear, even if their IPC drain timed out.
                    viewer.ClearLogs();
                    viewer.RenameSession(application.Name);
                    this.selected = attached;
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
                    await StopAsync(candidate).ConfigureAwait(false);
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
        await this.selectionGate.WaitAsync().ConfigureAwait(false);
        try
        {
            Attachment? attachment;
            lock (this.stateGate)
            {
                attachment = this.selected;
                this.selected = null;
            }

            if (attachment is not null)
            {
                await StopAsync(attachment).ConfigureAwait(false);
            }
        }
        finally
        {
            this.selectionGate.Release();
        }
    }

    private RunningApplication[] Discover()
    {
        RunningApplication[] applications = DiagnosticsClient.GetPublishedProcesses()
            .Where(processId => processId != Environment.ProcessId)
            .Select(this.ReadApplication)
            .OfType<RunningApplication>()
            .OrderBy(application => application.Name, StringComparer.OrdinalIgnoreCase)
            .ThenBy(application => application.ProcessId)
            .ToArray();
        HashSet<(int ProcessId, long StartedAtTicks)> identities = applications
            .Select(application => (application.ProcessId, application.StartedAtTicks)).ToHashSet();
        foreach ((int processId, long startedAtTicks) in this.applicationNames.Keys)
        {
            if (!identities.Contains((processId, startedAtTicks)))
            {
                this.applicationNames.TryRemove((processId, startedAtTicks), out _);
            }
        }

        return applications;
    }

    private RunningApplication? ReadApplication(int processId)
    {
        try
        {
            using Process process = System.Diagnostics.Process.GetProcessById(processId);
            long startedAtTicks = process.StartTime.ToUniversalTime().Ticks;
            string? executableName = Path.GetFileNameWithoutExtension(process.MainModule?.FileName);
            if (process.HasExited || string.IsNullOrWhiteSpace(executableName) || startedAtTicks <= 0)
            {
                return null;
            }

            string name = this.applicationNames.GetOrAdd((processId, startedAtTicks), _ =>
            {
                string displayName = OperatingSystem.IsLinux() && executableName == "dotnet"
                    ? ReadManagedApplicationName(processId) ?? executableName
                    : executableName;
                displayName = (string.IsNullOrWhiteSpace(displayName) ? executableName : displayName).Trim();
                return displayName.Length > MaximumApplicationNameLength ? displayName[..MaximumApplicationNameLength] : displayName;
            });
            return process.HasExited ? null : new RunningApplication(processId, name, startedAtTicks);
        }
        catch (Exception exception) when (IsDiagnosticFailure(exception) || exception is ArgumentException)
        {
            return null;
        }
    }

    private static string? ReadManagedApplicationName(int processId)
    {
        try
        {
            using FileStream commandLine = File.OpenRead($"/proc/{processId.ToString(CultureInfo.InvariantCulture)}/cmdline");
            byte[] buffer = new byte[MaximumCommandLineBytes];
            int count = commandLine.Read(buffer);
            ReadOnlySpan<byte> arguments = buffer.AsSpan(0, count);
            int offset = 0;
            ReadArgument(arguments, ref offset);
            bool first = true;
            while (offset < arguments.Length)
            {
                string argument = Encoding.UTF8.GetString(ReadArgument(arguments, ref offset));
                if (argument.Length == 0) return null;
                if (first && argument == "exec")
                {
                    first = false;
                    continue;
                }

                first = false;
                if (argument is "--runtimeconfig" or "--depsfile" or "--additionalprobingpath" or "--additional-deps" or "--fx-version" or "--roll-forward")
                {
                    if (ReadArgument(arguments, ref offset).IsEmpty) return null;
                    continue;
                }

                // Stop at the entrypoint: later application arguments may contain secrets or DLL-like values.
                return argument[0] != '-' && argument.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)
                    ? Path.GetFileNameWithoutExtension(argument)
                    : null;
            }
        }
        catch (Exception exception) when (IsDiagnosticFailure(exception))
        {
        }

        return null;
    }

    private static ReadOnlySpan<byte> ReadArgument(ReadOnlySpan<byte> arguments, ref int offset)
    {
        ReadOnlySpan<byte> remaining = arguments[offset..];
        int length = remaining.IndexOf((byte)0);
        if (length < 0)
        {
            offset = arguments.Length;
            return default;
        }

        offset += length + 1;
        return remaining[..length];
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
            if (this.selected == attachment && !this.shutdown.IsCancellationRequested)
            {
                this.Viewer!.Record(message, severity: severity, category: category);
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
                if (this.selected == attachment)
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

    private sealed class Attachment(RunningApplication application, EventPipeSession session)
    {
        internal RunningApplication Application { get; } = application;
        internal EventPipeSession Session { get; } = session;
        internal EventPipeEventSource Source { get; } = new(session.EventStream);
        internal Task Processing { get; set; } = Task.CompletedTask;
        internal bool Ended { get; set; }
    }
}
