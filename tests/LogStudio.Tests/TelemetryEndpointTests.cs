using System;
using System.Collections.Concurrent;
using System.Diagnostics.Metrics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace LogStudio.Tests;

public sealed class TelemetryEndpointTests
{
    internal const string JaegerResponse = """
        {"data":[{"processes":{"p1":{"serviceName":"Orders.Api"}},"spans":[
          {"traceID":"0123456789abcdef0123456789abcdef","spanID":"0123456789abcdef","operationName":"checkout",
           "processID":"p1","startTime":1600000000000001,"duration":12345,"tags":[{"key":"span.kind","value":"server"}],"references":[]},
          {"traceID":"0123456789abcdef0123456789abcdef","spanID":"1123456789abcdef","operationName":"payment",
           "processID":"p1","startTime":1600000000002001,"duration":3000,
           "tags":[{"key":"error","value":true}],
           "references":[{"refType":"CHILD_OF","traceID":"0123456789abcdef0123456789abcdef","spanID":"0123456789abcdef"},
                         {"refType":"FOLLOWS_FROM","traceID":"abcdef0123456789abcdef0123456789","spanID":"abcdef0123456789"}]}
        ]}],"errors":null}
        """;

    [Fact]
    public void PrometheusPreservesScopeLabelsEscapesTypesUnitsAndSampleTimes()
    {
        TelemetryMetric metric = Assert.Single(TelemetryEndpointReader.ParseMetrics("""
            # TYPE orders_total counter
            # UNIT orders_total orders
            orders_total{otel_scope_name="Orders.Api",route="/checkout\n\"quoted\"",host="a\\b"} 1.25e3 1600000000123
            """, DateTimeOffset.UtcNow));
        Assert.Equal("Orders.Api", metric.Meter);
        Assert.Equal("orders_total", metric.Name);
        Assert.Equal("counter", metric.InstrumentType);
        Assert.Equal("orders", metric.Unit);
        Assert.Equal(1250, metric.Value);
        Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(1600000000123), metric.Timestamp);
        Assert.Contains(metric.Tags, tag => tag.Key == "route" && tag.Value == "/checkout\n\"quoted\"");
        Assert.Contains(metric.Tags, tag => tag.Key == "host" && tag.Value == "a\\b");
    }

    [Fact]
    public void JaegerPreservesParentsErrorsLinksAndMicrosecondTiming()
    {
        TelemetrySpan[] spans = TelemetryEndpointReader.ParseSpans(JaegerResponse);
        Assert.Equal(2, spans.Length);
        Assert.Equal("Orders.Api", spans[0].Source);
        Assert.Equal("Server", spans[0].Kind);
        Assert.Equal(12.345, spans[0].DurationMilliseconds);
        Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(1600000000000).AddTicks(10), spans[0].StartTime);
        Assert.Equal(spans[0].SpanId, spans[1].ParentSpanId);
        Assert.Equal("Error", spans[1].Status);
        Assert.Equal("abcdef0123456789abcdef0123456789", Assert.Single(spans[1].Links).TraceId);
    }

    [Fact]
    public void NativeSnapshotsAreValidatedAndBounded()
    {
        TelemetryMetric metric = new(1, DateTimeOffset.UtcNow, "Remote", new string('m', 300), null, "Counter", 7,
            Enumerable.Range(0, 40).Select(index => new TelemetryTag(index.ToString(), new string('v', 300))).ToArray());
        TelemetrySpan span = new(1, "Remote", "request", "trace", "span", "", metric.Timestamp, 1, "Server", "Ok", null, [],
            Enumerable.Range(0, 20).Select(_ => new TelemetryLink("trace", "span")).ToArray());
        string content = JsonSerializer.Serialize(new { metrics = new[] { metric }, spans = new[] { span } }, ViewerConstants.JsonOptions);
        TelemetryMetric parsedMetric = Assert.Single(TelemetryEndpointReader.ParseMetrics(content, DateTimeOffset.UtcNow));
        Assert.Equal(256, parsedMetric.Name.Length);
        Assert.Equal(32, parsedMetric.Tags.Length);
        Assert.All(parsedMetric.Tags, tag => Assert.Equal(256, tag.Value.Length));
        Assert.Equal(16, Assert.Single(TelemetryEndpointReader.ParseSpans(content)).Links.Length);
        Assert.Throws<FormatException>(() => TelemetryEndpointReader.ParseMetrics("""{"metrics":[{"value":7}]}""", DateTimeOffset.UtcNow));
        Assert.Throws<FormatException>(() => TelemetryEndpointReader.ParseSpans("""{"spans":[{"durationMilliseconds":-1}]}"""));
    }

    [Theory]
    [InlineData("<html>not telemetry</html>")]
    [InlineData("requests +Inf")]
    [InlineData("requests{bad=\"unterminated} 1")]
    [InlineData("requests 1 unexpected")]
    [InlineData("""{"resourceMetrics":[]}""")]
    public void InvalidMetricsDoNotBecomeSuccessShapedEmptySnapshots(string content) =>
        Assert.Throws<FormatException>(() => TelemetryEndpointReader.ParseMetrics(content, DateTimeOffset.UtcNow));

    [Theory]
    [InlineData("{}")]
    [InlineData("""{"resourceSpans":[]}""")]
    [InlineData("""{"data":[],"errors":[{"msg":"query failed"}]}""")]
    [InlineData("""{"enabled":false,"spans":[]}""")]
    public void InvalidOrWriteOnlyTracesEndpointsAreRejected(string content) =>
        Assert.Throws<FormatException>(() => TelemetryEndpointReader.ParseSpans(content));

    [Fact]
    public async Task WrapperModePollsExactCustomUrlsAndAlwaysCapturesNativeTelemetry()
    {
        await using TelemetryTestServer server = new();
        using Meter meter = new("Endpoint.Wrapper");
        Counter<int> counter = meter.CreateCounter<int>("must-not-capture");
        ConsoleLogViewerOptions options = Options(server);
        options.MeterSources = "Prometheus,Endpoint.Wrapper";
        using TelemetryRecorder recorder = new(options.Validate());
        Assert.True(counter.Enabled);
        counter.Add(3);
        Assert.True(recorder.GetSettings().CanConfigure);
        TelemetrySnapshot snapshot = await WaitForAsync(recorder, value =>
            value.Metrics.Any(metric => metric.Meter == "Endpoint.Wrapper") &&
            value.Metrics.Any(metric => metric.Meter == "Prometheus") &&
            value.Spans.Count(span => span.Source == "Orders.Api") == 2);
        Assert.Contains(snapshot.Metrics, metric => metric.Meter == "Endpoint.Wrapper" && metric.Value == 3);
        Assert.Contains(snapshot.Metrics, metric => metric.Meter == "Prometheus" && metric.Value == 7);
        Assert.Contains(snapshot.Spans, span => span.Name == "payment" && span.Status == "Error");
        Assert.Contains("/unusual/metrics?group=orders", server.Requests);
        Assert.Contains("/unusual/query?service=Orders", server.Requests);
        snapshot = await WaitForAsync(recorder, value => value.Metrics.Count(metric => metric.Meter == "Prometheus") >= 2);
        Assert.Equal(2, snapshot.Spans.Count(span => span.Source == "Orders.Api"));
    }

    [Fact]
    public async Task ExcludedRemoteSourcesAreStillDiscovered()
    {
        await using TelemetryTestServer server = new();
        ConsoleLogViewerOptions options = Options(server);
        options.MeterSources = "Excluded";
        options.ActivitySources = "Excluded";
        using TelemetryRecorder recorder = new(options.Validate());
        await WaitForAsync(recorder, _ =>
            recorder.GetSources().MeterSources.Contains("Prometheus") &&
            recorder.GetSources().ActivitySources.Contains("Orders.Api"));
        Assert.Empty(recorder.Snapshot().Metrics);
        Assert.Empty(recorder.Snapshot().Spans);
        Assert.Contains("Prometheus", recorder.GetSources().MeterSources);
        Assert.Contains("Orders.Api", recorder.GetSources().ActivitySources);
    }

    [Fact]
    public async Task FailedEndpointsRecoverAndLogClearingDoesNotClearTelemetry()
    {
        await using TelemetryTestServer server = new() { StatusCode = 503 };
        await using ConsoleLogViewer viewer = ConsoleLogViewer.Start(Options(server));
        using HttpClient client = new();
        viewer.Record("separate log history");
        TelemetrySnapshot snapshot = await WaitForAsync(Read, value => value.MetricsEndpointError is not null && value.TracesEndpointError is not null);
        Assert.Contains("503", snapshot.MetricsEndpointError);
        Assert.Empty(snapshot.Metrics);
        Assert.Single(viewer.GetLogs());
        server.StatusCode = 200;
        snapshot = await WaitForAsync(Read, value => value.Metrics.Length > 0 && value.Spans.Length > 0 && value.MetricsEndpointError is null);
        Assert.Null(snapshot.TracesEndpointError);
        viewer.ClearLogs();
        Assert.Empty(viewer.GetLogs());
        Assert.NotEmpty((await Read(CancellationToken.None)).Metrics);

        async Task<TelemetrySnapshot> Read(CancellationToken token) =>
            JsonSerializer.Deserialize<TelemetrySnapshot>(await client.GetStringAsync(new Uri(viewer.Url, "api/telemetry"), token),
                ViewerConstants.JsonOptions)!;
    }

    [Fact]
    public async Task NativeSnapshotsAreDeduplicatedAndEndpointChangesPreserveHistory()
    {
        await using TelemetryTestServer server = new();
        TelemetryMetric metric = new(1, DateTimeOffset.UtcNow, "Remote", "requests", null, "Counter", 7, []);
        server.MetricsBody = JsonSerializer.Serialize(new { metrics = new[] { metric } }, ViewerConstants.JsonOptions);
        ConsoleLogViewerOptions options = Options(server);
        options.MeterSources = "Remote";
        using TelemetryRecorder recorder = new(options.Validate());
        await WaitForAsync(recorder, value => value.Metrics.Length == 1 && server.Requests.Count >= 4);
        Assert.Single(recorder.Snapshot().Metrics);
        Assert.Equal(2, recorder.Snapshot().Spans.Length);
        server.MetricsBody = JsonSerializer.Serialize(new { metrics = new[] { metric with { Value = 9 } } }, ViewerConstants.JsonOptions);
        recorder.Configure("Remote", "Orders.Api", new Uri(server.Url, "different/metrics?version=2").AbsoluteUri);
        TelemetrySnapshot snapshot = await WaitForAsync(recorder, value => value.Metrics.Length == 2);
        Assert.Equal(new double[] { 7, 9 }, snapshot.Metrics.Select(measurement => measurement.Value));
        Assert.Equal(new long[] { 1, 2 }, snapshot.Metrics.Select(measurement => measurement.Id));
        Assert.Equal(2, snapshot.Spans.Length);
        Assert.Contains("/different/metrics?version=2", server.Requests);
    }

    [Fact]
    public async Task ReconfigurationDoesNotCacheDiscardedResponsesOrDuplicateRetainedRecords()
    {
        TaskCompletionSource responseGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        await using TelemetryTestServer server = new() { ResponseGate = responseGate };
        TelemetryMetric metric = new(1, DateTimeOffset.UtcNow, "Remote", "requests", null, "Counter", 7, []);
        server.MetricsBody = JsonSerializer.Serialize(new { metrics = new[] { metric } }, ViewerConstants.JsonOptions);
        using TelemetryRecorder recorder = new(Options(server).Validate());
        await WaitForAsync(recorder, _ => !server.Requests.IsEmpty);
        recorder.Configure("Remote", "Orders.Api");
        responseGate.SetResult();
        await WaitForAsync(recorder, value => value.Metrics.Length == 1 && value.Spans.Length == 2);
        recorder.Configure("Remote", "Orders.Api");
        await WaitForAsync(recorder, _ => server.Requests.Count >= 6);
        Assert.Single(recorder.Snapshot().Metrics);
        Assert.Equal(2, recorder.Snapshot().Spans.Length);
    }

    [Fact]
    public void BothParsersAcceptTheExactRecordLimitAndRejectOneMore()
    {
        string metrics = string.Concat(Enumerable.Repeat("orders_total 7\n", TelemetryRecorder.MaximumRecordsPerInterval));
        Assert.Equal(TelemetryRecorder.MaximumRecordsPerInterval, TelemetryEndpointReader.ParseMetrics(metrics, DateTimeOffset.UtcNow).Length);
        Assert.Throws<FormatException>(() => TelemetryEndpointReader.ParseMetrics(metrics + "orders_total 8\n", DateTimeOffset.UtcNow));
        TelemetrySpan span = new(1, "Remote", "request", "trace", "span", "", DateTimeOffset.UtcNow, 1, "Server", "Ok", null, [], []);
        string traces = JsonSerializer.Serialize(new { spans = Enumerable.Repeat(span, TelemetryRecorder.MaximumRecordsPerInterval) },
            ViewerConstants.JsonOptions);
        Assert.Equal(TelemetryRecorder.MaximumRecordsPerInterval, TelemetryEndpointReader.ParseSpans(traces).Length);
        string oversized = JsonSerializer.Serialize(new { spans = Enumerable.Repeat(span, TelemetryRecorder.MaximumRecordsPerInterval + 1) },
            ViewerConstants.JsonOptions);
        Assert.Throws<FormatException>(() => TelemetryEndpointReader.ParseSpans(oversized));
    }

    [Fact]
    public async Task EndpointsCanBeConfiguredLiveWithoutStartupFlags()
    {
        await using TelemetryTestServer server = new();
        ConsoleLogViewerOptions options = Options(server);
        options.MetricsEndpoint = options.TracesEndpoint = "";
        await using ConsoleLogViewer viewer = ConsoleLogViewer.Start(options);
        using HttpClient client = new();
        Uri settingsEndpoint = new(viewer.Url, ViewerConstants.TelemetrySettingsRoute);
        string before = await client.GetStringAsync(settingsEndpoint);
        using HttpRequestMessage invalid = Configure(settingsEndpoint, """
            {"meterSources":"Changed","activitySources":"Changed","metricsEndpoint":"file:///tmp/metrics","tracesEndpoint":""}
            """);
        using HttpResponseMessage rejected = await client.SendAsync(invalid);
        Assert.Equal(HttpStatusCode.BadRequest, rejected.StatusCode);
        Assert.Equal(before, await client.GetStringAsync(settingsEndpoint));
        using HttpRequestMessage valid = Configure(settingsEndpoint, JsonSerializer.Serialize(new
        {
            meterSources = "*", activitySources = "*",
            metricsEndpoint = server.MetricsEndpoint, tracesEndpoint = server.TracesEndpoint,
        }));
        using HttpResponseMessage accepted = await client.SendAsync(valid);
        Assert.Equal(HttpStatusCode.OK, accepted.StatusCode);
        using JsonDocument configured = JsonDocument.Parse(await accepted.Content.ReadAsStringAsync());
        Assert.Equal(server.MetricsEndpoint, configured.RootElement.GetProperty("metricsEndpoint").GetString());
        Assert.False(configured.RootElement.TryGetProperty("captureNativeTelemetry", out _));
        await WaitForAsync(async token => JsonSerializer.Deserialize<TelemetrySnapshot>(
            await client.GetStringAsync(new Uri(viewer.Url, "api/telemetry"), token), ViewerConstants.JsonOptions)!,
            value => value.Metrics.Length > 0 && value.Spans.Length > 0);
        using HttpRequestMessage legacy = Configure(settingsEndpoint, """{"meterSources":"*","activitySources":"*"}""");
        using HttpResponseMessage legacyResponse = await client.SendAsync(legacy);
        Assert.Equal(HttpStatusCode.OK, legacyResponse.StatusCode);
        using JsonDocument legacySettings = JsonDocument.Parse(await legacyResponse.Content.ReadAsStringAsync());
        Assert.Equal(server.MetricsEndpoint, legacySettings.RootElement.GetProperty("metricsEndpoint").GetString());
        viewer.Complete();
        using HttpRequestMessage completed = Configure(settingsEndpoint, """{"meterSources":"*","activitySources":"*","metricsEndpoint":"","tracesEndpoint":""}""");
        using HttpResponseMessage frozen = await client.SendAsync(completed);
        Assert.Equal(HttpStatusCode.Conflict, frozen.StatusCode);
    }

    [Fact]
    public async Task OptOutDoesNotMakeNetworkRequests()
    {
        await using TelemetryTestServer server = new();
        ConsoleLogViewerOptions options = Options(server);
        options.CaptureTelemetry = false;
        using TelemetryRecorder recorder = new(options.Validate());
        Assert.False(recorder.Snapshot().Enabled);
        Assert.False(recorder.GetSettings().CanConfigure);
        Assert.Empty(server.Requests);
    }

    [Fact]
    public async Task OversizedResponsesAndRedirectsAreVisibleAndNotFollowed()
    {
        await using TelemetryTestServer server = new() { MetricsBody = new string('x', TelemetryEndpointReader.MaximumResponseBytes + 1) };
        using TelemetryRecorder recorder = new(Options(server).Validate());
        TelemetrySnapshot snapshot = await WaitForAsync(recorder, value => value.MetricsEndpointError is not null);
        Assert.Contains("1 MiB", snapshot.MetricsEndpointError);
        Assert.Empty(snapshot.Metrics);
        server.StatusCode = 302;
        server.RedirectLocation = new Uri(server.Url, "must-not-follow").AbsoluteUri;
        snapshot = await WaitForAsync(recorder, value => value.MetricsEndpointError?.Contains("302", StringComparison.Ordinal) == true);
        Assert.DoesNotContain("/must-not-follow", server.Requests);
    }

    [Fact]
    public async Task DisposalCancelsInFlightRequests()
    {
        await using TelemetryTestServer server = new() { DelayMilliseconds = 10000 };
        using TelemetryRecorder recorder = new(Options(server).Validate());
        await WaitForAsync(recorder, _ => !server.Requests.IsEmpty);
        await Task.Run(recorder.Dispose).WaitAsync(TimeSpan.FromSeconds(2));
        Assert.False(recorder.GetSettings().CanConfigure);
        Assert.Empty(recorder.Snapshot().Metrics);
        Assert.Empty(recorder.Snapshot().Spans);
    }

    private static ConsoleLogViewerOptions Options(TelemetryTestServer server) => new()
    {
        CaptureConsole = false,
        ApplicationName = "endpoint-tests",
        MeterSources = "Prometheus",
        ActivitySources = "Orders.Api",
        MetricsEndpoint = server.MetricsEndpoint,
        TracesEndpoint = server.TracesEndpoint,
        TelemetryIntervalMilliseconds = 100,
        TelemetryCapacity = 10,
    };

    private static HttpRequestMessage Configure(Uri endpoint, string body)
    {
        HttpRequestMessage request = new(HttpMethod.Post, endpoint) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        request.Headers.Add(ViewerConstants.ClearRequestHeader, ViewerConstants.TelemetryConfigureAction);
        return request;
    }

    private static Task<TelemetrySnapshot> WaitForAsync(TelemetryRecorder recorder, Func<TelemetrySnapshot, bool> ready) =>
        WaitForAsync(_ => Task.FromResult(recorder.Snapshot()), ready);

    private static async Task<TelemetrySnapshot> WaitForAsync(Func<CancellationToken, Task<TelemetrySnapshot>> read, Func<TelemetrySnapshot, bool> ready)
    {
        using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(8));
        while (true)
        {
            TelemetrySnapshot snapshot = await read(timeout.Token);
            if (ready(snapshot)) return snapshot;
            await Task.Delay(20, timeout.Token);
        }
    }
}

