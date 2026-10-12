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
        this.EnsureCurrent();
        if (this.Status.RetainedCount == 0) yield break;
        long first = Math.Max(Math.Max(1, this.Status.FirstId), firstId);
        long last = Math.Min(this.Status.LastId, lastId ?? this.Status.LastId);
        if (first > last) yield break;
        long position = this.GetPosition(first);
        this.journal.DiscardBufferedData();
        this.journal.BaseStream.Seek(position, SeekOrigin.Begin);
        for (long id = first; id <= last; id++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            yield return this.ReadEntry(id);
        }
    }

    private LogEntry ReadEntry(long id)
    {
        this.EnsureCurrent();
        try
        {
            string line = this.journal.ReadLine() ?? throw new InvalidDataException($"The temporary journal is missing entry {id}.");
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
