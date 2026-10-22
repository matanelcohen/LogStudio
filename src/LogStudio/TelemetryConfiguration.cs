using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace LogStudio;

internal sealed record DiscoveredTelemetryConfiguration(bool Enabled, string MeterSources, string ActivitySources,
    string MetricsEndpoint, string TracesEndpoint, string[] Warnings);

internal static class TelemetryConfiguration
{
    internal const int MaximumEndpointLength = 2048;
    internal const int MaximumConfigurationBytes = 524288;

    internal static DiscoveredTelemetryConfiguration Discover(ConsoleLogViewerOptions options,
        Func<string, string?>? environment = null, string? baseDirectory = null)
    {
        environment ??= Environment.GetEnvironmentVariable;
        List<string> warnings = new();
        string meters = "*", activities = "*", metricsEndpoint = "", tracesEndpoint = "";
        bool enabled = true;
        string workingDirectory = Path.GetFullPath(options.RunWorkingDirectory ?? Environment.CurrentDirectory);
        string applicationDirectory = options.RunCommand is null
            ? baseDirectory ?? AppContext.BaseDirectory
            : ApplicationDirectory(options.RunCommand, options.RunArguments, workingDirectory);
        string? environmentName = environment("DOTNET_ENVIRONMENT") ?? environment("ASPNETCORE_ENVIRONMENT");
        if (environmentName is not null && (environmentName.Length > 128 ||
            environmentName.IndexOfAny(['/', '\\']) >= 0 || environmentName is "." or ".."))
        {
            Warn("The application environment name is not safe for appsettings discovery.");
            environmentName = null;
        }

        IEnumerable<string> directories = options.RunCommand is null
            ? new[] { applicationDirectory, workingDirectory }
            : new[] { workingDirectory, applicationDirectory };
        foreach (string directory in directories.Distinct(StringComparer.Ordinal))
        {
            Read(Path.Combine(directory, "appsettings.json"), required: false);
            if (!string.IsNullOrEmpty(environmentName))
                Read(Path.Combine(directory, $"appsettings.{environmentName}.json"), required: false);
        }
        string? configurationFile = options.TelemetryConfigurationFile ?? environment("LOG_STUDIO_TELEMETRY_CONFIG");
        if (configurationFile is not null)
        {
            if (string.IsNullOrWhiteSpace(configurationFile))
                throw new ArgumentException("The telemetry configuration file must not be empty.");
            Read(Path.GetFullPath(configurationFile, workingDirectory), required: true);
        }

        foreach (string variable in new[] { "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT" })
        {
            if (!string.IsNullOrEmpty(environment(variable)))
                Warn($"{variable} is an OTLP write endpoint, not a readable telemetry API. Configure a metrics scrape or traces query endpoint.");
        }
        string? prometheusPort = environment("OTEL_EXPORTER_PROMETHEUS_PORT");
        string? prometheusHost = environment("OTEL_EXPORTER_PROMETHEUS_HOST");
        if (prometheusPort is not null || prometheusHost is not null)
        {
            if (int.TryParse(prometheusPort ?? "9464", NumberStyles.None, CultureInfo.InvariantCulture, out int port) && port is > 0 and <= 65535)
            {
                string host = prometheusHost ?? "localhost";
                if (host is "0.0.0.0" or "::") host = "localhost";
                if (Uri.CheckHostName(host) != UriHostNameType.Unknown)
                    metricsEndpoint = new UriBuilder("http", host, port, "metrics").Uri.AbsoluteUri;
                else Warn("OTEL_EXPORTER_PROMETHEUS_HOST is not a valid host name.");
            }
            else Warn("OTEL_EXPORTER_PROMETHEUS_PORT must be between 1 and 65535.");
        }

        meters = options.HasMeterSources ? options.MeterSources : environment("LOG_STUDIO_METER_SOURCES") ?? meters;
        activities = options.HasActivitySources ? options.ActivitySources : environment("LOG_STUDIO_ACTIVITY_SOURCES") ?? activities;
        metricsEndpoint = options.MetricsEndpoint ?? environment("LOG_STUDIO_METRICS_ENDPOINT") ?? metricsEndpoint;
        tracesEndpoint = options.TracesEndpoint ?? environment("LOG_STUDIO_TRACES_ENDPOINT") ?? tracesEndpoint;
        if (options.HasCaptureTelemetry) enabled = options.CaptureTelemetry;
        else if (environment("LOG_STUDIO_TELEMETRY") is string capture)
            enabled = capture.ToLowerInvariant() switch
            {
                "true" or "1" => true,
                "false" or "0" => false,
                _ => throw new ArgumentException("LOG_STUDIO_TELEMETRY must be true, false, 1, or 0."),
            };
        TelemetryRecorder.ValidatePatterns(meters, nameof(options.MeterSources));
        TelemetryRecorder.ValidatePatterns(activities, nameof(options.ActivitySources));
        ValidateEndpoint(metricsEndpoint, nameof(options.MetricsEndpoint));
        ValidateEndpoint(tracesEndpoint, nameof(options.TracesEndpoint));
        return new(enabled, meters, activities, metricsEndpoint, tracesEndpoint, warnings.ToArray());

        void Warn(string message)
        {
            if (warnings.Count < 16)
                warnings.Add(message.Length > TelemetryRecorder.MaximumStringLength ? message[..TelemetryRecorder.MaximumStringLength] : message);
        }

        void Read(string path, bool required)
        {
            try
            {
                using FileStream file = File.OpenRead(path);
                byte[] bytes = new byte[MaximumConfigurationBytes + 1];
                int length = 0, read;
                while (length < bytes.Length && (read = file.Read(bytes, length, bytes.Length - length)) > 0) length += read;
                if (length > MaximumConfigurationBytes)
                    throw new JsonException("Configuration size limit exceeded.");
                using JsonDocument document = JsonDocument.Parse(bytes.AsMemory(0, length),
                    new JsonDocumentOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip, MaxDepth = 32 });
                JsonElement root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object) throw new JsonException("Configuration must be an object.");
                JsonElement otel = Property(root, "OpenTelemetry");
                JsonElement metrics = Property(otel, "Metrics");
                JsonElement traces = Property(otel, "Traces");
                if (traces.ValueKind == JsonValueKind.Undefined) traces = Property(otel, "Tracing");
                Sources(metrics, "Meters", ref meters);
                Sources(traces, "Sources", ref activities);
                Endpoint(Property(metrics, "Prometheus"), "Endpoint", ref metricsEndpoint);
                Endpoint(Property(root, "Prometheus"), "Endpoint", ref metricsEndpoint);
                Endpoint(Property(root, "Jaeger"), "QueryEndpoint", ref tracesEndpoint);
                Endpoint(Property(traces, "Jaeger"), "QueryEndpoint", ref tracesEndpoint);
                Apply(Property(root, "Telemetry"));
                JsonElement studio = Property(root, "LogStudio");
                Apply(studio);
                Apply(Property(studio, "Telemetry"));
                if (Property(otel, "Endpoint").ValueKind != JsonValueKind.Undefined ||
                    Property(Property(otel, "Otlp"), "Endpoint").ValueKind != JsonValueKind.Undefined ||
                    Property(Property(metrics, "Otlp"), "Endpoint").ValueKind != JsonValueKind.Undefined ||
                    Property(Property(traces, "Otlp"), "Endpoint").ValueKind != JsonValueKind.Undefined)
                    Warn("An OpenTelemetry exporter endpoint was found. OTLP collectors accept writes; set a readable metrics or traces endpoint to view exported data.");
            }
            catch (FileNotFoundException) when (!required) { }
            catch (DirectoryNotFoundException) when (!required) { }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
            {
                if (required) throw new ArgumentException("The telemetry configuration file could not be read as bounded JSON.", nameof(options.TelemetryConfigurationFile), exception);
                Warn($"Could not read telemetry configuration from {Path.GetFileName(path)}. Check access and JSON syntax (maximum 512 KiB).");
            }
        }

        void Apply(JsonElement section)
        {
            Sources(section, "MeterSources", ref meters);
            Sources(section, "ActivitySources", ref activities);
            Endpoint(section, "MetricsEndpoint", ref metricsEndpoint);
            Endpoint(section, "TracesEndpoint", ref tracesEndpoint);
            Endpoint(Property(section, "Metrics"), "Endpoint", ref metricsEndpoint);
            Endpoint(Property(section, "Traces"), "Endpoint", ref tracesEndpoint);
            JsonElement capture = Property(section, "CaptureTelemetry");
            if (capture.ValueKind is JsonValueKind.True or JsonValueKind.False) enabled = capture.GetBoolean();
            else if (capture.ValueKind != JsonValueKind.Undefined) Warn("CaptureTelemetry in configuration must be a boolean.");
        }

        void Sources(JsonElement section, string name, ref string destination)
        {
            JsonElement value = Property(section, name);
            if (value.ValueKind == JsonValueKind.Undefined) return;
            string? patterns = value.ValueKind == JsonValueKind.String ? value.GetString() :
                value.ValueKind == JsonValueKind.Array && value.GetArrayLength() <= 64 &&
                value.EnumerateArray().All(item => item.ValueKind == JsonValueKind.String)
                    ? string.Join(",", value.EnumerateArray().Select(item => item.GetString())) : null;
            if (patterns is null) { Warn($"{name} in configuration must be a string or an array of up to 64 strings."); return; }
            try { TelemetryRecorder.ValidatePatterns(patterns, name); destination = patterns; }
            catch (ArgumentException) { Warn($"{name} in configuration exceeds the source pattern limits."); }
        }

        void Endpoint(JsonElement section, string name, ref string destination)
        {
            JsonElement value = Property(section, name);
            if (value.ValueKind == JsonValueKind.Undefined) return;
            if (value.ValueKind != JsonValueKind.String) { Warn($"{name} in configuration must be a URL string."); return; }
            string endpoint = value.GetString()!;
            try { ValidateEndpoint(endpoint, name); destination = endpoint; }
            catch (ArgumentException) { Warn($"{name} in configuration must be an HTTP(S) URL without credentials or a fragment, at most 2048 characters."); }
        }
    }

    internal static void ValidateEndpoint(string endpoint, string name)
    {
        ArgumentNullException.ThrowIfNull(endpoint, name);
        if (endpoint.Length == 0) return;
        if (endpoint.Length > MaximumEndpointLength || !Uri.TryCreate(endpoint, UriKind.Absolute, out Uri? uri) ||
            uri.Scheme is not ("http" or "https") || string.IsNullOrEmpty(uri.Host) ||
            uri.UserInfo.Length != 0 || uri.Fragment.Length != 0 || endpoint != endpoint.Trim() || endpoint.Any(char.IsControl))
            throw new ArgumentException("Telemetry endpoints must be absolute HTTP(S) URLs without credentials or fragments, at most 2048 characters.", name);
    }

    private static JsonElement Property(JsonElement section, string name)
    {
        if (section.ValueKind == JsonValueKind.Object)
            foreach (JsonProperty property in section.EnumerateObject())
                if (property.Name.Equals(name, StringComparison.OrdinalIgnoreCase)) return property.Value;
        return default;
    }

    private static string ApplicationDirectory(string command, string[] arguments, string workingDirectory)
    {
        for (int index = 0; index < arguments.Length && arguments[index] != "--"; index++)
        {
            string argument = arguments[index];
            if (argument is "--project" or "-p" && index + 1 < arguments.Length)
                return ProjectDirectory(arguments[index + 1]);
            if (argument.StartsWith("--project=", StringComparison.Ordinal))
                return ProjectDirectory(argument["--project=".Length..]);
            if (argument.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) || argument.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase))
                return ProjectDirectory(argument);
        }
        return command.IndexOfAny(['/', '\\']) >= 0 ? Path.GetDirectoryName(Path.GetFullPath(command, workingDirectory))! : workingDirectory;

        string ProjectDirectory(string path)
        {
            string full = Path.GetFullPath(path, workingDirectory);
            return !Directory.Exists(full) && Path.HasExtension(full) ? Path.GetDirectoryName(full)! : full;
        }
    }
}