internal sealed class TelemetryTestServer : IAsyncDisposable
{
    private readonly HttpListener listener = new();
    private readonly CancellationTokenSource shutdown = new();
    private readonly Task serveTask;
    private string metricsBody = "orders_total 7\n";
    private string tracesBody = TelemetryEndpointTests.JaegerResponse;
    private int statusCode = 200;
    internal Uri Url { get; }
    internal string MetricsEndpoint => new Uri(this.Url, "unusual/metrics?group=orders").AbsoluteUri;
    internal string TracesEndpoint => new Uri(this.Url, "unusual/query?service=Orders").AbsoluteUri;
    internal ConcurrentQueue<string> Requests { get; } = new();
    internal string MetricsBody { get => Volatile.Read(ref this.metricsBody); set => Volatile.Write(ref this.metricsBody, value); }
    internal string TracesBody { get => Volatile.Read(ref this.tracesBody); set => Volatile.Write(ref this.tracesBody, value); }
    internal int StatusCode { get => Volatile.Read(ref this.statusCode); set => Volatile.Write(ref this.statusCode, value); }
    internal int DelayMilliseconds { get; set; }
    internal string? RedirectLocation { get; set; }
    internal TaskCompletionSource? ResponseGate { get; set; }

    internal TelemetryTestServer()
    {
        using TcpListener reservation = new(IPAddress.Loopback, 0);
        reservation.Start();
        int port = ((IPEndPoint)reservation.LocalEndpoint).Port;
        reservation.Stop();
        this.Url = new Uri($"http://127.0.0.1:{port}/");
        this.listener.Prefixes.Add(this.Url.AbsoluteUri);
        this.listener.Start();
        this.serveTask = this.ServeAsync();
    }

