using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;

namespace LogStudio;

internal sealed class LogHistoryReader : IDisposable
{
    private readonly FileStream index;
    private readonly StreamReader journal;
    private readonly Func<bool> isCurrent;

    internal LogHistoryReader(string journalPath, string indexPath, ViewerStatus status, string?[] categories, Func<bool> isCurrent)
    {
        this.isCurrent = isCurrent;
        this.Status = status;
        this.Categories = categories;
        FileStream index = new(indexPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, ViewerConstants.DiskBufferBytes);
        FileStream? data = null;
        bool ready = false;
        try
        {
            data = new FileStream(journalPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, ViewerConstants.DiskBufferBytes);
            this.journal = new StreamReader(data, new UTF8Encoding(false), false, ViewerConstants.DiskBufferBytes);
            this.index = index;
            ready = true;
        }
        finally
        {
            if (!ready)
            {
                data?.Dispose();
                index.Dispose();
            }
        }
    }

    internal ViewerStatus Status { get; }

    internal string?[] Categories { get; }

    internal IEnumerable<LogEntry> ReadEntries(long firstId = 0, long? lastId = null, CancellationToken cancellationToken = default)
    {
        return this.ReadEntriesCore(Math.Max(this.Status.FirstId, firstId), lastId, cancellationToken);
    }

    internal IEnumerable<LogEntry> ReadSessionEntries(CancellationToken cancellationToken = default, int? maximumLineCharacters = null)
    {
        return this.ReadEntriesCore(this.Status.ClearedThroughId + 1, null, cancellationToken, maximumLineCharacters);
    }

    internal void EnsureCompleteSessionRead()
    {
        this.EnsureCurrent();
        if (this.index.Length != checked((this.Status.LastId - this.Status.ClearedThroughId) * sizeof(long)) ||
            this.journal.Peek() != -1)
            throw new InvalidDataException("The saved journal contains records outside its completed metadata; no partial results are available.");
        this.EnsureCurrent();
    }

    private IEnumerable<LogEntry> ReadEntriesCore(long firstId, long? lastId, CancellationToken cancellationToken, int? maximumLineCharacters = null)
    {
        this.EnsureCurrent();
        long first = Math.Max(this.Status.ClearedThroughId + 1, firstId);
        long last = Math.Min(this.Status.LastId, lastId ?? this.Status.LastId);
        if (first > last) yield break;
        long position = this.GetPosition(first);
        this.journal.DiscardBufferedData();
        this.journal.BaseStream.Seek(position, SeekOrigin.Begin);
        for (long id = first; id <= last; id++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            yield return this.ReadEntry(id, maximumLineCharacters);
        }
    }

    private LogEntry ReadEntry(long id, int? maximumLineCharacters)
    {
        this.EnsureCurrent();
        try
        {
            string line = this.ReadLine(maximumLineCharacters) ?? throw new InvalidDataException($"The temporary journal is missing entry {id}.");
            LogEntry entry = JsonSerializer.Deserialize<LogEntry>(line, ViewerConstants.JsonOptions) ??
                throw new InvalidDataException($"The temporary journal contains an invalid entry at {id}.");
            this.EnsureCurrent();
            if (entry.Id != id) throw new InvalidDataException($"The temporary journal index does not match entry {id}.");
            return entry;
        }
        catch (Exception exception) when (!this.isCurrent() && exception is IOException or JsonException)
        {
            throw new HistoryClearedException(exception);
        }
    }

    private string? ReadLine(int? maximumCharacters)
    {
        if (!maximumCharacters.HasValue) return this.journal.ReadLine();
        StringBuilder line = new();
        int value;
        while ((value = this.journal.Read()) >= 0)
        {
            if (value is '\r' or '\n')
            {
                if (value == '\r' && this.journal.Peek() == '\n') this.journal.Read();
                return line.ToString();
            }
            if (line.Length >= maximumCharacters.Value)
                throw new InvalidDataException("A comparison journal line exceeds its supported size; no partial results are available.");
            line.Append((char)value);
        }
        return line.Length == 0 ? null : line.ToString();
    }

    private void EnsureCurrent()
    {
        if (!this.isCurrent()) throw new HistoryClearedException();
    }

    public void Dispose()
    {
        try
        {
            this.journal.Dispose();
        }
        finally
        {
            this.index.Dispose();
        }
    }

    private long GetPosition(long id)
    {
        this.EnsureCurrent();
        try
        {
            this.index.Seek(checked((id - this.Status.ClearedThroughId - 1) * sizeof(long)), SeekOrigin.Begin);
            Span<byte> bytes = stackalloc byte[sizeof(long)];
            this.index.ReadExactly(bytes);
            long position = BinaryPrimitives.ReadInt64LittleEndian(bytes);
            this.EnsureCurrent();
            if (position < 0 || position >= this.journal.BaseStream.Length) throw new InvalidDataException("The temporary journal contains an invalid seek offset.");
            return position;
        }
        catch (IOException exception) when (!this.isCurrent())
        {
            throw new HistoryClearedException(exception);
        }
    }
}

internal sealed class HistoryClearedException : IOException
{
    internal HistoryClearedException(Exception? innerException = null)
        : base("Session history was cleared during this request. Retry using the current history.", innerException)
    {
    }
}
