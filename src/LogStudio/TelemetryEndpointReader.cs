using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace LogStudio;

internal sealed class TelemetryEndpointReader : IDisposable
{
    internal const int MaximumResponseBytes = 1048576;
    private readonly HttpClient client = new(new SocketsHttpHandler
    {
        AllowAutoRedirect = false,
        UseCookies = false,
        UseProxy = false,
        ActivityHeadersPropagator = null,
    }) { Timeout = TimeSpan.FromSeconds(3) };
    private readonly RecordKeys metricKeys = new();
    private readonly RecordKeys spanKeys = new();

    internal async Task<TelemetryMetric[]> ReadMetricsAsync(string endpoint, CancellationToken cancellationToken)
    {
        string content = await this.ReadAsync(endpoint, cancellationToken).ConfigureAwait(false);
        return ParseMetrics(content, DateTimeOffset.UtcNow);
    }

    internal async Task<TelemetrySpan[]> ReadSpansAsync(string endpoint, CancellationToken cancellationToken)
    {
        string content = await this.ReadAsync(endpoint, cancellationToken).ConfigureAwait(false);
        return ParseSpans(content);
    }

    internal bool TryAddMetric(string endpoint, TelemetryMetric metric) =>
        this.metricKeys.Add(endpoint, JsonSerializer.SerializeToUtf8Bytes(metric, ViewerConstants.JsonOptions));

    internal bool TryAddSpan(string endpoint, TelemetrySpan span) =>
        this.spanKeys.Add(endpoint, JsonSerializer.SerializeToUtf8Bytes(new[] { span.TraceId, span.SpanId }));

