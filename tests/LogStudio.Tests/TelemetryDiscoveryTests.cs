using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.IO;
using System.Linq;
using Xunit;

namespace LogStudio.Tests;

public sealed class TelemetryDiscoveryTests
{
    [Fact]
    public void NativeCaptureDoesNotRequireAnOptIn()
    {
        using Meter meter = new("Discovery.Default");
        using ActivitySource source = new(meter.Name);
        using TelemetryRecorder recorder = new(new ConsoleLogViewerOptions
        {
            CaptureConsole = false,
            ApplicationName = "automatic-telemetry",
            MeterSources = meter.Name,
            ActivitySources = source.Name,
        }.Validate());
        meter.CreateCounter<int>("requests").Add(7);
        using (source.StartActivity("request")) { }
        Assert.True(recorder.Snapshot().Enabled);
        Assert.Equal(7, Assert.Single(recorder.Snapshot().Metrics).Value);
        Assert.Equal("request", Assert.Single(recorder.Snapshot().Spans).Name);
    }

    [Fact]
    public void SourcePatternsAreDiscoveredFromApplicationConfiguration()
    {
        using ConfigurationDirectory directory = new("""
            {
              "LogStudio": {
                "Telemetry": {
                  "MeterSources": ["Orders.*", "System.Runtime"],
                  "ActivitySources": "Orders.Api"
                }
              }
            }
            """);
        ViewerSettings settings = directory.Options().Validate();
        Assert.Equal("Orders.*,System.Runtime", settings.MeterSources);
        Assert.Equal("Orders.Api", settings.ActivitySources);
    }

    [Fact]
    public void EnvironmentAndExplicitOptionsOverrideEnvironmentSpecificConfiguration()
    {
        using ConfigurationDirectory directory = new("""
            {
              "OpenTelemetry": { "Metrics": { "Meters": ["Runtime.*"] }, "Tracing": { "Sources": ["Requests.*"] } },
              "Prometheus": { "Endpoint": "http://localhost:9464/metrics" },
              "LogStudio": { "Telemetry": { "MetricsEndpoint": "http://localhost:7000/base" } }
            }
            """);
        File.WriteAllText(Path.Combine(directory.Path, "appsettings.Development.json"), """
            { "LogStudio": { "Telemetry": { "MetricsEndpoint": "http://localhost:7001/development", "ActivitySources": "Dev.*" } } }
            """);
        Dictionary<string, string> environment = new()
        {
            ["DOTNET_ENVIRONMENT"] = "Development",
            ["LOG_STUDIO_METRICS_ENDPOINT"] = "http://localhost:7002/environment",
            ["LOG_STUDIO_METER_SOURCES"] = "Environment.*",
            ["LOG_STUDIO_TELEMETRY"] = "false",
        };
        ConsoleLogViewerOptions options = directory.Options();
        DiscoveredTelemetryConfiguration discovered = directory.Discover(options, environment);
        Assert.False(discovered.Enabled);
        Assert.Equal("Environment.*", discovered.MeterSources);
        Assert.Equal("Dev.*", discovered.ActivitySources);
        Assert.Equal("http://localhost:7002/environment", discovered.MetricsEndpoint);
        options.CaptureTelemetry = true;
        options.MeterSources = "*";
        options.MetricsEndpoint = "http://localhost:7003/custom/path?region=west";
        discovered = directory.Discover(options, environment);
        Assert.True(discovered.Enabled);
        Assert.Equal("*", discovered.MeterSources);
        Assert.Equal(options.MetricsEndpoint, discovered.MetricsEndpoint);
        options.MetricsEndpoint = "";
        Assert.Empty(directory.Discover(options, environment).MetricsEndpoint);
    }

