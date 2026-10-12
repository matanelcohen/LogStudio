using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Globalization;
using System.Linq;
using System.Threading;

namespace LogStudio;

internal sealed record TelemetryTag(string Key, string Value);
internal sealed record TelemetryLink(string TraceId, string SpanId);
internal sealed record TelemetryMetric(long Id, DateTimeOffset Timestamp, string Meter, string Name, string? Unit,
    string InstrumentType, double Value, TelemetryTag[] Tags);
internal sealed record TelemetrySpan(long Id, string Source, string Name, string TraceId, string SpanId,
    string ParentSpanId, DateTimeOffset StartTime, double DurationMilliseconds, string Kind, string Status,
    string? StatusDescription, TelemetryTag[] Tags, TelemetryLink[] Links);
internal sealed record TelemetrySnapshot(bool Enabled, TelemetryMetric[] Metrics, TelemetrySpan[] Spans,
    long DroppedMetrics, long DroppedSpans, int OmittedMetrics, int OmittedSpans, long SuppressedInstruments);
internal sealed record TelemetrySettings(string MeterSources, string ActivitySources, bool CanConfigure);

internal sealed class TelemetryRecorder : IDisposable
{
    internal const int MaximumSnapshotCount = 500;
    internal const int MaximumTags = 32;
    internal const int MaximumLinks = 16;
    internal const int MaximumStringLength = 256;
    internal const int MaximumRecordsPerInterval = 10000;
    internal const int MaximumInstruments = 1024;
    private readonly object gate = new();
    private readonly Queue<TelemetryMetric> metrics = new();
    private readonly Queue<TelemetrySpan> spans = new();
    private readonly bool enabled;
    private readonly int capacity;
    private TelemetrySettings settings;
    private ListenerGeneration? generation;
    private int configuring;
    private Timer? timer;
    private int stopped;
    private int collecting;
    private long metricId;
    private long spanId;
    private long droppedMetrics;
    private long droppedSpans;
    private long suppressedInstruments;
    private readonly long budgetDurationTicks;
    private long budgetStart;
    private int metricBudget = MaximumRecordsPerInterval;
    private int spanBudget = MaximumRecordsPerInterval;

    internal TelemetryRecorder(ViewerSettings settings)
    {
        this.enabled = settings.CaptureTelemetry;
        this.capacity = settings.TelemetryCapacity;
        this.budgetDurationTicks = (long)settings.TelemetryIntervalMilliseconds * Stopwatch.Frequency / 1000;
        this.budgetStart = Stopwatch.GetTimestamp();
        this.settings = new(settings.MeterSources, settings.ActivitySources, this.enabled);
        if (!this.enabled) return;
        try
        {
            this.Configure(settings.MeterSources, settings.ActivitySources);
            this.timer = new Timer(_ => this.CollectObservables(), null,
                settings.TelemetryIntervalMilliseconds, settings.TelemetryIntervalMilliseconds);
        }
        catch
        {
            this.Dispose();
            throw;
        }
    }

    internal TelemetrySettings GetSettings()
    {
        lock (this.gate) return this.settings with { CanConfigure = this.enabled && this.stopped == 0 };
    }

