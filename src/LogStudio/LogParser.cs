using System;
using System.Text;
using System.Text.Json;

namespace LogStudio;

internal sealed class LogParser
{
    private const int MaximumTimestampPrefixLength = 72;
    private const char Escape = '\u001b';
    private const char Bell = '\u0007';

    private static readonly (string Prefix, LogSeverity Severity)[] DotnetPrefixes =
    {
        ("trce: ", LogSeverity.Trace),
        ("dbug: ", LogSeverity.Debug),
        ("info: ", LogSeverity.Information),
        ("warn: ", LogSeverity.Warning),
        ("fail: ", LogSeverity.Error),
        ("crit: ", LogSeverity.Critical),
    };

    private static readonly (string Prefix, LogSeverity Severity)[] BracketPrefixes =
    {
        ("[VRB]", LogSeverity.Trace),
        ("[TRC]", LogSeverity.Trace),
        ("[DBG]", LogSeverity.Debug),
        ("[INF]", LogSeverity.Information),
        ("[WRN]", LogSeverity.Warning),
        ("[ERR]", LogSeverity.Error),
        ("[FTL]", LogSeverity.Critical),
        ("[TRACE]", LogSeverity.Trace),
        ("[DEBUG]", LogSeverity.Debug),
        ("[INFO]", LogSeverity.Information),
        ("[WARN]", LogSeverity.Warning),
        ("[ERROR]", LogSeverity.Error),
        ("[CRITICAL]", LogSeverity.Critical),
    };

    private LogSeverity? previousSeverity;
    private string? previousCategory;

    internal (LogSeverity Severity, string? Category) Parse(string message, LogStream stream)
    {
        string trimmed = message.TrimStart();
        foreach ((string prefix, LogSeverity severity) in DotnetPrefixes)
        {
            int position = message.IndexOf(prefix, StringComparison.OrdinalIgnoreCase);
            if (position < 0 || !IsTimestampPrefix(message.AsSpan(0, position)))
            {
                continue;
            }

            string remainder = message[(position + prefix.Length)..];
            int bracket = remainder.IndexOf('[');
            int closingBracket = bracket >= 0 ? remainder.IndexOf(']', bracket) : -1;
            string? category = bracket > 0 && closingBracket > bracket
                ? remainder[..bracket].Trim()
                : null;
            return this.SetContext(severity, category);
        }

        foreach ((string prefix, LogSeverity severity) in BracketPrefixes)
        {
            int position = message.IndexOf(prefix, StringComparison.OrdinalIgnoreCase);
            if (position >= 0 && IsTimestampPrefix(message.AsSpan(0, position)))
            {
                return this.SetContext(severity, null);
            }
        }

        if (trimmed.StartsWith('{') && TryParseJson(trimmed, out LogSeverity jsonSeverity, out string? jsonCategory))
        {
            return this.SetContext(jsonSeverity, jsonCategory);
        }

        if (trimmed.StartsWith(ViewerConstants.FatalErrorPrefix, StringComparison.OrdinalIgnoreCase) ||
            trimmed.StartsWith(ViewerConstants.ErrorPrefix, StringComparison.OrdinalIgnoreCase) ||
            trimmed.StartsWith(ViewerConstants.ExceptionPrefix, StringComparison.Ordinal))
        {
            return this.SetContext(LogSeverity.Error, null);
        }

        if (this.previousSeverity.HasValue &&
            (message.StartsWith(ViewerConstants.IndentationPrefix, StringComparison.Ordinal) ||
             trimmed.StartsWith(ViewerConstants.StackFramePrefix, StringComparison.Ordinal)))
        {
            return (this.previousSeverity.Value, this.previousCategory);
        }

        this.previousSeverity = null;
        this.previousCategory = null;
        return (stream == LogStream.Stderr ? LogSeverity.Error :
            stream == LogStream.Viewer ? LogSeverity.Information : LogSeverity.Output, null);
    }

    internal static string StripTerminalEscapes(string value)
    {
        StringBuilder result = new(value.Length);
        for (int index = 0; index < value.Length; index++)
        {
            char character = value[index];
            if (character != Escape)
            {
                if (character >= ' ' || character == '\t')
                {
                    result.Append(character);
                }

                continue;
            }

            if (++index >= value.Length)
            {
                break;
            }

            if (value[index] == '[')
            {
                while (++index < value.Length && (value[index] < '@' || value[index] > '~'))
                {
                }
            }
            else if (value[index] == ']')
            {
                while (++index < value.Length)
                {
                    if (value[index] == Bell)
                    {
                        break;
                    }

                    if (value[index] == Escape && index + 1 < value.Length && value[index + 1] == '\\')
                    {
                        index++;
                        break;
                    }
                }
            }
        }

        return result.ToString();
    }

    private static bool IsTimestampPrefix(ReadOnlySpan<char> prefix)
    {
        if (prefix.Length > MaximumTimestampPrefixLength)
        {
            return false;
        }

        foreach (char character in prefix)
        {
            if (!char.IsDigit(character) && !char.IsWhiteSpace(character) &&
                character is not (':' or '.' or '-' or '+' or '/' or '[' or ']' or 'T' or 'Z'))
            {
                return false;
            }
        }

        return true;
    }

    private static bool TryParseJson(string message, out LogSeverity severity, out string? category)
    {
        severity = LogSeverity.Output;
        category = null;
        try
        {
            using JsonDocument document = JsonDocument.Parse(message);
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                (!root.TryGetProperty(ViewerConstants.JsonLogLevelProperty, out JsonElement level) &&
                 !root.TryGetProperty(ViewerConstants.JsonLevelProperty, out level)) ||
                level.ValueKind != JsonValueKind.String ||
                !Enum.TryParse(level.GetString(), true, out severity) ||
                !Enum.IsDefined(severity))
            {
                return false;
            }

            if ((root.TryGetProperty(ViewerConstants.JsonCategoryProperty, out JsonElement categoryElement) ||
                 root.TryGetProperty(ViewerConstants.JsonCategoryLowerProperty, out categoryElement)) &&
                categoryElement.ValueKind == JsonValueKind.String)
            {
                category = categoryElement.GetString();
            }

            return true;
        }
        catch (JsonException)
        {
            // Console output that happens to start with "{" is not necessarily JSON.
            return false;
        }
    }

    private (LogSeverity Severity, string? Category) SetContext(LogSeverity severity, string? category)
    {
        this.previousSeverity = severity;
        this.previousCategory = category?.Length > ViewerConstants.MaximumCategoryLength
            ? category[..ViewerConstants.MaximumCategoryLength]
            : category;
        return (severity, this.previousCategory);
    }
}