    [Theory]
    [InlineData("run", "--project", "service/Orders.csproj")]
    [InlineData("run", "--project=service/Orders.csproj")]
    [InlineData("service/Orders.dll")]
    public void WrapperDiscoversTheChildConfigurationInsteadOfOnlyItsOwnDirectory(params string[] arguments)
    {
        using ConfigurationDirectory directory = new("{}");
        string service = Path.Combine(directory.Path, "service");
        Directory.CreateDirectory(service);
        File.WriteAllText(Path.Combine(service, "appsettings.json"), """
            { "LogStudio": { "Telemetry": { "MetricsEndpoint": "http://localhost:9464/custom-metrics",
              "TracesEndpoint": "http://localhost:16686/api/traces?service=Orders" } } }
            """);
        ConsoleLogViewerOptions options = directory.Options();
        options.RunCommand = "dotnet";
        options.RunArguments = arguments;
        DiscoveredTelemetryConfiguration discovered = directory.Discover(options);
        Assert.Equal("http://localhost:9464/custom-metrics", discovered.MetricsEndpoint);
        Assert.Equal("http://localhost:16686/api/traces?service=Orders", discovered.TracesEndpoint);
    }

    [Fact]
    public void NativeExecutableAndDottedProjectDirectoriesAreSupported()
    {
        using ConfigurationDirectory directory = new("{}");
        string service = Path.Combine(directory.Path, "service.v2");
        Directory.CreateDirectory(service);
        File.WriteAllText(Path.Combine(service, "appsettings.json"), """
            { "Telemetry": { "Metrics": { "Endpoint": "http://localhost:7000/read" } } }
            """);
        ConsoleLogViewerOptions options = directory.Options();
        options.RunCommand = "./service.v2/Orders";
        Assert.Equal("http://localhost:7000/read", directory.Discover(options).MetricsEndpoint);
        options.RunCommand = "dotnet";
        options.RunArguments = ["run", "--project", "service.v2"];
        Assert.Equal("http://localhost:7000/read", directory.Discover(options).MetricsEndpoint);
    }

    [Fact]
    public void StandardPrometheusEnvironmentAndJaegerQueryConfigurationAreDiscovered()
    {
        using ConfigurationDirectory directory = new("""
            { "Jaeger": { "QueryEndpoint": "http://localhost:16686/api/traces?service=Orders" } }
            """);
        DiscoveredTelemetryConfiguration discovered = directory.Discover(environment: new()
        {
            ["OTEL_EXPORTER_PROMETHEUS_HOST"] = "0.0.0.0",
            ["OTEL_EXPORTER_PROMETHEUS_PORT"] = "19464",
        });
        Assert.Equal("http://localhost:19464/metrics", discovered.MetricsEndpoint);
        Assert.Equal("http://localhost:16686/api/traces?service=Orders", discovered.TracesEndpoint);
        Assert.Empty(discovered.Warnings);
    }