    internal TelemetrySettings Configure(string meterSources, string activitySources)
    {
        ValidatePatterns(meterSources, nameof(meterSources));
        ValidatePatterns(activitySources, nameof(activitySources));
        // Never wait for configuration: subscription notifications can reenter the recorder.
        if (Interlocked.CompareExchange(ref this.configuring, 1, 0) != 0)
            throw new InvalidOperationException("Telemetry configuration is already changing; try again.");
        ListenerGeneration? next = null;
        try
        {
            next = new ListenerGeneration(this, meterSources, activitySources);
            ListenerGeneration? previous;
            lock (this.gate)
            {
                if (!this.enabled || this.stopped != 0)
                    throw new InvalidOperationException("Telemetry filters can only be changed while telemetry capture is enabled and the current run is active.");
                previous = this.generation;
                this.generation = null;
            }
            // Detach before rediscovery; no recorder locks are held across native listener calls.
            previous?.Dispose();
            lock (this.gate)
            {
                if (this.stopped != 0)
                    throw new InvalidOperationException("The current run has completed; telemetry filters cannot be changed.");
                this.settings = new(meterSources, activitySources, true);
                this.generation = next;
            }
            next.Meter.Start();
            if (this.IsCurrent(next)) ActivitySource.AddActivityListener(next.Activity);
            if (!this.IsCurrent(next))
                throw new InvalidOperationException("The current run has completed; telemetry filters cannot be changed.");
            return this.GetSettings();
        }
        catch
        {
            if (next is not null)
            {
                if (this.IsCurrent(next)) this.Dispose();
                next.Dispose();
            }
            throw;
        }
        finally
        {
            Volatile.Write(ref this.configuring, 0);
        }
    }

    private bool IsCurrent(ListenerGeneration candidate) =>
        Volatile.Read(ref this.stopped) == 0 && ReferenceEquals(Volatile.Read(ref this.generation), candidate);

    private sealed class Subscription(ListenerGeneration generation)
    {
        internal readonly ListenerGeneration Generation = generation;
        internal bool Released;
    }

    private sealed class ListenerGeneration : IDisposable
    {
        internal readonly string[] MeterPatterns;
        internal readonly string[] ActivityPatterns;
        internal readonly MeterListener Meter;
        internal readonly ActivityListener Activity;
        internal int Instruments;

        internal ListenerGeneration(TelemetryRecorder owner, string meters, string activities)
        {
            this.MeterPatterns = ParsePatterns(meters);
            this.ActivityPatterns = ParsePatterns(activities);
            this.Meter = new MeterListener
            {
                InstrumentPublished = (instrument, listener) => owner.Subscribe(this, instrument, listener),
                MeasurementsCompleted = (_, state) =>
                {
                    if (state is Subscription subscription) owner.Release(subscription);
                },
            };
            this.Meter.SetMeasurementEventCallback<byte>(owner.Measurement);
            this.Meter.SetMeasurementEventCallback<short>(owner.Measurement);
            this.Meter.SetMeasurementEventCallback<int>(owner.Measurement);
            this.Meter.SetMeasurementEventCallback<long>(owner.Measurement);
            this.Meter.SetMeasurementEventCallback<float>(owner.Measurement);
            this.Meter.SetMeasurementEventCallback<double>(owner.Measurement);
            this.Meter.SetMeasurementEventCallback<decimal>(owner.Measurement);
            this.Activity = new ActivityListener
            {
                ShouldListenTo = source => owner.IsCurrent(this) && Matches(source.Name, this.ActivityPatterns),
                Sample = (ref ActivityCreationOptions<ActivityContext> options) => owner.Sampling(this, options.Source.Name),
                SampleUsingParentId = (ref ActivityCreationOptions<string> options) => owner.Sampling(this, options.Source.Name),
                ActivityStopped = owner.ActivityStopped,
            };
        }

        public void Dispose()
        {
            this.Activity.Dispose();
            this.Meter.Dispose();
        }
    }

    private void Release(Subscription subscription)
    {
        lock (this.gate)
        {
            if (subscription.Released) return;
            subscription.Released = true;
            subscription.Generation.Instruments--;
        }
    }

    private void Subscribe(ListenerGeneration candidate, Instrument instrument, MeterListener listener)
    {
        Subscription? subscription = null;
        try
        {
            lock (this.gate)
            {
                if (!this.IsCurrent(candidate) || !Matches(instrument.Meter.Name, candidate.MeterPatterns)) return;
                if (candidate.Instruments == MaximumInstruments)
                {
                    this.suppressedInstruments++;
                    return;
                }
                subscription = new(candidate);
                candidate.Instruments++;
            }
            listener.EnableMeasurementEvents(instrument, subscription);
            if (!this.IsCurrent(candidate))
            {
                listener.DisableMeasurementEvents(instrument);
                this.Release(subscription);
            }
        }
        catch (Exception)
        {
            if (subscription is not null) this.Release(subscription);
            this.DropMetric();
        }
    }