    private async Task<string> ReadAsync(string endpoint, CancellationToken cancellationToken)
    {
        using CancellationTokenSource timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(3));
        cancellationToken = timeout.Token;
        using HttpResponseMessage response = await this.client.GetAsync(endpoint, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"Telemetry endpoint returned HTTP {(int)response.StatusCode}.", null, response.StatusCode);
        if (response.Content.Headers.ContentLength > MaximumResponseBytes)
            throw new FormatException("Telemetry endpoint responses must not exceed 1 MiB.");
        using Stream stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        byte[] bytes = new byte[MaximumResponseBytes + 1];
        int length = 0, read;
        while (length < bytes.Length &&
            (read = await stream.ReadAsync(bytes.AsMemory(length), cancellationToken).ConfigureAwait(false)) > 0) length += read;
        if (length > MaximumResponseBytes) throw new FormatException("Telemetry endpoint responses must not exceed 1 MiB.");
        return new UTF8Encoding(false, true).GetString(bytes, 0, length);
    }

    internal static TelemetryMetric[] ParseMetrics(string content, DateTimeOffset observedAt)
    {
        if (content.TrimStart().StartsWith('{'))
        {
            using JsonDocument document = JsonDocument.Parse(content, new JsonDocumentOptions { MaxDepth = 32 });
            JsonElement root = document.RootElement;
            CheckEnabled(root);
            if (!root.TryGetProperty("metrics", out JsonElement metrics) || metrics.ValueKind != JsonValueKind.Array ||
                metrics.GetArrayLength() > TelemetryRecorder.MaximumRecordsPerInterval)
                throw new FormatException("Expected Prometheus exposition or a Log Studio metrics snapshot.");
            return metrics.EnumerateArray().Select(item => Normalize(item.Deserialize<TelemetryMetric>(ViewerConstants.JsonOptions)
                ?? throw new FormatException("Invalid metric record."))).ToArray();
        }

        List<TelemetryMetric> result = new();
        Dictionary<string, string> types = new(StringComparer.Ordinal);
        Dictionary<string, string> units = new(StringComparer.Ordinal);
        using StringReader reader = new(content);
        string? raw;
        while ((raw = reader.ReadLine()) is not null)
        {
            string line = raw.Trim();
            if (line.Length == 0) continue;
            if (line.StartsWith('#'))
            {
                string[] metadata = line.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
                if (metadata.Length == 4 && types.Count + units.Count < TelemetryRecorder.MaximumInstruments)
                {
                    if (metadata[1] == "TYPE") types[metadata[2]] = metadata[3];
                    if (metadata[1] == "UNIT") units[metadata[2]] = metadata[3];
                }
                continue;
            }
            if (result.Count == TelemetryRecorder.MaximumRecordsPerInterval)
                throw new FormatException("A telemetry endpoint response must contain at most 10000 records per signal.");
            int position = 0;
            while (position < line.Length && (char.IsAsciiLetterOrDigit(line[position]) || line[position] is '_' or ':')) position++;
            string name = line[..position];
            if (name.Length == 0 || char.IsAsciiDigit(name[0])) throw new FormatException("Invalid Prometheus metric name.");
            List<TelemetryTag> tags = new();
            if (position < line.Length && line[position] == '{') ReadLabels(line, ref position, tags);
            if (position == line.Length || !char.IsWhiteSpace(line[position])) throw new FormatException("Invalid Prometheus sample.");
            string[] values = line[position..].Split((char[]?)null, 3, StringSplitOptions.RemoveEmptyEntries);
            if (values.Length == 0 || !double.TryParse(values[0], NumberStyles.Float, CultureInfo.InvariantCulture, out double value) || !double.IsFinite(value))
                throw new FormatException("Prometheus samples must contain finite numeric values.");
            DateTimeOffset timestamp = observedAt;
            if (values.Length > 1 && values[1] != "#")
            {
                if (!long.TryParse(values[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out long milliseconds))
                    throw new FormatException("Prometheus sample timestamps must be Unix milliseconds.");
                timestamp = DateTimeOffset.FromUnixTimeMilliseconds(milliseconds);
            }
            if (values.Length == 3 && values[1] != "#" && !values[2].StartsWith('#'))
                throw new FormatException("Invalid trailing Prometheus sample data.");
            string baseName = name;
            foreach (string suffix in new[] { "_bucket", "_sum", "_count" })
                if (name.EndsWith(suffix, StringComparison.Ordinal)) { baseName = name[..^suffix.Length]; break; }
            string? unit = units.GetValueOrDefault(baseName);
            string meter = tags.FirstOrDefault(tag => tag.Key == "otel_scope_name")?.Value ?? "Prometheus";
            result.Add(new(0, timestamp, meter, Bound(name), unit is null ? null : Bound(unit),
                Bound(types.GetValueOrDefault(name) ?? types.GetValueOrDefault(baseName) ?? "PrometheusSample"), value, tags.ToArray()));
        }
        if (result.Count == 0 && !string.IsNullOrWhiteSpace(content) && !content.TrimStart().StartsWith('#'))
            throw new FormatException("Expected Prometheus exposition or a Log Studio metrics snapshot.");
        return result.ToArray();
    }

    private static void ReadLabels(string line, ref int position, List<TelemetryTag> tags)
    {
        position++;
        while (position < line.Length)
        {
            SkipSpace(line, ref position);
            if (position < line.Length && line[position] == '}') { position++; return; }
            int start = position;
            while (position < line.Length && (char.IsAsciiLetterOrDigit(line[position]) || line[position] == '_')) position++;
            string key = line[start..position];
            SkipSpace(line, ref position);
            if (key.Length == 0 || char.IsAsciiDigit(key[0]) || position >= line.Length || line[position++] != '=')
                throw new FormatException("Invalid Prometheus label.");
            SkipSpace(line, ref position);
            if (position >= line.Length || line[position++] != '"') throw new FormatException("Invalid Prometheus label value.");
            StringBuilder value = new();
            bool closed = false;
            while (position < line.Length)
            {
                char character = line[position++];
                if (character == '"') { closed = true; break; }
                if (character == '\\')
                {
                    if (position == line.Length) throw new FormatException("Invalid Prometheus label escape.");
                    character = line[position++] switch
                    {
                        'n' => '\n', '\\' => '\\', '"' => '"',
                        _ => throw new FormatException("Invalid Prometheus label escape."),
                    };
                }
                if (value.Length < TelemetryRecorder.MaximumStringLength) value.Append(character);
            }
            if (!closed) throw new FormatException("Unterminated Prometheus label value.");
            if (tags.Count < TelemetryRecorder.MaximumTags) tags.Add(new(Bound(key), value.ToString()));
            SkipSpace(line, ref position);
            if (position < line.Length && line[position] == ',') { position++; continue; }
            if (position < line.Length && line[position] == '}') { position++; return; }
            throw new FormatException("Invalid Prometheus label separator.");
        }
        throw new FormatException("Unterminated Prometheus labels.");

    }

    private static void SkipSpace(string line, ref int position)
    {
        while (position < line.Length && char.IsWhiteSpace(line[position])) position++;
    }

    internal static TelemetrySpan[] ParseSpans(string content)
    {
        using JsonDocument document = JsonDocument.Parse(content, new JsonDocumentOptions { MaxDepth = 32 });
        JsonElement root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw new FormatException("Expected Jaeger query JSON or a Log Studio traces snapshot.");
        CheckEnabled(root);
        if (root.TryGetProperty("spans", out JsonElement native) && native.ValueKind == JsonValueKind.Array)
        {
            if (native.GetArrayLength() > TelemetryRecorder.MaximumRecordsPerInterval) throw new FormatException("Too many endpoint spans.");
            return native.EnumerateArray().Select(item => Normalize(item.Deserialize<TelemetrySpan>(ViewerConstants.JsonOptions)
                ?? throw new FormatException("Invalid span record."))).ToArray();
        }
        if (!root.TryGetProperty("data", out JsonElement traces) || traces.ValueKind != JsonValueKind.Array)
            throw new FormatException("Expected Jaeger query JSON or a Log Studio traces snapshot. OTLP collectors are write endpoints, not query APIs.");
        if (root.TryGetProperty("errors", out JsonElement errors) && errors.ValueKind != JsonValueKind.Null &&
            (errors.ValueKind != JsonValueKind.Array || errors.GetArrayLength() != 0))
            throw new FormatException("The Jaeger query endpoint reported errors.");
        List<TelemetrySpan> result = new();
        foreach (JsonElement trace in traces.EnumerateArray())
        {
            JsonElement spans = trace.GetProperty("spans");
            foreach (JsonElement span in spans.EnumerateArray())
            {
                if (result.Count == TelemetryRecorder.MaximumRecordsPerInterval) throw new FormatException("Too many endpoint spans.");
                string traceId = RequiredText(span, "traceID");
                string parent = "";
                List<TelemetryLink> links = new();
                if (span.TryGetProperty("references", out JsonElement references))
                    foreach (JsonElement reference in references.EnumerateArray())
                    {
                        string referencedTrace = RequiredText(reference, "traceID");
                        string referencedSpan = RequiredText(reference, "spanID");
                        if (RequiredText(reference, "refType") == "CHILD_OF" && referencedTrace == traceId) parent = referencedSpan;
                        else if (links.Count < TelemetryRecorder.MaximumLinks) links.Add(new(referencedTrace, referencedSpan));
                    }
                List<TelemetryTag> tags = new();
                string status = "Unset", kind = "Internal";
                if (span.TryGetProperty("tags", out JsonElement attributes))
                    foreach (JsonElement tag in attributes.EnumerateArray())
                    {
                        string key = RequiredText(tag, "key");
                        JsonElement rawValue = tag.GetProperty("value");
                        string value = rawValue.ValueKind == JsonValueKind.String ? rawValue.GetString()! : rawValue.GetRawText();
                        if (key == "error" && value.Equals("true", StringComparison.OrdinalIgnoreCase)) status = "Error";
                        if (key == "otel.status_code" && status != "Error")
                            status = value.ToUpperInvariant() switch { "ERROR" or "2" => "Error", "OK" or "1" => "Ok", _ => "Unset" };
                        if (key == "span.kind" && value.Length > 0) kind = char.ToUpperInvariant(value[0]) + value[1..].ToLowerInvariant();
                        if (tags.Count < TelemetryRecorder.MaximumTags) tags.Add(new(key, Bound(value)));
                    }
                string source = "Jaeger";
                if (span.TryGetProperty("processID", out JsonElement processId) &&
                    trace.TryGetProperty("processes", out JsonElement processes) &&
                    processes.TryGetProperty(processId.GetString()!, out JsonElement process))
                    source = RequiredText(process, "serviceName");
                long microseconds = span.GetProperty("startTime").GetInt64();
                DateTimeOffset start = DateTimeOffset.FromUnixTimeMilliseconds(microseconds / 1000).AddTicks(microseconds % 1000 * 10);
                result.Add(Normalize(new TelemetrySpan(0, source, RequiredText(span, "operationName"), traceId, RequiredText(span, "spanID"),
                    parent, start, span.GetProperty("duration").GetDouble() / 1000, Bound(kind), status, null, tags.ToArray(), links.ToArray())));
            }
        }
        return result.ToArray();
    }

    private static void CheckEnabled(JsonElement root)
    {
        if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("enabled", out JsonElement enabled) && enabled.ValueKind == JsonValueKind.False)
            throw new FormatException("The configured Log Studio endpoint reports disabled capture.");
    }

    private static TelemetryMetric Normalize(TelemetryMetric metric)
    {
        if (!double.IsFinite(metric.Value) || metric.Id < 0 || metric.Timestamp == default) throw new FormatException("Invalid endpoint metric value or timestamp.");
        return metric with
        {
            Meter = Bound(metric.Meter), Name = Bound(metric.Name), InstrumentType = Bound(metric.InstrumentType),
            Unit = metric.Unit is null ? null : Bound(metric.Unit), Tags = NormalizeTags(metric.Tags),
        };
    }

    private static TelemetrySpan Normalize(TelemetrySpan span)
    {
        if (!double.IsFinite(span.DurationMilliseconds) || span.DurationMilliseconds < 0 || span.Id < 0 || span.StartTime == default || span.Links is null)
            throw new FormatException("Invalid endpoint span duration, timestamp, or links.");
        return span with
        {
            Source = Bound(span.Source), Name = Bound(span.Name), TraceId = Bound(span.TraceId), SpanId = Bound(span.SpanId),
            ParentSpanId = Bound(span.ParentSpanId), Kind = Bound(span.Kind), Status = Bound(span.Status),
            StatusDescription = span.StatusDescription is null ? null : Bound(span.StatusDescription),
            Tags = NormalizeTags(span.Tags),
            Links = span.Links.Take(TelemetryRecorder.MaximumLinks).Select(link => link is null
                ? throw new FormatException("Invalid endpoint span link.") : new TelemetryLink(Bound(link.TraceId), Bound(link.SpanId))).ToArray(),
        };
    }

    private static TelemetryTag[] NormalizeTags(TelemetryTag[] tags) => tags is null
        ? throw new FormatException("Invalid endpoint tags.")
        : tags.Take(TelemetryRecorder.MaximumTags).Select(tag => tag is null
            ? throw new FormatException("Invalid endpoint tag.") : new TelemetryTag(Bound(tag.Key), Bound(tag.Value))).ToArray();

    private static string RequiredText(JsonElement element, string name) =>
        Bound(element.GetProperty(name).GetString() ?? throw new FormatException("Missing endpoint telemetry text."));

    private static string Bound(string value)
    {
        if (value is null) throw new FormatException("Missing endpoint telemetry text.");
        return value.Length <= TelemetryRecorder.MaximumStringLength ? value : value[..TelemetryRecorder.MaximumStringLength];
    }

    public void Dispose() => this.client.Dispose();

    private sealed class RecordKeys
    {
        private string endpoint = "";
        private readonly HashSet<string> seen = new(StringComparer.Ordinal);
        private readonly Queue<string> order = new();

        internal bool Add(string endpoint, byte[] identity)
        {
            if (this.endpoint != endpoint) { this.endpoint = endpoint; this.seen.Clear(); this.order.Clear(); }
            string key = Convert.ToHexString(SHA256.HashData(identity));
            if (!this.seen.Add(key)) return false;
            this.order.Enqueue(key);
            if (this.order.Count > TelemetryRecorder.MaximumRecordsPerInterval) this.seen.Remove(this.order.Dequeue());
            return true;
        }
    }
}
