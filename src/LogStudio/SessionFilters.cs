using System;
using System.Collections.Specialized;
using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace LogStudio;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record SessionFilters(
    [property: JsonRequired] string Search,
    [property: JsonRequired] bool MatchCase,
    [property: JsonRequired] string Severity,
    [property: JsonRequired] string[]? Levels,
    [property: JsonRequired] string Stream,
    [property: JsonRequired] string Category,
    [property: JsonRequired, JsonNumberHandling(JsonNumberHandling.Strict)] int TimeWindow,
    [property: JsonRequired] LogCondition[] Conditions,
    [property: JsonRequired] string IncludeMode,
    string Since = "",
    string Until = "")
{
    private static readonly JsonSerializerOptions ValidationJsonOptions = new(ViewerConstants.JsonOptions)
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    internal SessionFilters Snapshot() => this with
    {
        Levels = this.Levels is null ? null : (string[])this.Levels.Clone(),
        Conditions = (LogCondition[])this.Conditions.Clone(),
    };

    internal void Validate()
    {
        if (this.Search is null || this.Severity is null || this.Stream is null || this.Category is null || this.Conditions is null || this.Since is null || this.Until is null ||
            this.IncludeMode is not (ViewerConstants.IncludeAllMode or ViewerConstants.IncludeAnyMode))
            throw new ArgumentException("Session filters require search, matchCase, severity, levels, stream, category, timeWindow, conditions and includeMode.");
        if (this.TimeWindow is not (0 or 60_000 or 300_000 or 900_000))
            throw new ArgumentException("timeWindow must be 0, 60000, 300000 or 900000.");
        if (this.TimeWindow != 0 && (this.Since.Length > 0 || this.Until.Length > 0))
            throw new ArgumentException("Choose either a relative time window or an absolute time range.");
        if (this.Severity is not (ViewerConstants.AllFilter or ViewerConstants.WarningPlusFilter or ViewerConstants.ErrorPlusFilter) &&
            !IsEnumName<LogSeverity>(this.Severity))
            throw new ArgumentException("severity is not a supported value.");
        if (this.Stream != ViewerConstants.AllFilter && !IsEnumName<LogStream>(this.Stream))
            throw new ArgumentException("stream is not a supported value.");
        if (this.Conditions.Length > ViewerConstants.MaximumConditions)
            throw new ArgumentException("Use no more than 16 conditions.");
        if (this.Levels?.Length > Enum.GetValues<LogSeverity>().Length)
            throw new ArgumentException("Too many selected levels.");
        if (this.Levels is not null)
            foreach (string level in this.Levels)
                if (!IsEnumName<LogSeverity>(level)) throw new ArgumentException("Each selected level must be a supported level name.");

        _ = this.ToQuery();
    }

    internal LogQuery ToQuery()
    {
        NameValueCollection parameters = new()
        {
            [ViewerConstants.SearchQuery] = this.Search,
            [ViewerConstants.MatchCaseQuery] = this.MatchCase.ToString(),
            [ViewerConstants.SeverityQuery] = this.Severity,
            [ViewerConstants.StreamQuery] = this.Stream,
            [ViewerConstants.ConditionsQuery] = this.ConditionsJson(),
            [ViewerConstants.IncludeModeQuery] = this.IncludeMode,
        };
        if (this.Levels is not null) parameters[ViewerConstants.LevelsQuery] = JsonSerializer.Serialize(this.Levels);
        if (this.Category.Length > 0) parameters[ViewerConstants.CategoryQuery] = this.Category;
        if (this.Since.Length > 0) parameters[ViewerConstants.SinceQuery] = this.Since;
        if (this.Until.Length > 0) parameters[ViewerConstants.UntilQuery] = this.Until;
        return LogQuery.Parse(parameters);
    }

    private string ConditionsJson()
    {
        string json = JsonSerializer.Serialize(this.Conditions, ValidationJsonOptions);
        StringBuilder result = new(json.Length);
        for (int index = 0; index < json.Length; index++)
        {
            char character = json[index];
            if (character != '\\')
            {
                result.Append(character);
                continue;
            }
            char escaped = json[++index];
            if (escaped == 'u')
            {
                // Even the relaxed encoder escapes surrogate pairs; runtime JSON.stringify does not.
                char value = (char)ushort.Parse(json.AsSpan(index + 1, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
                if (value >= ' ' && value is not ('"' or '\\'))
                {
                    result.Append(value);
                    index += 4;
                    continue;
                }
            }
            result.Append('\\').Append(escaped);
        }
        return result.ToString();
    }

    private static bool IsEnumName<T>(string? value) where T : struct, Enum =>
        Enum.TryParse(value, true, out T parsed) && Enum.IsDefined(parsed) &&
        value == JsonNamingPolicy.CamelCase.ConvertName(parsed.ToString());
}
