using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace LogStudio;

/// <summary>Hosts an opt-in browser viewer without replacing the application's logging configuration.</summary>
public sealed class ConsoleLogViewer : IDisposable, IAsyncDisposable
{
    private static readonly object ConsoleCaptureGate = new();
    private static ConsoleLogViewer? activeCapture;

    private readonly object lifecycleGate = new();
    private readonly object writersGate = new();
    private readonly List<CapturingTextWriter> writers = new();
    private readonly ViewerSettings settings;
    private readonly LogBuffer logs;
    private readonly HttpLogServer server;
    private readonly TelemetryRecorder telemetry;
    private readonly SessionCatalog sessions;
    private readonly TextWriter originalOut;
    private readonly TextWriter originalError;
    private readonly CancellationTokenSource shutdown = new();
    private readonly Task flushTask;
    private TextWriter? installedOut;
    private TextWriter? installedError;
    private Task? disposeTask;

    private ConsoleLogViewer(ViewerSettings settings)
    {
        this.settings = settings;
        this.originalOut = Console.Out;
        this.originalError = Console.Error;
        this.logs = new LogBuffer(settings);
        bool started = false;
        try
        {
            this.sessions = new SessionCatalog(settings);
            this.telemetry = new TelemetryRecorder(settings);
            this.server = new HttpLogServer(settings, this.logs, this.originalError, this.ClearCore, this.sessions, this.RenameCore,
                telemetry: this.telemetry);
            this.flushTask = this.FlushIdleAsync();
            started = true;
        }
        finally
        {
            if (!started)
            {
                this.telemetry?.Dispose();
                this.logs.Dispose();
                this.shutdown.Dispose();
            }
        }
    }

    /// <summary>Gets the session-specific localhost URL. Treat it as a local access credential.</summary>
    public Uri Url => this.server.Url;

    /// <summary>Gets the private temporary history directory. It is deleted when the viewer is disposed.</summary>
    public string HistoryDirectory => this.logs.StorageDirectory;

    /// <summary>Starts the viewer. Call before creating a host or logger to capture its console output.</summary>
    /// <param name="options">Optional settings. Only one viewer can own console capture at a time.</param>
    /// <returns>The viewer, which must be disposed when the application is finished.</returns>
    public static ConsoleLogViewer Start(ConsoleLogViewerOptions? options = null)
    {
        ViewerSettings settings = (options ?? new ConsoleLogViewerOptions()).Validate();
        lock (ConsoleCaptureGate)
        {
            if (settings.CaptureConsole && activeCapture is not null)
            {
                throw new InvalidOperationException("Console output is already captured. Use either a startup hook or Start(), not both.");
            }

            ConsoleLogViewer viewer = new(settings);
            try
            {
                if (settings.CaptureConsole)
                {
                    activeCapture = viewer;
                    Console.SetOut(viewer.CreateCaptureWriter(viewer.originalOut, LogStream.Stdout));
                    viewer.installedOut = Console.Out;
                    Console.SetError(viewer.CreateCaptureWriter(viewer.originalError, LogStream.Stderr));
                    viewer.installedError = Console.Error;
                }

                viewer.originalError.WriteLine($"Log Studio: {viewer.Url}");
                if (settings.OpenBrowser)
                {
                    viewer.OpenBrowser();
                }

                return viewer;
            }
            catch
            {
                viewer.Dispose();
                throw;
            }
        }
    }

    /// <summary>Creates a tee writer for a redirected process or another text source.</summary>
    /// <param name="output">The destination to mirror unchanged. It is never disposed by the viewer.</param>
    /// <param name="stream">The origin to attach to captured entries.</param>
    /// <returns>A writer owned by this viewer. Disposing it flushes any final partial line.</returns>
    public TextWriter CreateCaptureWriter(TextWriter output, LogStream stream)
    {
        ArgumentNullException.ThrowIfNull(output);
        if (!Enum.IsDefined(stream))
        {
            throw new ArgumentOutOfRangeException(nameof(stream));
        }

        lock (this.lifecycleGate)
        {
            ObjectDisposedException.ThrowIf(this.disposeTask is not null, this);
            CapturingTextWriter writer = new(output, this.logs, stream, this.settings.MaxLineLength);
            lock (this.writersGate)
            {
                this.writers.Add(writer);
            }

            return writer;
        }
    }

    /// <summary>Records one message without writing it to the terminal, preserving multiline text.</summary>
    /// <param name="message">The text to record.</param>
    /// <param name="stream">The origin of the text.</param>
    /// <param name="severity">An optional explicit severity instead of text inference.</param>
    /// <param name="category">An optional explicit logger category, up to 512 characters.</param>
    public void Record(string message, LogStream stream = LogStream.Stdout, LogSeverity? severity = null, string? category = null)
    {
        ArgumentNullException.ThrowIfNull(message);
        if (!Enum.IsDefined(stream) || (severity.HasValue && !Enum.IsDefined(severity.Value)))
        {
            throw new ArgumentOutOfRangeException(nameof(stream), "The stream and severity must be defined enum values.");
        }

        if (category?.Length > ViewerConstants.MaximumCategoryLength)
        {
            throw new ArgumentException("Category must not exceed 512 characters.", nameof(category));
        }

        lock (this.lifecycleGate)
        {
            ObjectDisposedException.ThrowIf(this.disposeTask is not null, this);
            this.logs.Append(message, stream, severity: severity, category: category);
        }
    }