    private async Task ServeAsync()
    {
        try
        {
            while (!this.shutdown.IsCancellationRequested)
            {
                HttpListenerContext context = await this.listener.GetContextAsync();
                this.Requests.Enqueue(context.Request.RawUrl!);
                try
                {
                    if (this.ResponseGate is not null) await this.ResponseGate.Task.WaitAsync(this.shutdown.Token);
                    if (this.DelayMilliseconds > 0) await Task.Delay(this.DelayMilliseconds, this.shutdown.Token);
                    context.Response.StatusCode = this.StatusCode;
                    if (this.RedirectLocation is not null) context.Response.RedirectLocation = this.RedirectLocation;
                    byte[] bytes = Encoding.UTF8.GetBytes(context.Request.Url!.AbsolutePath.EndsWith("/metrics", StringComparison.Ordinal)
                        ? this.MetricsBody : this.TracesBody);
                    context.Response.ContentLength64 = bytes.Length;
                    await context.Response.OutputStream.WriteAsync(bytes, this.shutdown.Token);
                }
                catch (Exception exception) when (exception is IOException or HttpListenerException)
                {
                    // Cancellation tests deliberately disconnect before the response is written.
                }
                finally { context.Response.Close(); }
            }
        }
        catch (Exception exception) when (this.shutdown.IsCancellationRequested &&
            exception is OperationCanceledException or HttpListenerException or ObjectDisposedException) { }
    }

    public async ValueTask DisposeAsync()
    {
        this.shutdown.Cancel();
        this.listener.Close();
        await this.serveTask;
        this.shutdown.Dispose();
    }
}