    [Fact]
    public void OtlpCollectorsAreReportedButNeverMistakenForReadEndpoints()
    {
        using ConfigurationDirectory directory = new("""
            { "OpenTelemetry": { "Otlp": { "Endpoint": "http://localhost:4317" } } }
            """);
        DiscoveredTelemetryConfiguration discovered = directory.Discover(environment: new()
        {
            ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] = "http://localhost:4318/v1/traces",
        });
        Assert.Empty(discovered.MetricsEndpoint);
        Assert.Empty(discovered.TracesEndpoint);
        Assert.Equal(2, discovered.Warnings.Length);
        Assert.All(discovered.Warnings, warning => Assert.Contains("write", warning, StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(discovered.Warnings, warning => warning.Contains("4317", StringComparison.Ordinal));
    }

    [Fact]
    public void MalformedAutomaticConfigurationWarnsWhileExplicitFilesFail()
    {
        using ConfigurationDirectory directory = new("{ invalid-json");
        DiscoveredTelemetryConfiguration discovered = directory.Discover();
        Assert.True(discovered.Enabled);
        Assert.Single(discovered.Warnings);
        ConsoleLogViewerOptions options = directory.Options();
        options.TelemetryConfigurationFile = "appsettings.json";
        Assert.Throws<ArgumentException>(() => directory.Discover(options));
        options.TelemetryConfigurationFile = "missing.json";
        Assert.Throws<ArgumentException>(() => directory.Discover(options));
    }

    [Fact]
    public void AdditionalConfigurationSupportsCommentsAndCaseInsensitiveKeys()
    {
        using ConfigurationDirectory directory = new("{}");
        File.WriteAllText(Path.Combine(directory.Path, "custom.json"), """
            {
              // Standard .NET configuration permits comments and trailing commas.
              "logstudio": { "telemetry": {
                "metersources": ["Orders.Api"],
                "tracesendpoint": "http://localhost:16686/custom?service=Orders",
              } }
            }
            """);
        ConsoleLogViewerOptions options = directory.Options();
        options.TelemetryConfigurationFile = "custom.json";
        DiscoveredTelemetryConfiguration discovered = directory.Discover(options);
        Assert.Equal("Orders.Api", discovered.MeterSources);
        Assert.Equal("http://localhost:16686/custom?service=Orders", discovered.TracesEndpoint);
    }

    [Fact]
    public void OversizedConfigurationAndInvalidDiscoveredValuesAreDisclosed()
    {
        using ConfigurationDirectory directory = new("{}".PadRight(TelemetryConfiguration.MaximumConfigurationBytes));
        Assert.Empty(directory.Discover().Warnings);
        File.AppendAllText(Path.Combine(directory.Path, "appsettings.json"), " ");
        Assert.Single(directory.Discover().Warnings);
        File.WriteAllText(Path.Combine(directory.Path, "appsettings.json"), """
            { "Telemetry": { "MetricsEndpoint": "http://user:secret@localhost:9464/metrics", "ActivitySources": [42] } }
            """);
        DiscoveredTelemetryConfiguration discovered = directory.Discover();
        Assert.Empty(discovered.MetricsEndpoint);
        Assert.Equal("*", discovered.ActivitySources);
        Assert.Equal(2, discovered.Warnings.Length);
        Assert.DoesNotContain(discovered.Warnings, warning => warning.Contains("secret", StringComparison.Ordinal));
        Assert.True(discovered.Warnings.All(warning => warning.Length <= TelemetryRecorder.MaximumStringLength));
    }

    [Theory]
    [InlineData("file:///tmp/metrics")]
    [InlineData("/metrics")]
    [InlineData("http://user:password@localhost:9464/metrics")]
    [InlineData("https://localhost/metrics#fragment")]
    [InlineData("https://localhost/metrics#")]
    [InlineData("http://localhost/metrics\u0085")]
    [InlineData(" https://localhost/metrics")]
    [InlineData("http://localhost/metrics\ninjected")]
    public void ExplicitEndpointsAreValidated(string endpoint)
    {
        using ConfigurationDirectory directory = new("{}");
        ConsoleLogViewerOptions options = directory.Options();
        options.MetricsEndpoint = endpoint;
        Assert.Throws<ArgumentException>(() => directory.Discover(options));
        options.MetricsEndpoint = "";
        options.TracesEndpoint = endpoint;
        Assert.Throws<ArgumentException>(() => directory.Discover(options));
    }

    private sealed class ConfigurationDirectory : IDisposable
    {
        internal string Path { get; } = Directory.CreateTempSubdirectory("logstudio-telemetry-config-").FullName;

        internal ConfigurationDirectory(string content) => File.WriteAllText(System.IO.Path.Combine(this.Path, "appsettings.json"), content);

        internal ConsoleLogViewerOptions Options() => new() { ApplicationName = "config-tests", RunWorkingDirectory = this.Path };

        internal DiscoveredTelemetryConfiguration Discover(ConsoleLogViewerOptions? options = null, Dictionary<string, string>? environment = null) =>
            TelemetryConfiguration.Discover(options ?? this.Options(), name => environment?.GetValueOrDefault(name), this.Path);

        public void Dispose() => Directory.Delete(this.Path, recursive: true);
    }
}
