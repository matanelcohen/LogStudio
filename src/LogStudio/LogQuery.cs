using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;

namespace LogStudio;

internal sealed record SearchTerm(string Field, string Value, bool Excluded);

internal sealed record LogSearchResult(
    LogEntry[] Entries,
    ViewerStatus Status,
    long MatchCount,
    long ErrorCount,
    long WarningCount,
    long OlderCount,
    long NewerCount,
    string?[] Categories,
    string[] HighlightTerms,
    int PageSize)
{
    public string SessionId { get; init; } = string.Empty;
}

internal sealed class LogQuery
{
    private static readonly string[] SeverityNames = Enum.GetValues<LogSeverity>()
        .Select(value => JsonNamingPolicy.CamelCase.ConvertName(value.ToString())).ToArray();
    private static readonly string[] StreamNames = Enum.GetValues<LogStream>()
        .Select(value => JsonNamingPolicy.CamelCase.ConvertName(value.ToString())).ToArray();
    private readonly SearchTerm[] terms;
    private readonly StringComparison comparison;
    private readonly LogStream? stream;
    private readonly LogSeverity? severity;
    private readonly LogSeverity? minimumSeverity;
    private readonly HashSet<LogSeverity>? levels;
    private readonly bool hasCategory;
    private readonly string? category;
    private readonly DateTimeOffset? since;
    private readonly DateTimeOffset? until;
    private readonly CompiledLogCondition[] conditions;
    private readonly bool includeAny;