    /// <summary>Gets a stable, oldest-first copy of the currently retained entries.</summary>
    /// <returns>A snapshot that materializes retained history in the caller's memory.</returns>
    /// <remarks>Use the browser's paged search or streaming export for large runs. History is deleted on disposal.</remarks>
    public IReadOnlyList<LogEntry> GetLogs() => this.logs.Snapshot().Entries;

    /// <summary>Deletes all captured session logs through this call without stopping capture.</summary>
    /// <returns>The number of entries deleted from the journal, including entries hidden by retention.</returns>
    public long ClearLogs() => this.ClearCore().DeletedCount;

    /// <summary>Changes the current session's display name without changing its identity or captured logs.</summary>
    /// <param name="name">A nonblank name containing at most 128 characters.</param>
    public void RenameSession(string name) => this.RenameCore(name);

    private SessionInfo RenameCore(string name)
    {
        name = SessionCatalog.ValidateName(name);
        lock (this.lifecycleGate)
        {
            ObjectDisposedException.ThrowIf(this.disposeTask is not null, this);
            this.logs.GetStatus();
            this.sessions.UpdateCurrentName(name);
            this.logs.Rename(name);
            return this.sessions.Describe(this.logs.GetStatus());
        }
    }

    private LogClearResult ClearCore()
    {
        lock (this.lifecycleGate)
        {
            ObjectDisposedException.ThrowIf(this.disposeTask is not null, this);
            this.FlushWriters();
            return this.logs.Clear();
        }
    }

    /// <summary>Marks the wrapped run as complete while keeping the viewer available.</summary>
    /// <param name="exitCode">The child process exit code, if known.</param>
    public void Complete(int? exitCode = null)
    {
        try
        {
            lock (this.lifecycleGate)
            {
                ObjectDisposedException.ThrowIf(this.disposeTask is not null, this);
                this.FlushWriters();
                this.logs.Complete(exitCode);
                this.sessions.Save(this.logs, closing: true);
            }
        }
        finally
        {
            this.telemetry.Dispose();
        }
    }

    /// <summary>Restores console writers, flushes partial output, and stops the local server.</summary>
    public void Dispose() => this.DisposeAsync().AsTask().GetAwaiter().GetResult();

    /// <summary>Asynchronously restores console writers and stops the local server.</summary>
    /// <returns>A task that completes when capture and all HTTP requests have stopped.</returns>
    public ValueTask DisposeAsync()
    {
        lock (this.lifecycleGate)
        {
            this.disposeTask ??= this.DisposeCoreAsync();
            return new ValueTask(this.disposeTask);
        }
    }

    private async Task FlushIdleAsync()
    {
        using PeriodicTimer timer = new(ViewerConstants.PartialLineInterval);
        try
        {
            while (await timer.WaitForNextTickAsync(this.shutdown.Token).ConfigureAwait(false))
            {
                lock (this.writersGate)
                {
                    foreach (CapturingTextWriter writer in this.writers)
                    {
                        writer.FlushIdle();
                    }
                }
            }
        }
        catch (OperationCanceledException) when (this.shutdown.IsCancellationRequested)
        {
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            this.originalError.WriteLine($"Log Studio disk capture failed: {exception}");
            throw;
        }
    }

    private void FlushWriters()
    {
        lock (this.writersGate)
        {
            foreach (CapturingTextWriter writer in this.writers)
            {
                writer.Flush();
            }
        }
    }

    private async Task DisposeCoreAsync()
    {
        this.telemetry.Dispose();
        lock (ConsoleCaptureGate)
        {
            if (ReferenceEquals(activeCapture, this))
            {
                if (ReferenceEquals(Console.Out, this.installedOut))
                {
                    Console.SetOut(this.originalOut);
                }

                if (ReferenceEquals(Console.Error, this.installedError))
                {
                    Console.SetError(this.originalError);
                }

                activeCapture = null;
            }
        }

        try
        {
            try
            {
                lock (this.writersGate)
                {
                    foreach (CapturingTextWriter writer in this.writers)
                    {
                        writer.Dispose();
                    }
                }
            }
            finally
            {
                this.shutdown.Cancel();
                try
                {
                    await this.flushTask.ConfigureAwait(false);
                }
                finally
                {
                    await this.server.DisposeAsync().ConfigureAwait(false);
                }
            }
        }
        finally
        {
            try
            {
                try
                {
                    this.sessions.Save(this.logs);
                }
                finally
                {
                    this.logs.Dispose();
                }
            }
            finally
            {
                this.shutdown.Dispose();
            }
        }
    }

    private void OpenBrowser()
    {
        try
        {
            using Process? process = Process.Start(new ProcessStartInfo(this.Url.AbsoluteUri) { UseShellExecute = true });
            if (process is null)
            {
                this.originalError.WriteLine($"The browser did not start. Open {this.Url} manually.");
            }
        }
        catch (Win32Exception exception)
        {
            this.originalError.WriteLine($"Could not open the browser: {exception.Message}. Open {this.Url} manually.");
        }
        catch (InvalidOperationException exception)
        {
            this.originalError.WriteLine($"Could not open the browser: {exception.Message}. Open {this.Url} manually.");
        }
    }
}
