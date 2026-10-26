using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text.Json;
using System.Threading;

namespace LogStudio;

internal sealed record ComparisonKey(string Kind, string Label, string? Severity, string? Category)
{
    internal static ComparisonKey For(LogEntry entry, string kind, string grouping)
    {
        string severity = JsonNamingPolicy.CamelCase.ConvertName(entry.Severity.ToString());
        return kind switch
        {
            "severity" => new(kind, severity, severity, null),
            "category" => new(kind, entry.Category ?? "(uncategorized)", null, entry.Category),
            "message" => new(kind, grouping == "raw" ? entry.Message : ComparisonSignatures.Normalize(entry.Message), severity, entry.Category),
            _ => throw new ArgumentException("kind must be severity, category or message."),
        };
    }

    internal bool Matches(ComparisonGroup group) => this.Kind == group.Kind && this.Label == group.Label &&
        this.Severity == group.Severity && this.Category == group.Category;
}

internal sealed record ComparisonRow(ComparisonKey Key, long Baseline, long Candidate);

internal sealed class ComparisonSort : IDisposable
{
    private sealed class KeyComparer : IComparer<ComparisonKey>
    {
        public int Compare(ComparisonKey? x, ComparisonKey? y)
        {
            if (ReferenceEquals(x, y)) return 0;
            if (x is null) return -1;
            if (y is null) return 1;
            int result = StringComparer.Ordinal.Compare(x.Kind, y.Kind);
            if (result == 0) result = StringComparer.Ordinal.Compare(x.Severity, y.Severity);
            if (result == 0) result = StringComparer.Ordinal.Compare(x.Category, y.Category);
            return result == 0 ? StringComparer.Ordinal.Compare(x.Label, y.Label) : result;
        }
    }

    private static readonly KeyComparer Comparer = new();
    private readonly string directory;
    private readonly ComparisonLimits limits;
    private readonly CancellationToken cancellationToken;
    private readonly List<ComparisonRow> chunk;
    private long runCount;
    private long writtenBytes;
    private int chunkBytes;

    internal ComparisonSort(string directory, ComparisonLimits limits, CancellationToken cancellationToken)
    {
        this.directory = directory;
        this.limits = limits;
        this.cancellationToken = cancellationToken;
        this.chunk = new(limits.ChunkRows);
        Directory.CreateDirectory(this.Pass(0));
    }

    internal void Add(LogEntry entry, bool baseline, string grouping)
    {
        if (entry.Message.Length > ViewerConstants.MaximumMaxLineLength || entry.Category?.Length > ViewerConstants.MaximumCategoryLength ||
            !Enum.IsDefined(entry.Severity))
            throw new InvalidDataException("A comparison entry exceeds supported field limits or has an invalid severity.");
        foreach (string kind in new[] { "severity", "category", "message" })
        {
            this.cancellationToken.ThrowIfCancellationRequested();
            ComparisonKey key = ComparisonKey.For(entry, kind, grouping);
            // Six bytes per UTF-16 character also bounds JSON escaping, not just ordinary UTF-8 text.
            int rowBytes = checked((key.Label.Length + (key.Category?.Length ?? 0)) * 6 + 128);
            if (rowBytes > this.limits.ChunkBytes)
                throw new InvalidDataException("A comparison group exceeds its chunk byte budget; no partial results are available.");
            if (this.chunkBytes > this.limits.ChunkBytes - rowBytes) this.Flush();
            this.chunk.Add(new(key, baseline ? 1 : 0, baseline ? 0 : 1));
            this.chunkBytes += rowBytes;
            if (this.chunk.Count >= this.limits.ChunkRows || this.chunkBytes >= this.limits.ChunkBytes) this.Flush();
        }
    }

    internal void Finish()
    {
        this.Flush();
        int pass = 0;
        long runs = this.runCount;
        while (runs > 1)
        {
            this.cancellationToken.ThrowIfCancellationRequested();
            Directory.CreateDirectory(this.Pass(pass + 1));
            long nextRuns = 0;
            for (long first = 0; first < runs; first += this.limits.MergeFanIn)
            {
                this.Merge(pass, first, (int)Math.Min(this.limits.MergeFanIn, runs - first), this.Run(pass + 1, nextRuns++));
            }
            Directory.Delete(this.Pass(pass));
            runs = nextRuns;
            pass++;
        }

        using FileStream groups = CreateFile(Path.Combine(this.directory, "groups.jsonl"));
        using FileStream index = CreateFile(Path.Combine(this.directory, "groups.idx"));
        if (runs == 0)
        {
            Directory.Delete(this.Pass(0));
            return;
        }
        using (StreamReader reader = File.OpenText(this.Run(pass, 0)))
        {
            long ordinal = 0;
            ComparisonRow? row;
            Span<byte> offset = stackalloc byte[sizeof(long)];
            while ((row = ReadRow(reader)) is not null)
            {
                this.cancellationToken.ThrowIfCancellationRequested();
                string change = row.Baseline == 0 ? "new" : row.Candidate == 0 ? "resolved" :
                    row.Baseline == row.Candidate ? "unchanged" : "changed";
                ComparisonGroup group = new("g" + (++ordinal).ToString(CultureInfo.InvariantCulture), row.Key.Kind, row.Key.Label,
                    row.Key.Severity, row.Key.Category, row.Baseline, row.Candidate, checked(row.Candidate - row.Baseline), change);
                BinaryPrimitives.WriteInt64LittleEndian(offset, groups.Position);
                this.Spend(sizeof(long));
                index.Write(offset);
                this.Write(groups, group);
            }
        }
        File.Delete(this.Run(pass, 0));
        Directory.Delete(this.Pass(pass));
    }