    private LogQuery(NameValueCollection parameters)
    {
        string? pageSize = parameters[ViewerConstants.PageSizeQuery];
        this.PageSize = ViewerConstants.PageSize;
        if (pageSize is not null)
        {
            if (!int.TryParse(pageSize, NumberStyles.None, CultureInfo.InvariantCulture, out int size) ||
                size < 1 || size > ViewerConstants.MaximumPageSize)
                throw new ArgumentException($"pageSize must be between 1 and {ViewerConstants.MaximumPageSize}.");
            this.PageSize = size;
        }
        this.terms = ParseTerms(parameters[ViewerConstants.SearchQuery] ?? string.Empty);
        bool matchCase = ReadBoolean(parameters[ViewerConstants.MatchCaseQuery]);
        this.comparison = matchCase ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase;
        string? mode = parameters[ViewerConstants.IncludeModeQuery];
        if (mode is not (null or ViewerConstants.IncludeAllMode or ViewerConstants.IncludeAnyMode))
            throw new ArgumentException("includeMode must be all or any.");
        this.includeAny = mode == ViewerConstants.IncludeAnyMode;
        string? filters = parameters[ViewerConstants.ConditionsQuery];
        if (filters is null)
        {
            this.conditions = Array.Empty<CompiledLogCondition>();
        }
        else
        {
            if (filters.Length > ViewerConstants.MaximumConditionsJsonLength) throw new ArgumentException("Conditions are limited to 4096 JSON characters.");
            LogCondition[] parsed;
            try
            {
                parsed = JsonSerializer.Deserialize<LogCondition[]>(filters, ViewerConstants.JsonOptions) ??
                    throw new ArgumentException("filters must be an array of conditions.");
            }
            catch (JsonException exception)
            {
                throw new ArgumentException("filters must be a valid JSON array of conditions.", exception);
            }

            if (parsed.Length > ViewerConstants.MaximumConditions) throw new ArgumentException("Use no more than 16 conditions.");
            this.conditions = parsed.Select(condition => new CompiledLogCondition(
                condition ?? throw new ArgumentException("Conditions must not contain null entries."), matchCase)).ToArray();
        }
        this.stream = ReadEnum<LogStream>(parameters[ViewerConstants.StreamQuery], ViewerConstants.StreamQuery);
        string? levels = parameters[ViewerConstants.LevelsQuery];
        if (levels is not null)
        {
            string[] selected;
            try
            {
                selected = JsonSerializer.Deserialize<string[]>(levels) ?? throw new ArgumentException("levels must be an array of level names.");
            }
            catch (JsonException exception)
            {
                throw new ArgumentException("levels must be a JSON array of level names.", exception);
            }

            if (selected.Length > Enum.GetValues<LogSeverity>().Length) throw new ArgumentException("Too many selected levels.");
            this.levels = new HashSet<LogSeverity>();
            foreach (string value in selected)
            {
                LogSeverity? parsed = ReadEnum<LogSeverity>(value, ViewerConstants.LevelsQuery);
                if (!parsed.HasValue) throw new ArgumentException("Each selected level must be a supported level name.");
                this.levels.Add(parsed.Value);
            }
        }
        string? level = parameters[ViewerConstants.SeverityQuery];
        this.minimumSeverity = level == ViewerConstants.WarningPlusFilter ? LogSeverity.Warning :
            level == ViewerConstants.ErrorPlusFilter ? LogSeverity.Error : null;
        this.severity = this.minimumSeverity.HasValue ? null : ReadEnum<LogSeverity>(level, ViewerConstants.SeverityQuery);
        string? category = parameters[ViewerConstants.CategoryQuery];
        this.hasCategory = category is not null;
        if (this.hasCategory)
        {
            try
            {
                this.category = JsonSerializer.Deserialize<string?>(category!);
            }
            catch (JsonException exception)
            {
                throw new ArgumentException("category must be a JSON string or null.", exception);
            }

            if (this.category?.Length > ViewerConstants.MaximumCategoryLength) throw new ArgumentException("Category is too long.");
        }

        string? since = parameters[ViewerConstants.SinceQuery];
        if (since is not null)
        {
            if (!DateTimeOffset.TryParse(since, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset timestamp))
                throw new ArgumentException("since must be a valid timestamp.");
            this.since = timestamp;
        }
        string? until = parameters[ViewerConstants.UntilQuery];
        if (until is not null)
        {
            if (!DateTimeOffset.TryParse(until, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTimeOffset timestamp))
                throw new ArgumentException("until must be a valid timestamp.");
            this.until = timestamp;
        }
        if (this.since > this.until) throw new ArgumentException("since must be at or before until.");

        this.MinimumId = ReadId(parameters, ViewerConstants.MinimumIdQuery) ?? 0;
        this.MaximumId = ReadId(parameters, ViewerConstants.MaximumIdQuery);
        this.Before = ReadId(parameters, ViewerConstants.BeforeQuery);
        this.After = ReadId(parameters, ViewerConstants.AfterQuery);
        if (this.Before.HasValue && this.After.HasValue) throw new ArgumentException("Use either before or after for paging, not both.");
    }

    internal long MinimumId { get; }

    internal int PageSize { get; }

    internal long? MaximumId { get; }

    internal long? Before { get; }

    internal long? After { get; }

    internal static LogQuery Parse(NameValueCollection parameters) => new(parameters);

    internal bool Matches(LogEntry entry)
    {
        if (entry.Id <= this.MinimumId || (this.MaximumId.HasValue && entry.Id > this.MaximumId.Value) ||
            (this.levels is not null && !this.levels.Contains(entry.Severity)) ||
            (this.stream.HasValue && entry.Stream != this.stream.Value) ||
            (this.severity.HasValue && entry.Severity != this.severity.Value) ||
            (this.minimumSeverity.HasValue && entry.Severity < this.minimumSeverity.Value) ||
            (this.hasCategory && !string.Equals(entry.Category, this.category, StringComparison.Ordinal)) ||
            (this.since.HasValue && entry.Timestamp < this.since.Value) ||
            (this.until.HasValue && entry.Timestamp > this.until.Value))
            return false;

        string? allText = null;
        foreach (SearchTerm term in this.terms)
        {
            bool found;
            if (term.Field == ViewerConstants.IdField)
            {
                found = entry.Id.ToString(CultureInfo.InvariantCulture) == term.Value;
            }
            else
            {
                string text = term.Field.Length > 0 ? FieldValue(entry, term.Field) :
                    (allText ??= $"{entry.Message}\n{entry.Category}\n{SeverityNames[(int)entry.Severity]}\n{StreamNames[(int)entry.Stream]}\n{entry.Id.ToString(CultureInfo.InvariantCulture)}");
                found = text.Contains(term.Value, this.comparison);
            }

            if (term.Excluded ? found : !found) return false;
        }

        bool hasIncludes = false;
        bool included = !this.includeAny;
        foreach (CompiledLogCondition condition in this.conditions)
        {
            bool found = condition.Matches(FieldValue(entry, condition.Condition.Field));
            if (condition.Condition.Mode == ViewerConstants.ExcludeConditionMode)
            {
                if (found) return false;
            }
            else
            {
                hasIncludes = true;
                included = this.includeAny ? included || found : included && found;
            }
        }

        return !hasIncludes || included;
    }

