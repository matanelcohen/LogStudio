using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace LogStudio;

internal sealed class LogBuffer : IDisposable
{
    private const string TemporaryDirectoryPrefix = "logstudio-";
    private const string JournalFileName = "entries.jsonl";
    private const string IndexFileName = "entries.idx";
    private const UnixFileMode DirectoryPermissions = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;
    private const UnixFileMode FilePermissions = UnixFileMode.UserRead | UnixFileMode.UserWrite;

    private readonly object gate = new();
    private readonly FileStream journal;
    private readonly FileStream index;
    private readonly HashSet<string?> categories = new(StringComparer.Ordinal);
    private readonly LogParser[] parsers = { new(), new(), new() };
    private readonly ViewerSettings settings;
    private string applicationName;
    private readonly DateTimeOffset startedAt = DateTimeOffset.UtcNow;
    private TaskCompletionSource changed = NewSignal();
    private long lastId;
    private long clearedThroughId;
    private long generation;
    private long errorCount;
    private long warningCount;
    private int pendingEntries;
    private Exception? storageFailure;
    private bool disposed;
    private long revision;
    private bool isCompleted;
    private DateTimeOffset? completedAt;
    private int? exitCode;

    internal LogBuffer(ViewerSettings settings)
    {
        this.settings = settings;
        this.applicationName = settings.ApplicationName;
        this.StorageDirectory = Directory.CreateTempSubdirectory(TemporaryDirectoryPrefix).FullName;
        FileStream? journal = null;
        FileStream? index = null;
        bool ready = false;
        try
        {
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(this.StorageDirectory, DirectoryPermissions);
            this.journal = journal = CreateWriter(Path.Combine(this.StorageDirectory, JournalFileName));
            this.index = index = CreateWriter(Path.Combine(this.StorageDirectory, IndexFileName));
            if (settings.Input is not null) settings.Input.Changed += this.InputChanged;
            ready = true;
        }
        finally
        {
            if (!ready)
            {
                journal?.Dispose();
                index?.Dispose();
                this.DeleteFiles();
            }
        }
    }

    internal string StorageDirectory { get; }

    internal void Rename(string name)
    {
        lock (this.gate)
        {
            this.EnsureAvailable();
            this.applicationName = name;
            this.Pulse();
        }
    }

    internal void Append(string message, LogStream stream, bool isPartial = false, LogSeverity? severity = null, string? category = null)
    {
        string clean = LogParser.StripTerminalEscapes(message);
        lock (this.gate)
        {
            this.EnsureAvailable();
            (LogSeverity inferredSeverity, string? inferredCategory) = this.parsers[(int)stream].Parse(clean, stream);
            int offset = 0;
            Span<byte> position = stackalloc byte[sizeof(long)];
            do
            {
                int length = Math.Min(this.settings.MaxLineLength, clean.Length - offset);
                if (length > 0 && offset + length < clean.Length &&
                    char.IsHighSurrogate(clean[offset + length - 1]) &&
                    char.IsLowSurrogate(clean[offset + length]))
                {
                    length--;
                }

                bool split = offset + length < clean.Length;
                LogEntry entry = new(
                    this.lastId + 1,
                    DateTimeOffset.UtcNow,
                    stream,
                    severity ?? inferredSeverity,
                    category ?? inferredCategory,
                    clean.Substring(offset, length),
                    isPartial || split || offset > 0);
                byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(entry, ViewerConstants.JsonOptions);
                BinaryPrimitives.WriteInt64LittleEndian(position, this.journal.Position);
                try
                {
                    this.journal.Write(bytes);
                    this.journal.WriteByte((byte)'\n');
                    this.index.Write(position);
                    this.lastId = entry.Id;
                    this.pendingEntries++;
                    if (this.pendingEntries >= this.settings.FlushEveryEntries) this.FlushCore();
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                    this.storageFailure = exception;
                    throw;
                }

                if (this.categories.Count < ViewerConstants.MaximumCategorySuggestions) this.categories.Add(entry.Category);
                if (entry.Severity >= LogSeverity.Error) this.errorCount++;
                if (entry.Severity == LogSeverity.Warning) this.warningCount++;
                offset += length;
            }
            while (offset < clean.Length);

            this.Pulse();
        }
    }

    internal void Complete(int? code)
    {
        lock (this.gate)
        {
            this.EnsureAvailable();
            this.FlushCore();
            this.isCompleted = true;
            this.completedAt = DateTimeOffset.UtcNow;
            this.exitCode = code;
            this.Pulse();
        }
    }

    internal LogClearResult Clear()
    {
        lock (this.gate)
        {
            this.EnsureAvailable();
            long deleted = this.lastId - this.clearedThroughId;
            this.FlushCore();
            Interlocked.Increment(ref this.generation);
            try
            {
                this.journal.SetLength(0);
                this.journal.Position = 0;
                this.index.SetLength(0);
                this.index.Position = 0;
                this.journal.Flush();
                this.index.Flush();
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                this.storageFailure = exception;
                throw;
            }

            this.clearedThroughId = this.lastId;
            this.pendingEntries = 0;
            this.errorCount = 0;
            this.warningCount = 0;
            this.categories.Clear();
            for (int index = 0; index < this.parsers.Length; index++) this.parsers[index] = new LogParser();
            this.Pulse();
            return new LogClearResult(deleted, this.Status());
        }
    }

    internal void CopyJournal(string destination)
    {
        lock (this.gate)
        {
            this.EnsureAvailable();
            this.FlushCore();
            File.Copy(Path.Combine(this.StorageDirectory, JournalFileName), Path.Combine(destination, JournalFileName), true);
            File.Copy(Path.Combine(this.StorageDirectory, IndexFileName), Path.Combine(destination, IndexFileName), true);
        }
    }

