using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Reflection;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace LogStudio.Tests;

public sealed class TelemetryTests
{
    private static ConsoleLogViewerOptions Options(string source = "*", int capacity = 2000) => new()
    {
        CaptureConsole = false,
        CaptureTelemetry = true,
        MeterSources = source,
        ActivitySources = source,
        TelemetryCapacity = capacity,
        TelemetryIntervalMilliseconds = 60000,
        ApplicationName = "telemetry-tests",
    };

    [Fact]
    public void AllNumericInstrumentTypesAreCapturedAndNonfiniteValuesAreDropped()
    {
        using Meter meter = new("Telemetry.Numbers");
        using TelemetryRecorder recorder = new(Options(meter.Name).Validate());
        meter.CreateCounter<byte>("byte").Add(1);
        meter.CreateCounter<short>("short").Add(2);
        meter.CreateCounter<int>("int", "requests").Add(3);
        meter.CreateCounter<long>("long").Add(4);
        meter.CreateCounter<float>("float").Add(5.5f);
        meter.CreateCounter<double>("double").Add(6.5);
        meter.CreateCounter<decimal>("decimal").Add(7.5m);
        meter.CreateHistogram<double>("histogram").Record(8);
        meter.CreateUpDownCounter<int>("updown").Add(-9);
        Counter<double> invalid = meter.CreateCounter<double>("invalid");
        invalid.Add(double.NaN);
        invalid.Add(double.PositiveInfinity);
        invalid.Add(double.NegativeInfinity);
        TelemetrySnapshot snapshot = recorder.Snapshot();
        Assert.Equal(new double[] { 1, 2, 3, 4, 5.5, 6.5, 7.5, 8, -9 }, snapshot.Metrics.Select(metric => metric.Value));
        Assert.Equal("requests", snapshot.Metrics[2].Unit);
        Assert.Equal("Histogram", snapshot.Metrics[7].InstrumentType);
        Assert.Equal("UpDownCounter", snapshot.Metrics[8].InstrumentType);
        Assert.Equal(3, snapshot.DroppedMetrics);
        Assert.All(snapshot.Metrics, metric => Assert.InRange(metric.Timestamp, DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow));
    }

    [Fact]
    public void ExistingAndNewSourcesAndInstrumentsRespectCommaSeparatedWildcards()
    {
        using Meter existing = new("Test.Existing");
        Counter<int> oldCounter = existing.CreateCounter<int>("old");
        using ActivitySource oldSource = new("Test.Existing");
        using TelemetryRecorder recorder = new(Options(" Other, Test.Exist?ng, New.* ").Validate());
        oldCounter.Add(1);
        existing.CreateCounter<int>("new-instrument").Add(2);
        using Meter next = new("New.Source");
        next.CreateCounter<int>("new-source").Add(3);
        using Meter ignored = new("Ignored");
        ignored.CreateCounter<int>("ignored").Add(100);
        using ActivitySource newSource = new("New.Source");
        using ActivitySource ignoredSource = new("Ignored");
        oldSource.StartActivity("old")!.Dispose();
        newSource.StartActivity("new")!.Dispose();
        Assert.Null(ignoredSource.StartActivity("ignored"));
        Assert.Equal(new double[] { 1, 2, 3 }, recorder.Snapshot().Metrics.Select(metric => metric.Value));
        Assert.Equal(new[] { "old", "new" }, recorder.Snapshot().Spans.Select(span => span.Name));
    }