    internal LogSearchResult Search(LogHistoryReader history, CancellationToken cancellationToken)
    {
        if (this.levels?.Count == 0)
            return this.Result(Array.Empty<LogEntry>(), history.Status, 0, 0, 0, 0, 0, history.Categories);
        if (this.levels is null && this.terms.Length == 0 && this.conditions.Length == 0 && !this.stream.HasValue && !this.severity.HasValue &&
            !this.minimumSeverity.HasValue && !this.hasCategory && !this.since.HasValue && !this.until.HasValue &&
            this.MinimumId == 0 && !this.MaximumId.HasValue && history.Status.EvictedCount == 0)
            return this.ReadUnfilteredPage(history, cancellationToken);

        Queue<LogEntry> page = new();
        long matches = 0;
        long errors = 0;
        long warnings = 0;
        long selectedEndOrdinal = 0;
        HashSet<string?>? retainedCategories = history.Status.EvictedCount > 0 ? new(StringComparer.Ordinal) : null;
        foreach (LogEntry entry in history.ReadEntries(cancellationToken: cancellationToken))
        {
            if (retainedCategories?.Count < ViewerConstants.MaximumCategorySuggestions) retainedCategories.Add(entry.Category);
            if (!this.Matches(entry)) continue;
            matches++;
            if (entry.Severity >= LogSeverity.Error) errors++;
            if (entry.Severity == LogSeverity.Warning) warnings++;
            bool eligible = this.After.HasValue ? entry.Id > this.After.Value : !this.Before.HasValue || entry.Id < this.Before.Value;
            if (!eligible || (this.After.HasValue && page.Count == this.PageSize)) continue;
            if (page.Count == this.PageSize) page.Dequeue();
            page.Enqueue(entry);
            selectedEndOrdinal = matches;
        }

        string?[] categories = retainedCategories?.OrderBy(value => value, StringComparer.Ordinal).ToArray() ?? history.Categories;
        return this.Result(
            page.ToArray(), history.Status, matches, errors, warnings,
            Math.Max(0, selectedEndOrdinal - page.Count),
            page.Count == 0 ? matches : matches - selectedEndOrdinal,
            categories);
    }

    private LogSearchResult ReadUnfilteredPage(LogHistoryReader history, CancellationToken cancellationToken)
    {
        ViewerStatus status = history.Status;
        long first = Math.Max(1, status.FirstId);
        long last = status.LastId;
        if (this.After.HasValue)
        {
            first = this.After.Value >= last ? last + 1 : Math.Max(first, this.After.Value + 1);
            last = Math.Min(last, first + this.PageSize - 1);
        }
        else
        {
            if (this.Before.HasValue) last = Math.Min(last, this.Before.Value - 1);
            first = Math.Max(first, last - this.PageSize + 1);
        }

        LogEntry[] page = history.ReadEntries(first, last, cancellationToken).ToArray();
        long older = page.Length == 0 ? 0 : page[0].Id - Math.Max(1, status.FirstId);
        long newer = page.Length == 0 ? status.RetainedCount : status.LastId - page[^1].Id;
        return this.Result(page, status, status.RetainedCount, status.ErrorCount, status.WarningCount, older, newer, history.Categories);
    }

