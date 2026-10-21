using System;
using System.Text.Json.Serialization;

namespace LogStudio;

/// <summary>The origin of a captured entry.</summary>
public enum LogStream
{
    /// <summary>Standard output.</summary>
    Stdout,

    /// <summary>Standard error.</summary>
    Stderr,

    /// <summary>A viewer lifecycle message.</summary>
    Viewer,
}

/// <summary>Best-effort severity inferred from console text, or supplied explicitly.</summary>
public enum LogSeverity
{
    /// <summary>Unstructured standard output.</summary>
    Output,

    /// <summary>Trace logging.</summary>
    Trace,

    /// <summary>Debug logging.</summary>
    Debug,

    /// <summary>Information logging.</summary>
    Information,

    /// <summary>Warning logging.</summary>
    Warning,

    /// <summary>Error logging.</summary>
    Error,

    /// <summary>Critical logging.</summary>
    Critical,
}

/// <summary>An immutable console output entry. Timestamps represent capture time.</summary>
public sealed record LogEntry
{
    [JsonConstructor]
    internal LogEntry(long id, DateTimeOffset timestamp, LogStream stream, LogSeverity severity, string? category, string message, bool isPartial)
    {
        this.Id = id;
        this.Timestamp = timestamp;
        this.Stream = stream;
        this.Severity = severity;
        this.Category = category;
        this.Message = message;
        this.IsPartial = isPartial;
    }

    /// <summary>Gets the monotonically increasing session-local identifier.</summary>
    public long Id { get; }

    /// <summary>Gets the UTC capture timestamp.</summary>
    public DateTimeOffset Timestamp { get; }

    /// <summary>Gets the output stream.</summary>
    public LogStream Stream { get; }

    /// <summary>Gets the inferred or explicit severity.</summary>
    public LogSeverity Severity { get; }

    /// <summary>Gets the inferred or explicit logger category, when available.</summary>
    public string? Category { get; }

    /// <summary>Gets the console text with terminal escape sequences removed.</summary>
    public string Message { get; }

    /// <summary>Gets whether the entry is an unterminated or length-limited message chunk.</summary>
    public bool IsPartial { get; }
}

internal sealed record ViewerStatus(
    string ApplicationName,
    DateTimeOffset StartedAt,
    int Capacity,
    long RetainedCount,
    long FirstId,
    long LastId,
    long EvictedCount,
    bool IsCompleted,
    DateTimeOffset? CompletedAt,
    int? ExitCode,
    long Revision,
    long ErrorCount,
    long WarningCount,
    long JournalBytes,
    int IoBufferBytes,
    int PendingEntries,
    int FlushEveryEntries,
    string HistoryDirectory,
    long ClearedThroughId,
    bool ListenAll = false);

internal sealed record LogSnapshot(LogEntry[] Entries, ViewerStatus Status);

internal sealed record LogBatch(
    LogEntry[] Entries,
    ViewerStatus Status,
    System.Threading.Tasks.Task Changed,
    long MissedCount,
    bool HasMore);

internal sealed record LogUpdate(ViewerStatus Status, System.Threading.Tasks.Task Changed);

internal sealed record LogClearResult(long DeletedCount, ViewerStatus Status);
