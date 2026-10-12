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
    private readonly string[] meterPatterns;
    private readonly string[] activityPatterns;
    private MeterListener? meterListener;
    private ActivityListener? activityListener;
    private Timer? timer;
    private int stopped;
    private int collecting;
    private long metricId;
    private long spanId;
    private long droppedMetrics;
    private long droppedSpans;
    private long suppressedInstruments;
    private int enabledInstruments;
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
        this.meterPatterns = ParsePatterns(settings.MeterSources);
        this.activityPatterns = ParsePatterns(settings.ActivitySources);
        if (!this.enabled) return;
        try
        {
            this.meterListener = new MeterListener
            {
                InstrumentPublished = (instrument, listener) =>
                {
                    try
                    {
                        if (Volatile.Read(ref this.stopped) != 0 || !Matches(instrument.Meter.Name, this.meterPatterns)) return;
                        lock (this.gate)
                        {
                            if (this.stopped != 0) return;
                            if (this.enabledInstruments == MaximumInstruments)
                            {
                                this.suppressedInstruments++;
                                return;
                            }
                            listener.EnableMeasurementEvents(instrument);
                            this.enabledInstruments++;
                        }
                    }
                    catch (Exception)
                    {
                        this.DropMetric();
                    }
                },
                MeasurementsCompleted = (_, _) =>
                {
                    lock (this.gate)
                    {
                        if (this.stopped == 0 && this.enabledInstruments > 0) this.enabledInstruments--;
                    }
                },
            };
            this.meterListener.SetMeasurementEventCallback<byte>(this.Measurement);
            this.meterListener.SetMeasurementEventCallback<short>(this.Measurement);
            this.meterListener.SetMeasurementEventCallback<int>(this.Measurement);
            this.meterListener.SetMeasurementEventCallback<long>(this.Measurement);
            this.meterListener.SetMeasurementEventCallback<float>(this.Measurement);
            this.meterListener.SetMeasurementEventCallback<double>(this.Measurement);
            this.meterListener.SetMeasurementEventCallback<decimal>(this.Measurement);
            this.meterListener.Start();
            this.activityListener = new ActivityListener
            {
                ShouldListenTo = source => Volatile.Read(ref this.stopped) == 0 && Matches(source.Name, this.activityPatterns),
                Sample = (ref ActivityCreationOptions<ActivityContext> _) => this.Sampling(),
                SampleUsingParentId = (ref ActivityCreationOptions<string> _) => this.Sampling(),
                ActivityStopped = this.ActivityStopped,
            };
            ActivitySource.AddActivityListener(this.activityListener);
            this.timer = new Timer(_ => this.CollectObservables(), null,
                settings.TelemetryIntervalMilliseconds, settings.TelemetryIntervalMilliseconds);
        }
        catch
        {
            this.Dispose();
            throw;
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

    private ActivitySamplingResult Sampling() => Volatile.Read(ref this.stopped) == 0
        ? ActivitySamplingResult.AllData : ActivitySamplingResult.None;

    private void Measurement<T>(Instrument instrument, T measurement, ReadOnlySpan<KeyValuePair<string, object?>> tags, object? state)
        where T : struct
    {
        if (!this.TryCapture(metric: true)) return;
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
                if (this.stopped != 0) return;
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
        if (!this.TryCapture(metric: false)) return;
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
                if (this.stopped != 0) return;
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
                this.meterListener?.RecordObservableInstruments();
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

    private bool TryCapture(bool metric)
    {
        if (Volatile.Read(ref this.stopped) != 0) return false;
        lock (this.gate)
        {
            if (this.stopped != 0) return false;
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
        lock (this.gate)
        {
            if (this.stopped != 0) return;
            Volatile.Write(ref this.stopped, 1);
        }
        // In-flight application observables are not awaited and run without any viewer/recorder locks.
        this.timer?.Dispose();
        this.activityListener?.Dispose();
        this.meterListener?.Dispose();
    }
}
