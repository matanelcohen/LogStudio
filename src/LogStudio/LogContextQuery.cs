using System;
using System.Collections.Specialized;
using System.Globalization;
using System.Linq;
using System.Threading;

namespace LogStudio;

internal sealed record LogContextResult(
    string SessionId,
    long AnchorId,
    LogEntry[] Entries,
    long? Before,
    long? After,
    ViewerStatus Status,
    bool FiltersBypassed = true);

internal sealed class LogContextQuery
{
    private const int PageSize = 25;

    private LogContextQuery(string sessionId, long entryId, long? before, long? after)
    {
        this.SessionId = sessionId;
        this.EntryId = entryId;
        this.Before = before;
        this.After = after;
    }

    internal string SessionId { get; }
    internal long EntryId { get; }
    internal long? Before { get; }
    internal long? After { get; }

    internal static LogContextQuery Parse(NameValueCollection parameters)
    {
        if (!Guid.TryParse(parameters[ViewerConstants.SessionIdQuery], out Guid sessionId))
            throw new ArgumentException("An explicit sessionId GUID is required.");
        long entryId = ReadId(parameters, "entryId") ?? throw new ArgumentException("entryId is required.");
        long? before = ReadId(parameters, ViewerConstants.BeforeQuery);
        long? after = ReadId(parameters, ViewerConstants.AfterQuery);
        if (before.HasValue && after.HasValue)
            throw new ArgumentException("Use either before or after for context paging, not both.");
        return new LogContextQuery(sessionId.ToString("N"), entryId, before, after);
    }

    internal LogContextResult Read(LogHistoryReader history, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        history.EnsureCurrent();
        ViewerStatus status = history.Status;
        if (this.EntryId <= status.ClearedThroughId ||
            (this.EntryId <= status.LastId && this.EntryId < status.FirstId))
            throw new LogAnchorUnavailableException(true);
        if (this.EntryId > status.LastId || status.RetainedCount == 0)
            throw new LogAnchorUnavailableException(false);

        long first;
        long last;
        if (this.Before.HasValue || this.After.HasValue)
        {
            // Paging can cross the original anchor, but never outlive it.
            _ = history.ReadEntries(this.EntryId, this.EntryId, cancellationToken).Single();
            if (this.Before.HasValue)
            {
                last = Math.Min(status.LastId, this.Before.Value - 1);
                first = Math.Max(status.FirstId, last - PageSize + 1);
            }
            else if (this.After!.Value >= status.LastId)
            {
                first = 1;
                last = 0;
            }
            else
            {
                first = Math.Max(status.FirstId, this.After.Value + 1);
                last = first + Math.Min(PageSize - 1, status.LastId - first);
            }
        }
        else
        {
            first = Math.Max(status.FirstId, this.EntryId - PageSize);
            last = this.EntryId + Math.Min(PageSize, status.LastId - this.EntryId);
        }

        LogEntry[] entries = history.ReadEntries(first, last, cancellationToken).ToArray();
        history.EnsureCurrent();
        return new LogContextResult(this.SessionId, this.EntryId, entries,
            entries.Length > 0 && entries[0].Id > status.FirstId ? entries[0].Id : null,
            entries.Length > 0 && entries[^1].Id < status.LastId ? entries[^1].Id : null,
            status);
    }

    private static long? ReadId(NameValueCollection parameters, string name)
    {
        string? value = parameters[name];
        if (value is null) return null;
        if (!long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out long id) || id < 1)
            throw new ArgumentException($"{name} must be a positive entry ID.");
        return id;
    }
}

internal sealed class LogAnchorUnavailableException : Exception
{
    internal LogAnchorUnavailableException(bool expired)
        : base(expired ? "The context anchor was cleared or is no longer retained." : "The context anchor was not found.")
    {
        this.Expired = expired;
    }

    internal bool Expired { get; }
}