    internal static void ValidatePatterns(string patterns, string parameterName)
    {
        ArgumentNullException.ThrowIfNull(patterns, parameterName);
        if (patterns.Length > 4096 || patterns.Split(',').Length > 64)
            throw new ArgumentException("Source patterns must contain at most 4096 characters and 64 comma-separated patterns.", parameterName);
    }

    private static string[] ParsePatterns(string patterns) =>
        patterns.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);

    private static bool Matches(string name, string[] patterns)
    {
        foreach (string pattern in patterns)
        {
            int index = 0, position = 0, star = -1, retry = 0;
            while (position < name.Length)
            {
                if (index < pattern.Length && (pattern[index] == '?' || pattern[index] == name[position]))
                {
                    index++;
                    position++;
                }
                else if (index < pattern.Length && pattern[index] == '*')
                {
                    star = index++;
                    retry = position;
                }
                else if (star >= 0)
                {
                    index = star + 1;
                    position = ++retry;
                }
                else break;
            }
            while (index < pattern.Length && pattern[index] == '*') index++;
            if (position == name.Length && index == pattern.Length) return true;
        }
        return false;
    }

    private ActivitySamplingResult Sampling(ListenerGeneration candidate, string source) =>
        this.IsCurrent(candidate) && Matches(source, candidate.ActivityPatterns)
        ? ActivitySamplingResult.AllData : ActivitySamplingResult.None;

    private void Measurement<T>(Instrument instrument, T measurement, ReadOnlySpan<KeyValuePair<string, object?>> tags, object? state)
        where T : struct
    {
        if (state is not Subscription subscription ||
            !this.TryCapture(metric: true, instrument.Meter.Name, subscription.Generation)) return;
        try
        {
            double value = Convert.ToDouble(measurement, CultureInfo.InvariantCulture);
            if (!double.IsFinite(value))
            {
                this.DropMetric();
                return;
            }
            TelemetryTag[] capturedTags = new TelemetryTag[Math.Min(tags.Length, MaximumTags)];
            for (int index = 0; index < capturedTags.Length; index++)
                capturedTags[index] = Tag(tags[index]);
            TelemetryMetric metric = new(0, DateTimeOffset.UtcNow, Bound(instrument.Meter.Name), Bound(instrument.Name),
                instrument.Unit is null ? null : Bound(instrument.Unit), Bound(instrument.GetType().Name.Split('`')[0]), value, capturedTags);
            lock (this.gate)
            {
                if (!this.IsCurrent(subscription.Generation) || !Matches(instrument.Meter.Name, subscription.Generation.MeterPatterns)) return;
                if (this.metrics.Count == this.capacity)
                {
                    this.metrics.Dequeue();
                    this.droppedMetrics++;
                }
                this.metrics.Enqueue(metric with { Id = ++this.metricId });
            }
        }
        catch (Exception)
        {
            this.DropMetric();
        }
    }

    private void ActivityStopped(Activity activity)
    {
        if (!this.TryCapture(metric: false, activity.Source.Name)) return;
        try
        {
            TelemetryTag[] tags = activity.TagObjects.Take(MaximumTags).Select(Tag).ToArray();
            TelemetryLink[] links = activity.Links.Take(MaximumLinks)
                .Select(link => new TelemetryLink(link.Context.TraceId.ToHexString(), link.Context.SpanId.ToHexString())).ToArray();
            TelemetrySpan span = new(0, Bound(activity.Source.Name), Bound(activity.DisplayName),
                activity.TraceId.ToHexString(), activity.SpanId.ToHexString(), activity.ParentSpanId.ToHexString(),
                new DateTimeOffset(activity.StartTimeUtc), activity.Duration.TotalMilliseconds, activity.Kind.ToString(),
                activity.Status.ToString(), activity.StatusDescription is null ? null : Bound(activity.StatusDescription), tags, links);
            lock (this.gate)
            {
                if (this.stopped != 0 || this.generation is null ||
                    !Matches(activity.Source.Name, this.generation.ActivityPatterns)) return;
                if (this.spans.Count == this.capacity)
                {
                    this.spans.Dequeue();
                    this.droppedSpans++;
                }
                this.spans.Enqueue(span with { Id = ++this.spanId });
            }
        }
        catch (Exception)
        {
            lock (this.gate)
            {
                if (this.stopped == 0) this.droppedSpans++;
            }
        }
    }

    private static TelemetryTag Tag(KeyValuePair<string, object?> tag) => new(Bound(tag.Key), Bound(TagValue(tag.Value)));

    private static string TagValue(object? value) => value switch
    {
        null => string.Empty,
        string text => text,
        bool or byte or sbyte or short or ushort or int or uint or long or ulong or float or double or decimal or char or Guid or DateTime or DateTimeOffset or TimeSpan
            => Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty,
        // Never call application-defined ToString from a listener callback.
        _ => value.GetType().FullName ?? string.Empty,
    };

    private static string Bound(string value) => value.Length <= MaximumStringLength ? value : value[..MaximumStringLength];

    internal void CollectObservables()
    {
        if (!this.enabled || Volatile.Read(ref this.stopped) != 0 || Interlocked.CompareExchange(ref this.collecting, 1, 0) != 0) return;
        try
        {
            if (Volatile.Read(ref this.stopped) == 0)
                Volatile.Read(ref this.generation)?.Meter.RecordObservableInstruments();
        }
        catch (Exception)
        {
            this.DropMetric();
        }
        finally
        {
            Volatile.Write(ref this.collecting, 0);
        }
    }

    private void DropMetric()
    {
        lock (this.gate)
        {
            if (this.stopped == 0) this.droppedMetrics++;
        }
    }

    private bool TryCapture(bool metric, string source, ListenerGeneration? candidate = null)
    {
        if (Volatile.Read(ref this.stopped) != 0) return false;
        lock (this.gate)
        {
            if (this.stopped != 0 || this.generation is null ||
                (metric && !ReferenceEquals(this.generation, candidate)) ||
                !Matches(source, metric ? this.generation.MeterPatterns : this.generation.ActivityPatterns)) return false;
            this.ResetBudget();
            if (metric)
            {
                if (this.metricBudget > 0)
                {
                    this.metricBudget--;
                    return true;
                }
                this.droppedMetrics++;
            }
            else
            {
                if (this.spanBudget > 0)
                {
                    this.spanBudget--;
                    return true;
                }
                this.droppedSpans++;
            }
            return false;
        }
    }

    private void ResetBudget()
    {
        long now = Stopwatch.GetTimestamp();
        if (now - this.budgetStart < this.budgetDurationTicks) return;
        this.budgetStart = now;
        this.metricBudget = MaximumRecordsPerInterval;
        this.spanBudget = MaximumRecordsPerInterval;
    }

    internal TelemetrySnapshot Snapshot()
    {
        lock (this.gate)
        {
            return new TelemetrySnapshot(this.enabled,
                this.metrics.TakeLast(MaximumSnapshotCount).ToArray(), this.spans.TakeLast(MaximumSnapshotCount).ToArray(),
                this.droppedMetrics, this.droppedSpans, Math.Max(0, this.metrics.Count - MaximumSnapshotCount),
                Math.Max(0, this.spans.Count - MaximumSnapshotCount), this.suppressedInstruments);
        }
    }

    public void Dispose()
    {
        ListenerGeneration? previous;
        lock (this.gate)
        {
            if (this.stopped != 0) return;
            Volatile.Write(ref this.stopped, 1);
            previous = this.generation;
            this.generation = null;
        }
        // In-flight application observables are not awaited and run without any viewer/recorder locks.
        this.timer?.Dispose();
        previous?.Dispose();
    }
}