    [Fact]
    public void TagsStringsAndLinksAreBoundedAndCustomValuesAreNotInvoked()
    {
        string sourceName = new('s', 1000);
        using Meter meter = new(sourceName);
        using ActivitySource source = new(sourceName);
        using TelemetryRecorder recorder = new(Options().Validate());
        KeyValuePair<string, object?>[] tags = Enumerable.Range(0, 100)
            .Select(index => new KeyValuePair<string, object?>(new string('k', 1000) + index, new string('v', 1000))).ToArray();
        meter.CreateCounter<int>(new string('n', 1000), new string('u', 1000)).Add(1, tags);
        meter.CreateCounter<int>("custom").Add(2, new KeyValuePair<string, object?>("custom", new ThrowingValue()));
        ActivityContext link = new(ActivityTraceId.CreateRandom(), ActivitySpanId.CreateRandom(), ActivityTraceFlags.None);
        using (Activity? activity = source.StartActivity(new string('a', 1000), ActivityKind.Internal, default(ActivityContext),
            tags, Enumerable.Repeat(new ActivityLink(link), 100)))
        {
            Assert.NotNull(activity);
            activity.SetStatus(ActivityStatusCode.Error, new string('d', 1000));
        }
        TelemetrySnapshot snapshot = recorder.Snapshot();
        Assert.Equal(TelemetryRecorder.MaximumStringLength, snapshot.Metrics[0].Meter.Length);
        Assert.Equal(TelemetryRecorder.MaximumStringLength, snapshot.Metrics[0].Name.Length);
        Assert.Equal(TelemetryRecorder.MaximumStringLength, snapshot.Metrics[0].Unit!.Length);
        Assert.Equal(TelemetryRecorder.MaximumTags, snapshot.Metrics[0].Tags.Length);
        Assert.All(snapshot.Metrics[0].Tags, tag =>
        {
            Assert.Equal(TelemetryRecorder.MaximumStringLength, tag.Key.Length);
            Assert.Equal(TelemetryRecorder.MaximumStringLength, tag.Value.Length);
        });
        Assert.Contains(nameof(ThrowingValue), snapshot.Metrics[1].Tags[0].Value, StringComparison.Ordinal);
        TelemetrySpan span = Assert.Single(snapshot.Spans);
        Assert.Equal(TelemetryRecorder.MaximumTags, span.Tags.Length);
        Assert.Equal(TelemetryRecorder.MaximumLinks, span.Links.Length);
        Assert.Equal(TelemetryRecorder.MaximumStringLength, span.StatusDescription!.Length);
    }

    [Fact]
    public void ActivitiesPreserveParentsLinksStatusAndDurationWithoutForcingRecorded()
    {
        using ActivitySource source = new("Telemetry.Spans");
        using TelemetryRecorder recorder = new(Options(source.Name).Validate());
        ActivityContext parent = new(ActivityTraceId.CreateRandom(), ActivitySpanId.CreateRandom(), ActivityTraceFlags.None);
        ActivityContext link = new(ActivityTraceId.CreateRandom(), ActivitySpanId.CreateRandom(), ActivityTraceFlags.Recorded);
        string spanId;
        using (Activity? activity = source.StartActivity("child", ActivityKind.Client, parent,
            new[] { new KeyValuePair<string, object?>("answer", 42) }, new[] { new ActivityLink(link) }))
        {
            Assert.NotNull(activity);
            Assert.True(activity.IsAllDataRequested);
            Assert.False(activity.Recorded);
            spanId = activity.SpanId.ToHexString();
            activity.SetStatus(ActivityStatusCode.Error, "failed");
        }
        using (Activity? activity = source.StartActivity("string-parent", ActivityKind.Server,
            $"00-{parent.TraceId.ToHexString()}-{parent.SpanId.ToHexString()}-00"))
        {
            Assert.NotNull(activity);
            Assert.True(activity.IsAllDataRequested);
            Assert.False(activity.Recorded);
        }
        TelemetrySpan span = recorder.Snapshot().Spans[0];
        Assert.Equal(parent.TraceId.ToHexString(), span.TraceId);
        Assert.Equal(parent.SpanId.ToHexString(), span.ParentSpanId);
        Assert.Equal(spanId, span.SpanId);
        Assert.Equal("Client", span.Kind);
        Assert.Equal("Error", span.Status);
        Assert.Equal("failed", span.StatusDescription);
        Assert.Equal("42", Assert.Single(span.Tags).Value);
        Assert.Equal(link.TraceId.ToHexString(), Assert.Single(span.Links).TraceId);
        Assert.Equal(link.SpanId.ToHexString(), span.Links[0].SpanId);
        Assert.True(span.DurationMilliseconds >= 0);
        Assert.Equal(parent.SpanId.ToHexString(), recorder.Snapshot().Spans[1].ParentSpanId);
    }