    private LogSearchResult Result(LogEntry[] entries, ViewerStatus status, long matches, long errors, long warnings, long older, long newer, string?[] categories) =>
        new(entries, status, matches, errors, warnings, older, newer, categories,
            this.terms.Where(term => !term.Excluded && (term.Field.Length == 0 || term.Field == ViewerConstants.MessageField))
                .Select(term => term.Value)
                .Concat(this.conditions.Where(condition => condition.Condition.Mode == ViewerConstants.IncludeConditionMode &&
                    condition.Condition.Field == ViewerConstants.MessageField && condition.Condition.Operator != ViewerConstants.RegexOperator)
                    .Select(condition => condition.Condition.Value)).ToArray(),
            this.PageSize);

    private static string FieldValue(LogEntry entry, string field) => field switch
    {
        ViewerConstants.MessageField => entry.Message,
        ViewerConstants.CategoryField => entry.Category ?? string.Empty,
        ViewerConstants.LevelField => SeverityNames[(int)entry.Severity],
        ViewerConstants.StreamField => StreamNames[(int)entry.Stream],
        ViewerConstants.IdField => entry.Id.ToString(CultureInfo.InvariantCulture),
        _ => throw new InvalidOperationException("The search field was not validated."),
    };

    private static SearchTerm[] ParseTerms(string search)
    {
        if (search.Length > ViewerConstants.MaximumSearchLength) throw new ArgumentException("Search is limited to 1024 characters.");
        List<string> tokens = new();
        StringBuilder token = new();
        bool quoted = false;
        for (int index = 0; index < search.Length; index++)
        {
            char character = search[index];
            if (quoted && character == '\\' && index + 1 < search.Length && search[index + 1] is '"' or '\\')
                token.Append(search[++index]);
            else if (character == '"')
                quoted = !quoted;
            else if (char.IsWhiteSpace(character) && !quoted)
            {
                if (token.Length > 0) tokens.Add(token.ToString());
                token.Clear();
            }
            else
                token.Append(character);
        }

        if (quoted) throw new ArgumentException("Close the quotation mark to finish the search phrase.");
        if (token.Length > 0) tokens.Add(token.ToString());
        if (tokens.Count > ViewerConstants.MaximumSearchTerms) throw new ArgumentException("Use no more than 64 search terms.");
        List<SearchTerm> terms = new();
        foreach (string raw in tokens)
        {
            bool excluded = raw.Length > 1 && raw[0] == '-';
            string value = excluded ? raw[1..] : raw;
            string field = string.Empty;
            int separator = value.IndexOf(':');
            if (separator >= 0)
            {
                string candidate = value[..separator].ToLowerInvariant();
                if (candidate is ViewerConstants.MessageField or ViewerConstants.CategoryField or ViewerConstants.LevelField or ViewerConstants.StreamField or ViewerConstants.IdField)
                {
                    field = candidate;
                    value = value[(separator + 1)..];
                    if (value.Length == 0) throw new ArgumentException($"Enter a value after {field}:");
                }
            }

            terms.Add(new SearchTerm(field, value, excluded));
        }

        return terms.ToArray();
    }

    private static long? ReadId(NameValueCollection parameters, string name)
    {
        string? value = parameters[name];
        if (value is null) return null;
        if (!long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out long id)) throw new ArgumentException($"{name} must be a non-negative integer.");
        return id;
    }

    private static bool ReadBoolean(string? value)
    {
        if (value is null) return false;
        if (!bool.TryParse(value, out bool result)) throw new ArgumentException("matchCase must be true or false.");
        return result;
    }

    private static T? ReadEnum<T>(string? value, string name) where T : struct, Enum
    {
        if (value is null or ViewerConstants.AllFilter) return null;
        if (!Enum.TryParse(value, true, out T result) || !Enum.IsDefined(result) ||
            !string.Equals(value, result.ToString(), StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException($"{name} is not a supported value.");
        return result;
    }
}