    private void Flush()
    {
        if (this.chunk.Count == 0) return;
        this.cancellationToken.ThrowIfCancellationRequested();
        this.chunk.Sort((left, right) => Comparer.Compare(left.Key, right.Key));
        using FileStream output = CreateFile(this.Run(0, this.runCount++));
        ComparisonRow? previous = null;
        foreach (ComparisonRow row in this.chunk)
        {
            this.cancellationToken.ThrowIfCancellationRequested();
            if (previous is not null && Comparer.Compare(previous.Key, row.Key) == 0)
                previous = Combine(previous, row);
            else
            {
                if (previous is not null) this.Write(output, previous);
                previous = row;
            }
        }
        if (previous is not null) this.Write(output, previous);
        this.chunk.Clear();
        this.chunkBytes = 0;
    }

    private void Merge(int pass, long first, int count, string destination)
    {
        StreamReader?[] readers = new StreamReader[count];
        try
        {
            PriorityQueue<(ComparisonRow Row, int Reader), ComparisonKey> queue = new(Comparer);
            for (int index = 0; index < count; index++)
            {
                StreamReader reader = File.OpenText(this.Run(pass, first + index));
                readers[index] = reader;
                ComparisonRow? row = ReadRow(reader);
                if (row is not null) queue.Enqueue((row, index), row.Key);
            }
            using FileStream output = CreateFile(destination);
            ComparisonRow? previous = null;
            while (queue.TryDequeue(out var item, out _))
            {
                this.cancellationToken.ThrowIfCancellationRequested();
                ComparisonRow row = item.Row;
                if (previous is not null && Comparer.Compare(previous.Key, row.Key) == 0)
                    previous = Combine(previous, row);
                else
                {
                    if (previous is not null) this.Write(output, previous);
                    previous = row;
                }
                ComparisonRow? next = ReadRow(readers[item.Reader]!);
                if (next is not null) queue.Enqueue((next, item.Reader), next.Key);
            }
            if (previous is not null) this.Write(output, previous);
        }
        finally
        {
            foreach (StreamReader? reader in readers) reader?.Dispose();
        }
        for (int index = 0; index < count; index++) File.Delete(this.Run(pass, first + index));
    }

    private static ComparisonRow Combine(ComparisonRow left, ComparisonRow right) =>
        left with { Baseline = checked(left.Baseline + right.Baseline), Candidate = checked(left.Candidate + right.Candidate) };

    private string Pass(int pass) => Path.Combine(this.directory, "pass-" + pass.ToString(CultureInfo.InvariantCulture));
    private string Run(int pass, long run) => Path.Combine(this.Pass(pass), run.ToString(CultureInfo.InvariantCulture) + ".jsonl");
    private static ComparisonRow? ReadRow(StreamReader reader) =>
        reader.ReadLine() is { } line ? JsonSerializer.Deserialize<ComparisonRow>(line, ViewerConstants.JsonOptions) ??
            throw new InvalidDataException("A comparison sort record is invalid.") : null;

    private void Write<T>(FileStream stream, T value)
    {
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(value, ViewerConstants.JsonOptions);
        this.Spend(bytes.Length + 1);
        stream.Write(bytes);
        stream.WriteByte((byte)'\n');
    }

    private void Spend(int bytes)
    {
        this.writtenBytes = checked(this.writtenBytes + bytes);
        if (this.writtenBytes > this.limits.MaximumWrittenBytes)
            throw new IOException("Comparison exceeded its disk-work limit; no partial results were retained. Narrow the saved filters and retry.");
    }

    internal static FileStream CreateFile(string path)
    {
        FileStreamOptions options = new() { Mode = FileMode.CreateNew, Access = FileAccess.Write, BufferSize = ViewerConstants.DiskBufferBytes };
        if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        return new(path, options);
    }

    public void Dispose() => this.chunk.Clear();
}