    [Fact]
    public void ObservableMeasurementsAndExceptionsAreIsolated()
    {
        using Meter meter = new("Telemetry.Observable");
        using TelemetryRecorder recorder = new(Options(meter.Name).Validate());
        meter.CreateObservableGauge<int>("gauge", () => new Measurement<int>(12, new KeyValuePair<string, object?>("tag", "value")));
        meter.CreateObservableCounter<double>("counter", () => 13.5);
        meter.CreateObservableUpDownCounter<long>("updown", () => -14);
        meter.CreateObservableGauge<int>("bad", (Func<int>)(() => throw new InvalidOperationException("application failure")));
        recorder.CollectObservables();
        Assert.Equal(new double[] { 12, 13.5, -14 }, recorder.Snapshot().Metrics.Select(metric => metric.Value));
        Assert.Equal("value", recorder.Snapshot().Metrics[0].Tags[0].Value);
        Assert.True(recorder.Snapshot().DroppedMetrics >= 1);
        recorder.CollectObservables();
        Assert.Equal(6, recorder.Snapshot().Metrics.Length);
    }

    [Fact]
    public async Task TimerCollectsObservablesAndStopsAtCompletion()
    {
        using Meter meter = new("Telemetry.Timer");
        int calls = 0;
        meter.CreateObservableGauge<int>("timer", () => Interlocked.Increment(ref calls));
        ConsoleLogViewerOptions options = Options(meter.Name);
        options.TelemetryIntervalMilliseconds = 100;
        await using ConsoleLogViewer viewer = ConsoleLogViewer.Start(options);
        using HttpClient client = new();
        using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(10));
        while (true)
        {
            using JsonDocument current = JsonDocument.Parse(await client.GetStringAsync(new Uri(viewer.Url, "api/telemetry"), timeout.Token));
            if (current.RootElement.GetProperty("metrics").GetArrayLength() > 0) break;
            await Task.Delay(20, timeout.Token);
        }
        viewer.Complete();
        await Task.Delay(100, timeout.Token);
        int stoppedCalls = Volatile.Read(ref calls);
        await Task.Delay(250, timeout.Token);
        Assert.Equal(stoppedCalls, Volatile.Read(ref calls));
        using JsonDocument snapshot = JsonDocument.Parse(await client.GetStringAsync(new Uri(viewer.Url, "api/telemetry"), timeout.Token));
        Assert.True(snapshot.RootElement.GetProperty("enabled").GetBoolean());
        Assert.NotEqual(0, snapshot.RootElement.GetProperty("metrics").GetArrayLength());
    }

    [Fact]
    public async Task DisposalDoesNotWaitForBlockedApplicationObservables()
    {
        using Meter meter = new("Telemetry.Blocked");
        using TelemetryRecorder recorder = new(Options(meter.Name).Validate());
        using ManualResetEventSlim entered = new();
        using ManualResetEventSlim release = new();
        meter.CreateObservableGauge<int>("blocked", () =>
        {
            entered.Set();
            release.Wait(TimeSpan.FromSeconds(10));
            return 1;
        });
        Task collection = Task.Run(recorder.CollectObservables);
        try
        {
            Assert.True(entered.Wait(TimeSpan.FromSeconds(5)));
            await Task.Run(recorder.Dispose).WaitAsync(TimeSpan.FromSeconds(2));
        }
        finally
        {
            release.Set();
            await collection.WaitAsync(TimeSpan.FromSeconds(5));
        }
        Assert.Empty(recorder.Snapshot().Metrics);
    }

    [Fact]
    public void AnObservableCanStopItsOwnRecorderWithoutDeadlocking()
    {
        using Meter meter = new("Telemetry.Reentrant");
        using TelemetryRecorder recorder = new(Options(meter.Name).Validate());
        meter.CreateObservableGauge<int>("stop", () =>
        {
            recorder.Dispose();
            return 1;
        });
        recorder.CollectObservables();
        Assert.Empty(recorder.Snapshot().Metrics);
    }

    [Fact]
    public void FailedServerStartupDetachesTelemetryListeners()
    {
        using Meter meter = new("Telemetry.FailedStartup");
        Counter<int> counter = meter.CreateCounter<int>("counter");
        using ActivitySource source = new(meter.Name);
        using TcpListener occupied = new(IPAddress.Loopback, 0);
        occupied.Start();
        ConsoleLogViewerOptions options = Options(meter.Name);
        options.Port = ((IPEndPoint)occupied.LocalEndpoint).Port;
        Assert.Throws<HttpListenerException>(() => ConsoleLogViewer.Start(options));
        Assert.False(counter.Enabled);
        Assert.Null(source.StartActivity("after-failure"));
    }

    [Fact]
    public void FailedStartupAnnouncementDisposesTelemetryAndRestoresConsole()
    {
        using Meter meter = new("Telemetry.FailedAnnouncement");
        Counter<int> counter = meter.CreateCounter<int>("counter");
        using ActivitySource source = new(meter.Name);
        TextWriter original = Console.Error;
        using FailingWriter failing = new();
        try
        {
            Console.SetError(failing);
            TextWriter installed = Console.Error;
            TextWriter originalOut = Console.Out;
            ConsoleLogViewerOptions options = Options(meter.Name);
            options.CaptureConsole = true;
            Assert.Throws<IOException>(() => ConsoleLogViewer.Start(options));
            Assert.False(counter.Enabled);
            Assert.Null(source.StartActivity("after-failure"));
            Assert.Same(installed, Console.Error);
            Assert.Same(originalOut, Console.Out);
        }
        finally
        {
            Console.SetError(original);
        }
    }

    [Fact]
    public void BoundedBuffersEvictIndependentlyAndStopAcceptingMeasurements()
    {
        using Meter meter = new("Telemetry.Bounded");
        using ActivitySource source = new(meter.Name);
        using TelemetryRecorder recorder = new(Options(meter.Name, 2).Validate());
        Counter<int> counter = meter.CreateCounter<int>("counter");
        for (int index = 1; index <= 5; index++) counter.Add(index);
        for (int index = 1; index <= 4; index++) source.StartActivity($"span-{index}")!.Dispose();
        TelemetrySnapshot snapshot = recorder.Snapshot();
        Assert.Equal(new long[] { 4, 5 }, snapshot.Metrics.Select(metric => metric.Id));
        Assert.Equal(new long[] { 3, 4 }, snapshot.Spans.Select(span => span.Id));
        Assert.Equal(3, snapshot.DroppedMetrics);
        Assert.Equal(2, snapshot.DroppedSpans);
        using Activity? pending = source.StartActivity("pending");
        recorder.Dispose();
        counter.Add(6);
        pending!.Dispose();
        recorder.CollectObservables();
        Assert.Equal(snapshot.DroppedMetrics, recorder.Snapshot().DroppedMetrics);
        Assert.Equal(snapshot.DroppedSpans, recorder.Snapshot().DroppedSpans);
        Assert.Equal(new long[] { 4, 5 }, recorder.Snapshot().Metrics.Select(metric => metric.Id));
        Assert.Equal(new long[] { 3, 4 }, recorder.Snapshot().Spans.Select(span => span.Id));
    }

    [Fact]
    public void HighRateSignalsHaveSeparatePerIntervalCaptureBudgetsAndDiscloseDrops()
    {
        using Meter meter = new("Telemetry.RateLimited");
        using ActivitySource source = new(meter.Name);
        using TelemetryRecorder recorder = new(Options(meter.Name, 2).Validate());
        Counter<int> counter = meter.CreateCounter<int>("counter");
        int records = TelemetryRecorder.MaximumRecordsPerInterval + 25;
        for (int index = 1; index <= records; index++)
        {
            counter.Add(index);
            source.StartActivity("span")!.Dispose();
        }
        TelemetrySnapshot snapshot = recorder.Snapshot();
        Assert.Equal(TelemetryRecorder.MaximumRecordsPerInterval, snapshot.Metrics[^1].Id);
        Assert.Equal(TelemetryRecorder.MaximumRecordsPerInterval, snapshot.Spans[^1].Id);
        Assert.Equal(records - 2, snapshot.DroppedMetrics);
        Assert.Equal(records - 2, snapshot.DroppedSpans);
    }

    [Fact]
    public async Task CaptureBudgetsResetAfterTheConfiguredInterval()
    {
        using Meter meter = new("Telemetry.BudgetReset");
        ConsoleLogViewerOptions options = Options(meter.Name, 1);
        options.TelemetryIntervalMilliseconds = 1000;
        using TelemetryRecorder recorder = new(options.Validate());
        Counter<int> counter = meter.CreateCounter<int>("counter");
        for (int index = 0; index <= TelemetryRecorder.MaximumRecordsPerInterval; index++) counter.Add(index);
        Assert.Equal(TelemetryRecorder.MaximumRecordsPerInterval, Assert.Single(recorder.Snapshot().Metrics).Id);
        await Task.Delay(1100);
        counter.Add(42);
        Assert.Equal(TelemetryRecorder.MaximumRecordsPerInterval + 1, Assert.Single(recorder.Snapshot().Metrics).Id);
        Assert.Equal(42, recorder.Snapshot().Metrics[0].Value);
    }

    [Fact]
    public void EnabledInstrumentCountIsBoundedAndDisposalReleasesSlots()
    {
        using TelemetryRecorder recorder = new(Options("Telemetry.InstrumentLimit", 2).Validate());
        using (Meter meter = new("Telemetry.InstrumentLimit"))
        {
            for (int index = 0; index < TelemetryRecorder.MaximumInstruments + 3; index++)
                meter.CreateCounter<int>($"counter-{index}").Add(1);
            Assert.Equal(3, recorder.Snapshot().SuppressedInstruments);
            Assert.Equal(TelemetryRecorder.MaximumInstruments, recorder.Snapshot().Metrics[^1].Id);
        }
        using Meter replacement = new("Telemetry.InstrumentLimit");
        Counter<int> counter = replacement.CreateCounter<int>("replacement");
        Assert.True(counter.Enabled);
        counter.Add(42);
        Assert.Equal(42, recorder.Snapshot().Metrics[^1].Value);
        Assert.Equal(3, recorder.Snapshot().SuppressedInstruments);
    }

    [Fact]
    public void UnrelatedSourcesAreNotEnabledOrUpgradedByTelemetrySampling()
    {
        using ActivityListener other = new()
        {
            ShouldListenTo = source => source.Name == "Unrelated.Source",
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.PropagationData,
            SampleUsingParentId = (ref ActivityCreationOptions<string> _) => ActivitySamplingResult.PropagationData,
        };
        ActivitySource.AddActivityListener(other);
        using Meter meter = new("Unrelated.Source");
        using ActivitySource source = new(meter.Name);
        using TelemetryRecorder recorder = new(Options("Selected.*").Validate());
        Counter<int> counter = meter.CreateCounter<int>("counter");
        Assert.False(counter.Enabled);
        counter.Add(1);
        using (Activity? activity = source.StartActivity("span"))
        {
            Assert.NotNull(activity);
            Assert.False(activity.IsAllDataRequested);
            Assert.False(activity.Recorded);
        }
        using (Activity? activity = source.StartActivity("span-parent", ActivityKind.Server,
            $"00-{ActivityTraceId.CreateRandom().ToHexString()}-{ActivitySpanId.CreateRandom().ToHexString()}-00"))
        {
            Assert.NotNull(activity);
            Assert.False(activity.IsAllDataRequested);
            Assert.False(activity.Recorded);
        }
        Assert.Empty(recorder.Snapshot().Metrics);
        Assert.Empty(recorder.Snapshot().Spans);
    }

    [Fact]
    public async Task EndpointReturnsNewestFiveHundredWithExplicitOmissionsAndNoLogEntries()
    {
        using Meter meter = new("Telemetry.Window");
        using ActivitySource source = new(meter.Name);
        await using ConsoleLogViewer viewer = ConsoleLogViewer.Start(Options(meter.Name, 600));
        Counter<int> counter = meter.CreateCounter<int>("counter");
        for (int index = 1; index <= 650; index++)
        {
            counter.Add(index);
            source.StartActivity("span")!.Dispose();
        }
        using HttpClient client = new();
        using JsonDocument snapshot = JsonDocument.Parse(await client.GetStringAsync(new Uri(viewer.Url, "api/telemetry")));
        JsonElement root = snapshot.RootElement;
        foreach (string signal in new[] { "metrics", "spans" })
        {
            Assert.Equal(500, root.GetProperty(signal).GetArrayLength());
            Assert.Equal(151, root.GetProperty(signal)[0].GetProperty("id").GetInt64());
            Assert.Equal(650, root.GetProperty(signal)[499].GetProperty("id").GetInt64());
        }
        Assert.Equal(50, root.GetProperty("droppedMetrics").GetInt64());
        Assert.Equal(50, root.GetProperty("droppedSpans").GetInt64());
        Assert.Equal(100, root.GetProperty("omittedMetrics").GetInt32());
        Assert.Equal(100, root.GetProperty("omittedSpans").GetInt32());
        Assert.Empty(viewer.GetLogs());
    }

    [Fact]
    public async Task DisabledByDefaultAndEndpointUsesExistingSecurityAndGetOnly()
    {
        ConsoleLogViewerOptions options = Options();
        options.CaptureTelemetry = false;
        Assert.False(new ConsoleLogViewerOptions().CaptureTelemetry);
        using Meter meter = new("Telemetry.Disabled");
        using ActivitySource source = new(meter.Name);
        await using ConsoleLogViewer viewer = ConsoleLogViewer.Start(options);
        meter.CreateCounter<int>("counter").Add(1);
        Assert.Null(source.StartActivity("ignored"));
        using HttpClient client = new();
        Uri endpoint = new(viewer.Url, "api/telemetry");
        using JsonDocument snapshot = JsonDocument.Parse(await client.GetStringAsync(endpoint));
        Assert.False(snapshot.RootElement.GetProperty("enabled").GetBoolean());
        Assert.Equal(0, snapshot.RootElement.GetProperty("metrics").GetArrayLength());
        Assert.Equal(0, snapshot.RootElement.GetProperty("spans").GetArrayLength());
        Assert.Equal(0, snapshot.RootElement.GetProperty("droppedMetrics").GetInt64());
        using HttpRequestMessage foreign = new(HttpMethod.Get, endpoint);
        foreign.Headers.Add("Origin", "http://evil.example");
        using HttpResponseMessage forbidden = await client.SendAsync(foreign);
        Assert.Equal(HttpStatusCode.Forbidden, forbidden.StatusCode);
        using HttpRequestMessage sameOrigin = new(HttpMethod.Get, endpoint);
        sameOrigin.Headers.Add("Origin", viewer.Url.GetLeftPart(UriPartial.Authority));
        using HttpResponseMessage allowed = await client.SendAsync(sameOrigin);
        Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
        using HttpResponseMessage missing = await client.GetAsync(viewer.Url.GetLeftPart(UriPartial.Authority) + "/api/telemetry");
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        using HttpResponseMessage post = await client.PostAsync(endpoint, null);
        Assert.Equal(HttpStatusCode.MethodNotAllowed, post.StatusCode);
        using HttpResponseMessage saved = await client.GetAsync(new Uri(viewer.Url, "api/telemetry?sessionId=saved"));
        Assert.Equal(HttpStatusCode.BadRequest, saved.StatusCode);
        using HttpResponseMessage empty = await client.GetAsync(new Uri(viewer.Url, "api/telemetry?sessionId="));
        Assert.Equal(HttpStatusCode.OK, empty.StatusCode);
    }

    [Theory]
    [InlineData(99, 2000)]
    [InlineData(60001, 2000)]
    [InlineData(1000, 0)]
    [InlineData(1000, 10001)]
    public void InvalidTelemetryLimitsFailEvenWhenCaptureIsDisabled(int interval, int capacity)
    {
        ConsoleLogViewerOptions options = Options();
        options.CaptureTelemetry = false;
        options.TelemetryIntervalMilliseconds = interval;
        options.TelemetryCapacity = capacity;
        Assert.Throws<ArgumentOutOfRangeException>(() => options.Validate());
    }

    [Fact]
    public void PatternAndBoundaryValidationIsExplicit()
    {
        ConsoleLogViewerOptions options = Options(string.Empty, 1);
        options.TelemetryIntervalMilliseconds = 100;
        options.Validate();
        options.TelemetryIntervalMilliseconds = 60000;
        options.TelemetryCapacity = 10000;
        options.Validate();
        options.MeterSources = null!;
        Assert.Throws<ArgumentNullException>(() => options.Validate());
        options.MeterSources = new string('a', 4097);
        Assert.Throws<ArgumentException>(() => options.Validate());
        options.MeterSources = "*";
        options.ActivitySources = new string(',', 64);
        Assert.Throws<ArgumentException>(() => options.Validate());
    }

    [Fact]
    public async Task StartupHookTelemetryWorksWithOnlyLogStudioDllDeployed()
    {
        string directory = Path.Combine(Environment.CurrentDirectory, "telemetry-hook-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        string hook = Path.Combine(directory, "LogStudio.dll");
        File.Copy(typeof(ConsoleLogViewer).Assembly.Location, hook);
        string demo = typeof(TelemetryTests).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
            .Single(attribute => attribute.Key == "DemoPath").Value!;
        ProcessStartInfo info = new("dotnet") { RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        foreach (string argument in new[] { demo, "--count", "0", "--interactive" }) info.ArgumentList.Add(argument);
        info.Environment["DOTNET_STARTUP_HOOKS"] = hook;
        info.Environment["LOG_STUDIO_TELEMETRY"] = "true";
        info.Environment["LOG_STUDIO_METER_SOURCES"] = "System.*,Microsoft.*";
        info.Environment["LOG_STUDIO_ACTIVITY_SOURCES"] = "System.*,Microsoft.*";
        info.Environment["LOG_STUDIO_TELEMETRY_INTERVAL_MS"] = "100";
        info.Environment["LOG_STUDIO_TELEMETRY_CAPACITY"] = "2";
        info.Environment["LOG_STUDIO_OPEN"] = "false";
        info.Environment["LOG_STUDIO_PORT"] = "0";
        using Process process = Process.Start(info)!;
        Task<string> output = process.StandardOutput.ReadToEndAsync();
        try
        {
            using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(15));
            string? line;
            Uri? url = null;
            while ((line = await process.StandardError.ReadLineAsync(timeout.Token)) is not null)
            {
                if (!line.StartsWith("Log Studio: ", StringComparison.Ordinal)) continue;
                url = new Uri(line["Log Studio: ".Length..]);
                break;
            }
            Assert.NotNull(url);
            using HttpClient client = new();
            using JsonDocument snapshot = JsonDocument.Parse(await client.GetStringAsync(new Uri(url, "api/telemetry"), timeout.Token));
            Assert.True(snapshot.RootElement.GetProperty("enabled").GetBoolean());
            await process.StandardInput.WriteLineAsync("done");
            process.StandardInput.Close();
            await process.WaitForExitAsync(timeout.Token);
            Assert.Equal(0, process.ExitCode);
            await output;
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync();
            }
            Directory.Delete(directory, recursive: true);
        }
    }

    private sealed class ThrowingValue
    {
        public override string ToString() => throw new InvalidOperationException("Must not call application code.");
    }

    private sealed class FailingWriter : StringWriter
    {
        public override void WriteLine(string? value) => throw new IOException("startup announcement failed");
    }
}
