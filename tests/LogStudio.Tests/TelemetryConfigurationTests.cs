using System;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace LogStudio.Tests;

public sealed class TelemetryConfigurationTests
{
    private static ConsoleLogViewerOptions Options(string sources = "Configure.First", int capacity = 2000) => new()
    {
        CaptureConsole = false,
        CaptureTelemetry = true,
        MeterSources = sources,
        ActivitySources = sources,
        TelemetryCapacity = capacity,
        TelemetryIntervalMilliseconds = 60000,
        ApplicationName = "telemetry-configuration-tests",
    };

    private static HttpRequestMessage Configure(Uri endpoint, string body)
    {
        HttpRequestMessage request = new(HttpMethod.Post, endpoint)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };
        request.Headers.Add(ViewerConstants.ClearRequestHeader, ViewerConstants.TelemetryConfigureAction);
        return request;
    }

    [Fact]
    public void ExistingAndNewNativeSubscriptionsChangeWithoutLosingHistory()
    {
        using Meter first = new("Configure.First");
        using Meter second = new("Configure.Second");
        Counter<int> firstCounter = first.CreateCounter<int>("first");
        Counter<int> secondCounter = second.CreateCounter<int>("second");
        using ActivitySource firstSource = new(first.Name);
        using ActivitySource secondSource = new(second.Name);
        using TelemetryRecorder recorder = new(Options(capacity: 2).Validate());
        firstCounter.Add(1);
        firstCounter.Add(2);
        firstCounter.Add(3);
        firstSource.StartActivity("retained")!.Dispose();
        using Activity? inFlight = firstSource.StartActivity("excluded-in-flight");
        Assert.NotNull(inFlight);
        Assert.False(secondCounter.Enabled);
        Assert.Null(secondSource.StartActivity("excluded"));
        TelemetrySnapshot before = recorder.Snapshot();
        recorder.Configure("Configure.Second,Configure.New", "Configure.Second,Configure.New");
        Assert.False(firstCounter.Enabled);
        Assert.True(secondCounter.Enabled);
        Assert.Null(firstSource.StartActivity("excluded"));
        firstCounter.Add(100);
        inFlight.Dispose();
        Assert.Equal(before, recorder.Snapshot() with { Metrics = before.Metrics, Spans = before.Spans });
        Assert.Equal(before.Metrics, recorder.Snapshot().Metrics);
        Assert.Equal(before.Spans, recorder.Snapshot().Spans);
        secondCounter.Add(4);
        secondSource.StartActivity("existing-source")!.Dispose();
        using Meter next = new("Configure.New");
        using ActivitySource nextSource = new(next.Name);
        next.CreateCounter<int>("new").Add(5);
        nextSource.StartActivity("new-source")!.Dispose();
        TelemetrySnapshot after = recorder.Snapshot();
        Assert.Equal(new double[] { 4, 5 }, after.Metrics.Select(metric => metric.Value));
        Assert.Equal(new long[] { 4, 5 }, after.Metrics.Select(metric => metric.Id));
        Assert.Equal(new long[] { 2, 3 }, after.Spans.Select(span => span.Id));
        Assert.Equal(3, after.DroppedMetrics);
        Assert.Equal(1, after.DroppedSpans);
        recorder.Configure(" \t , ", "");
        Assert.False(secondCounter.Enabled);
        Assert.Null(secondSource.StartActivity("empty"));
        Assert.Null(nextSource.StartActivity("empty-parent", ActivityKind.Server, $"00-{ActivityTraceId.CreateRandom()}-{ActivitySpanId.CreateRandom()}-00"));
        secondCounter.Add(1000);
        recorder.CollectObservables();
        Assert.Equal(after.Metrics, recorder.Snapshot().Metrics);
        Assert.Equal(after.Spans, recorder.Snapshot().Spans);
        recorder.Configure(first.Name, first.Name);
        Assert.True(firstCounter.Enabled);
        firstCounter.Add(6);
        firstSource.StartActivity("reenabled")!.Dispose();
        Assert.Equal(6, recorder.Snapshot().Metrics[^1].Id);
        Assert.Equal(4, recorder.Snapshot().Spans[^1].Id);
    }

    [Fact]
    public async Task BlockedOldObservableDoesNotLeakAndConfigurationDoesNotWaitOrOverlap()
    {
        using Meter meter = new("Configure.Blocked");
        using TelemetryRecorder recorder = new(Options(meter.Name).Validate());
        using ManualResetEventSlim entered = new();
        using ManualResetEventSlim release = new();
        int calls = 0;
        meter.CreateObservableGauge<int>("blocked", () =>
        {
            Interlocked.Increment(ref calls);
            entered.Set();
            release.Wait(TimeSpan.FromSeconds(10));
            return 7;
        });
        Task collection = Task.Run(recorder.CollectObservables);
        try
        {
            Assert.True(entered.Wait(TimeSpan.FromSeconds(5)));
            // Even replacing with identical filters invalidates the old metric callback generation.
            await Task.Run(() => recorder.Configure(meter.Name, meter.Name)).WaitAsync(TimeSpan.FromSeconds(2));
            recorder.CollectObservables();
            Assert.Equal(1, Volatile.Read(ref calls));
        }
        finally
        {
            release.Set();
            await collection.WaitAsync(TimeSpan.FromSeconds(5));
        }
        Assert.Empty(recorder.Snapshot().Metrics);
        recorder.CollectObservables();
        Assert.Equal(7, Assert.Single(recorder.Snapshot().Metrics).Value);
    }

    [Fact]
    public void ObservableCanReconfigureItsRecorderWithoutDeadlocking()
    {
        using Meter meter = new("Configure.Reentrant");
        using TelemetryRecorder recorder = new(Options(meter.Name).Validate());
        meter.CreateObservableGauge<int>("reconfigure", () =>
        {
            recorder.Configure("", "");
            return 1;
        });
        recorder.CollectObservables();
        Assert.Empty(recorder.Snapshot().Metrics);
        Assert.Equal(new TelemetrySettings("", "", true), recorder.GetSettings());
    }

    [Fact]
    public void MatchingInFlightSpansSurviveAndNarrowedSourcesDoNotUpgradeOtherListeners()
    {
        using ActivitySource kept = new("Configure.Kept");
        using ActivitySource excluded = new("Configure.Excluded");
        using ActivityListener other = new()
        {
            ShouldListenTo = source => source.Name == excluded.Name,
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.PropagationData,
            SampleUsingParentId = (ref ActivityCreationOptions<string> _) => ActivitySamplingResult.PropagationData,
        };
        ActivitySource.AddActivityListener(other);
        using TelemetryRecorder recorder = new(Options("Configure.*").Validate());
        using Activity? pending = kept.StartActivity("pending");
        Assert.NotNull(pending);
        recorder.Configure("", kept.Name);
        pending.Dispose();
        Assert.Equal("pending", Assert.Single(recorder.Snapshot().Spans).Name);
        using (Activity? activity = excluded.StartActivity("propagation"))
        {
            Assert.NotNull(activity);
            Assert.False(activity.IsAllDataRequested);
            Assert.False(activity.Recorded);
        }
        using (Activity? activity = excluded.StartActivity("parent", ActivityKind.Server,
            $"00-{ActivityTraceId.CreateRandom()}-{ActivitySpanId.CreateRandom()}-00"))
        {
            Assert.NotNull(activity);
            Assert.False(activity.IsAllDataRequested);
            Assert.False(activity.Recorded);
        }
        using (Activity? activity = kept.StartActivity("kept"))
        {
            Assert.NotNull(activity);
            Assert.True(activity.IsAllDataRequested);
            Assert.False(activity.Recorded);
        }
        Assert.Equal(new[] { "pending", "kept" }, recorder.Snapshot().Spans.Select(span => span.Name));
    }

    [Fact]
    public void BroadeningPreservesAnAlreadyStartedMatchingSpan()
    {
        using ActivitySource first = new("Configure.First");
        using ActivitySource second = new("Configure.Second");
        using TelemetryRecorder recorder = new(Options().Validate());
        using Activity? pending = first.StartActivity("started-before-broadening");
        Assert.NotNull(pending);
        Assert.Null(second.StartActivity("initially-excluded"));
        recorder.Configure("Configure.*", "Configure.*");
        pending.Dispose();
        second.StartActivity("newly-included")!.Dispose();
        Assert.Equal(new[] { "started-before-broadening", "newly-included" },
            recorder.Snapshot().Spans.Select(span => span.Name));
    }

    [Fact]
    public void InstrumentCapAndDisposedSlotsRemainBoundedAfterRediscovery()
    {
        using TelemetryRecorder recorder = new(Options("").Validate());
        using (Meter meter = new("Configure.Limit"))
        {
            Counter<int>[] counters = Enumerable.Range(0, TelemetryRecorder.MaximumInstruments + 3)
                .Select(index => meter.CreateCounter<int>($"counter-{index}")).ToArray();
            recorder.Configure(meter.Name, "");
            Assert.Equal(TelemetryRecorder.MaximumInstruments, counters.Count(counter => counter.Enabled));
            Assert.Equal(3, recorder.Snapshot().SuppressedInstruments);
            recorder.Configure("", "");
            Assert.All(counters, counter => Assert.False(counter.Enabled));
            recorder.Configure(meter.Name, "");
            Assert.Equal(TelemetryRecorder.MaximumInstruments, counters.Count(counter => counter.Enabled));
            Assert.Equal(6, recorder.Snapshot().SuppressedInstruments);
        }
        using Meter replacement = new("Configure.Limit");
        Counter<int> counter = replacement.CreateCounter<int>("replacement");
        Assert.True(counter.Enabled);
        counter.Add(9);
        Assert.Equal(9, Assert.Single(recorder.Snapshot().Metrics).Value);
    }

    [Fact]
    public async Task ConcurrentConfigurationAndDisposalCannotResurrectListeners()
    {
        for (int iteration = 0; iteration < 25; iteration++)
        {
            using Meter meter = new("Configure.Race");
            using ActivitySource source = new(meter.Name);
            Counter<int> counter = meter.CreateCounter<int>("counter");
            using TelemetryRecorder recorder = new(Options("").Validate());
            await Task.WhenAll(Task.Run(() =>
            {
                try { recorder.Configure(meter.Name, meter.Name); }
                catch (InvalidOperationException) { }
            }), Task.Run(recorder.Dispose));
            Assert.False(recorder.GetSettings().CanConfigure);
            Assert.False(counter.Enabled);
            Assert.Null(source.StartActivity("after-dispose"));
            Assert.Throws<InvalidOperationException>(() => recorder.Configure(meter.Name, meter.Name));
        }
    }

    [Fact]
    public async Task SettingsRoundtripPreservesExactStartupStringsAndSupportsEscapedMaximumPatterns()
    {
        const string startup = "  Configure.First, Other?  ";
        await using ConsoleLogViewer viewer = ConsoleLogViewer.Start(Options(startup));
        using HttpClient client = new();
        Uri endpoint = new(viewer.Url, ViewerConstants.TelemetrySettingsRoute);
        using JsonDocument initial = JsonDocument.Parse(await client.GetStringAsync(endpoint));
        Assert.Equal(startup, initial.RootElement.GetProperty("meterSources").GetString());
        Assert.Equal(startup, initial.RootElement.GetProperty("activitySources").GetString());
        Assert.True(initial.RootElement.GetProperty("canConfigure").GetBoolean());
        string maximum = new('\u0001', 4096);
        string body = JsonSerializer.Serialize(new { meterSources = maximum, activitySources = maximum });
        Assert.True(Encoding.UTF8.GetByteCount(body) > 32768);
        using HttpRequestMessage request = Configure(endpoint, body);
        using HttpResponseMessage response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using JsonDocument configured = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal(maximum, configured.RootElement.GetProperty("meterSources").GetString());
        Assert.Equal(maximum, configured.RootElement.GetProperty("activitySources").GetString());
        using JsonDocument current = JsonDocument.Parse(await client.GetStringAsync(endpoint));
        Assert.Equal(configured.RootElement.GetRawText(), current.RootElement.GetRawText());
        using HttpRequestMessage empty = Configure(endpoint, """{"meterSources":" ","activitySources":""}""");
        using HttpResponseMessage emptied = await client.SendAsync(empty);
        Assert.Equal(HttpStatusCode.OK, emptied.StatusCode);
    }

    [Theory]
    [InlineData("null")]
    [InlineData("[]")]
    [InlineData("{")]
    [InlineData("{}")]
    [InlineData("""{"meterSources":"*"}""")]
    [InlineData("""{"meterSources":null,"activitySources":"*"}""")]
    [InlineData("""{"meterSources":"*","activitySources":true}""")]
    [InlineData("""{"meterSources":"*","activitySources":42}""")]
    [InlineData("""{"meterSources":[],"activitySources":"*"}""")]
    [InlineData("""{"meterSources":"*","activitySources":"*","extra":""}""")]
    [InlineData("""{"meterSources":"*","meterSources":"","activitySources":"*"}""")]
    public async Task InvalidBodiesAreRejectedAtomically(string body)
    {
        await AssertInvalidBody(body);
    }

    [Fact]
    public async Task InvalidPatternsAreRejectedAtomically()
    {
        await AssertInvalidBody(JsonSerializer.Serialize(new { meterSources = "*", activitySources = new string('a', 4097) }));
        await AssertInvalidBody(JsonSerializer.Serialize(new { meterSources = new string(',', 64), activitySources = "*" }));
    }

    private static async Task AssertInvalidBody(string body)
    {
        using Meter meter = new("Configure.First");
        Counter<int> counter = meter.CreateCounter<int>("unchanged");
        using ActivitySource source = new(meter.Name);
        await using ConsoleLogViewer viewer = ConsoleLogViewer.Start(Options());
        using HttpClient client = new();
        Uri endpoint = new(viewer.Url, ViewerConstants.TelemetrySettingsRoute);
        string before = await client.GetStringAsync(endpoint);
        using HttpRequestMessage request = Configure(endpoint, body);
        using HttpResponseMessage response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(before, await client.GetStringAsync(endpoint));
        Assert.True(counter.Enabled);
        counter.Add(1);
        source.StartActivity("still-subscribed")!.Dispose();
        using JsonDocument telemetry = JsonDocument.Parse(await client.GetStringAsync(new Uri(viewer.Url, "api/telemetry")));
        Assert.Equal(1, telemetry.RootElement.GetProperty("metrics").GetArrayLength());
        Assert.Equal(1, telemetry.RootElement.GetProperty("spans").GetArrayLength());
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task CompletedOrDisabledCaptureCannotBeConfigured(bool complete)
    {
        ConsoleLogViewerOptions options = Options();
        options.CaptureTelemetry = complete;
        await using ConsoleLogViewer viewer = ConsoleLogViewer.Start(options);
        if (complete) viewer.Complete();
        using HttpClient client = new();
        Uri endpoint = new(viewer.Url, ViewerConstants.TelemetrySettingsRoute);
        string before = await client.GetStringAsync(endpoint);
        using JsonDocument settings = JsonDocument.Parse(before);
        Assert.False(settings.RootElement.GetProperty("canConfigure").GetBoolean());
        Assert.Equal(options.MeterSources, settings.RootElement.GetProperty("meterSources").GetString());
        Assert.Equal(options.ActivitySources, settings.RootElement.GetProperty("activitySources").GetString());
        using HttpRequestMessage request = Configure(endpoint, """{"meterSources":"*","activitySources":"*"}""");
        using HttpResponseMessage response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Contains("capture", await response.Content.ReadAsStringAsync(), StringComparison.OrdinalIgnoreCase);
        Assert.Equal(before, await client.GetStringAsync(endpoint));
    }

    [Fact]
    public async Task SettingsRouteRequiresSameSecurityExplicitActionAndKnownBoundedLength()
    {
        await using ConsoleLogViewer viewer = ConsoleLogViewer.Start(Options());
        using HttpClient client = new();
        Uri endpoint = new(viewer.Url, ViewerConstants.TelemetrySettingsRoute);
        using HttpResponseMessage wrongMethod = await client.PutAsync(endpoint, null);
        Assert.Equal(HttpStatusCode.MethodNotAllowed, wrongMethod.StatusCode);
        using HttpResponseMessage noAction = await client.PostAsync(endpoint, new StringContent("{}"));
        Assert.Equal(HttpStatusCode.Forbidden, noAction.StatusCode);
        using HttpRequestMessage wrongActionRequest = Configure(endpoint, "{}");
        wrongActionRequest.Headers.Remove(ViewerConstants.ClearRequestHeader);
        wrongActionRequest.Headers.Add(ViewerConstants.ClearRequestHeader, "clear");
        using HttpResponseMessage wrongAction = await client.SendAsync(wrongActionRequest);
        Assert.Equal(HttpStatusCode.Forbidden, wrongAction.StatusCode);
        using HttpRequestMessage foreign = Configure(endpoint, """{"meterSources":"*","activitySources":"*"}""");
        foreign.Headers.Add(ViewerConstants.OriginHeader, "http://evil.example");
        using HttpResponseMessage foreignResponse = await client.SendAsync(foreign);
        Assert.Equal(HttpStatusCode.Forbidden, foreignResponse.StatusCode);
        using HttpRequestMessage foreignGet = new(HttpMethod.Get, endpoint);
        foreignGet.Headers.Add(ViewerConstants.OriginHeader, "http://evil.example");
        using HttpResponseMessage forbiddenGet = await client.SendAsync(foreignGet);
        Assert.Equal(HttpStatusCode.Forbidden, forbiddenGet.StatusCode);
        using HttpRequestMessage sameOrigin = Configure(endpoint, """{"meterSources":"*","activitySources":"*"}""");
        sameOrigin.Headers.Add(ViewerConstants.OriginHeader, viewer.Url.GetLeftPart(UriPartial.Authority));
        using HttpResponseMessage allowed = await client.SendAsync(sameOrigin);
        Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
        Uri missingToken = new(viewer.Url.GetLeftPart(UriPartial.Authority) + "/" + ViewerConstants.TelemetrySettingsRoute);
        using HttpRequestMessage missingPost = Configure(missingToken, "{}");
        using HttpResponseMessage missing = await client.SendAsync(missingPost);
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        using HttpResponseMessage missingGet = await client.GetAsync(missingToken);
        Assert.Equal(HttpStatusCode.NotFound, missingGet.StatusCode);
        using HttpResponseMessage savedGet = await client.GetAsync(new Uri(endpoint + "?sessionId=saved"));
        Assert.Equal(HttpStatusCode.BadRequest, savedGet.StatusCode);
        using HttpRequestMessage savedPost = Configure(new Uri(endpoint + "?sessionId=saved"), "{}");
        using HttpResponseMessage saved = await client.SendAsync(savedPost);
        Assert.Equal(HttpStatusCode.BadRequest, saved.StatusCode);
        using HttpResponseMessage emptySession = await client.GetAsync(new Uri(endpoint + "?sessionId="));
        Assert.Equal(HttpStatusCode.OK, emptySession.StatusCode);
        using HttpRequestMessage tooLarge = Configure(endpoint, new string(' ', ViewerConstants.MaximumTelemetrySettingsBytes + 1));
        using HttpResponseMessage oversized = await client.SendAsync(tooLarge);
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, oversized.StatusCode);
        using HttpRequestMessage unknownLength = Configure(endpoint, "{}");
        unknownLength.Headers.TransferEncodingChunked = true;
        using HttpResponseMessage chunked = await client.SendAsync(unknownLength);
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, chunked.StatusCode);
    }
}
