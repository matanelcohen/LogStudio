using System;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace LogStudio;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record ComparisonRequest(
    [property: JsonRequired] string BaselineId,
    [property: JsonRequired] string CandidateId,
    [property: JsonRequired] string Grouping,
    [property: JsonRequired] string FilterScope);

internal sealed record ComparisonSide(
    SessionInfo Session, SessionFilters? Filters, long MatchedCount, long TotalEntries, double? DurationMilliseconds);

internal sealed record ComparisonSnapshot(
    string Id, string State, string Phase, long ProcessedEntries, long TotalEntries, string? Error,
    ComparisonSide Baseline, ComparisonSide Candidate, string Grouping, string NormalizationRule);

internal sealed record ComparisonGroup(
    string Id, string Kind, string Label, string? Severity, string? Category,
    long BaselineCount, long CandidateCount, long Delta, string Change);

internal sealed record ComparisonGroups(ComparisonGroup[] Groups, long Total, long Offset, int PageSize = 50);
internal sealed record ComparisonEvidence(string SessionId, LogEntry[] Entries, long? NextAfter);

internal sealed record ComparisonLimits(
    int MaximumJobs = 4, int MaximumWorkers = 2, int ChunkRows = 1024, int ChunkBytes = 2 * 1024 * 1024,
    int MergeFanIn = 16, long MaximumWrittenBytes = 256L * 1024 * 1024,
    TimeSpan? Lifetime = null, TimeSpan? Timeout = null);

internal sealed class ComparisonUnavailableException(string message) : Exception(message);
internal sealed class ComparisonCapacityException(string message) : Exception(message);

internal static class ComparisonSignatures
{
    internal const string Rule = "v1: replace ISO-8601 timestamps, GUIDs, hexadecimal literals and decimal numeric tokens " +
        "with <timestamp>, <guid>, <hex> and <number>; preserve case, whitespace, severity and category (including null versus empty).";

    private static readonly Regex Tokens = new(
        @"\b(?:(?<timestamp>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))|" +
        @"(?<guid>[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})|" +
        @"(?<hex>0[xX][0-9a-fA-F]+)|(?<number>\d+(?:\.\d+)?))\b",
        RegexOptions.CultureInvariant | RegexOptions.NonBacktracking, TimeSpan.FromMilliseconds(250));

    internal static string Normalize(string message) => Tokens.Replace(message, match =>
        match.Groups["timestamp"].Success ? "<timestamp>" : match.Groups["guid"].Success ? "<guid>" :
        match.Groups["hex"].Success ? "<hex>" : "<number>");
}
