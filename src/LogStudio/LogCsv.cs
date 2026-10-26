using System;
using System.Globalization;
using System.Linq;
using System.Text.Json;

namespace LogStudio;

internal static class LogCsv
{
    internal const string Header = "id,timestamp,stream,severity,category,message,isPartial";

    internal static string Record(LogEntry entry) => string.Join(",", new[]
    {
        entry.Id.ToString(CultureInfo.InvariantCulture),
        entry.Timestamp.ToString("O", CultureInfo.InvariantCulture),
        JsonNamingPolicy.CamelCase.ConvertName(entry.Stream.ToString()),
        JsonNamingPolicy.CamelCase.ConvertName(entry.Severity.ToString()),
        entry.Category ?? string.Empty,
        entry.Message,
        entry.IsPartial ? "true" : "false",
    }.Select(Cell));

    private static string Cell(string value)
    {
        // Quoting alone does not prevent spreadsheets from evaluating formulas.
        ReadOnlySpan<char> trimmed = value.AsSpan().TrimStart();
        if ((!trimmed.IsEmpty && trimmed[0] is '=' or '+' or '-' or '@') ||
            (value.Length > 0 && value[0] is '\t' or '\r' or '\n'))
            value = "'" + value;
        return "\"" + value.Replace("\"", "\"\"", StringComparison.Ordinal) + "\"";
    }
}