    internal LogSnapshot Snapshot()
    {
        using LogHistoryReader history = this.OpenHistory();
        if (history.Status.RetainedCount > Array.MaxLength)
        {
            throw new InvalidOperationException("History is too large for a full in-memory snapshot. Use the paged search or streaming export API.");
        }

        return new LogSnapshot(history.ReadEntries().ToArray(), history.Status);
    }

    internal ViewerStatus GetStatus()
    {
        lock (this.gate)
        {
            this.EnsureAvailable();
            return this.Status();
        }
    }

    internal LogUpdate GetUpdate()
    {
        lock (this.gate)
        {
            this.EnsureAvailable();
            return new LogUpdate(this.Status(), this.changed.Task);
        }
    }

    internal LogHistoryReader OpenHistory()
    {
        lock (this.gate)
        {
            return this.OpenHistoryCore();
        }
    }

    internal LogBatch ReadAfter(long cursor)
    {
        LogHistoryReader history;
        Task changed;
        lock (this.gate)
        {
            history = this.OpenHistoryCore();
            changed = this.changed.Task;
        }

        using (history)
        {
            ViewerStatus status = history.Status;
            long first = cursor >= status.LastId ? status.LastId + 1 : Math.Max(status.FirstId, cursor + 1);
            long last = Math.Min(status.LastId, first + ViewerConstants.StreamBatchSize - 1);
            LogEntry[] entries = history.ReadEntries(first, last).ToArray();
            long missed = status.FirstId > 0 ? Math.Max(0, status.FirstId - cursor - 1) : 0;
            return new LogBatch(entries, status, changed, missed, entries.Length > 0 && entries[^1].Id < status.LastId);
        }
    }

    public void Dispose()
    {
        lock (this.gate)
        {
            if (this.disposed) return;
            this.disposed = true;
            if (this.settings.Input is not null) this.settings.Input.Changed -= this.InputChanged;
            this.changed.TrySetResult();
            try
            {
                this.journal.Dispose();
            }
            finally
            {
                try
                {
                    this.index.Dispose();
                }
                finally
                {
                    this.DeleteFiles();
                }
            }
        }
    }

    private static TaskCompletionSource NewSignal() => new(TaskCreationOptions.RunContinuationsAsynchronously);

    private static FileStream CreateWriter(string path)
    {
        FileStreamOptions options = new()
        {
            Mode = FileMode.CreateNew,
            Access = FileAccess.Write,
            Share = FileShare.ReadWrite | FileShare.Delete,
            BufferSize = ViewerConstants.DiskBufferBytes,
        };
        if (!OperatingSystem.IsWindows()) options.UnixCreateMode = FilePermissions;
        return new FileStream(path, options);
    }

    private LogHistoryReader OpenHistoryCore()
    {
        this.EnsureAvailable();
        this.FlushCore();
        long generation = Interlocked.Read(ref this.generation);
        return new LogHistoryReader(
            Path.Combine(this.StorageDirectory, JournalFileName),
            Path.Combine(this.StorageDirectory, IndexFileName),
            this.Status(),
            this.categories.OrderBy(category => category, StringComparer.Ordinal).ToArray(),
            () => Interlocked.Read(ref this.generation) == generation);
    }

    private void FlushCore()
    {
        if (this.pendingEntries == 0) return;
        try
        {
            this.journal.Flush();
            this.index.Flush();
            this.pendingEntries = 0;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            this.storageFailure = exception;
            throw;
        }
    }

    private void EnsureAvailable()
    {
        ObjectDisposedException.ThrowIf(this.disposed, this);
        if (this.storageFailure is not null) throw new IOException("The temporary log journal failed. Capture cannot continue.", this.storageFailure);
    }

    private void DeleteFiles()
    {
        File.Delete(Path.Combine(this.StorageDirectory, JournalFileName));
        File.Delete(Path.Combine(this.StorageDirectory, IndexFileName));
        Directory.Delete(this.StorageDirectory);
    }

    private ViewerStatus Status() => new(
        this.applicationName,
        this.startedAt,
        this.settings.Capacity,
        this.settings.Capacity == 0 ? this.lastId - this.clearedThroughId : Math.Min(this.lastId - this.clearedThroughId, this.settings.Capacity),
        this.lastId == this.clearedThroughId ? 0 : this.settings.Capacity == 0 ? this.clearedThroughId + 1 : Math.Max(this.clearedThroughId + 1, this.lastId - this.settings.Capacity + 1),
        this.lastId,
        this.settings.Capacity == 0 ? 0 : Math.Max(0, this.lastId - this.clearedThroughId - this.settings.Capacity),
        this.isCompleted,
        this.completedAt,
        this.exitCode,
        this.revision,
        this.errorCount,
        this.warningCount,
        this.journal.Position + this.index.Position,
        ViewerConstants.DiskBufferBytes * 2,
        this.pendingEntries,
        this.settings.FlushEveryEntries,
        this.StorageDirectory,
        this.clearedThroughId,
        this.settings.RunningApplications is not null,
        !this.isCompleted && this.settings.Input?.CanWrite == true);

    private void InputChanged()
    {
        lock (this.gate)
        {
            if (!this.disposed) this.Pulse();
        }
    }

    private void Pulse()
    {
        this.revision++;
        TaskCompletionSource previous = this.changed;
        this.changed = NewSignal();
        previous.TrySetResult();
    }
}
