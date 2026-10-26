using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace LogStudio.Tests;

public sealed class ComparisonTests
{
    private static readonly DateTimeOffset StartTime = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task ExactGroupsIncludeEveryChangeAndPreserveSeverityCategoryAndOriginalEvidence()
    {
        using Fixture fixture = new();
        string baseline = fixture.Save(new[]
        {
            Entry("stable", LogSeverity.Information, "service"),
            Entry("changing", LogSeverity.Warning, "service"), Entry("changing", LogSeverity.Warning, "service"),
            Entry("resolved", LogSeverity.Error), Entry("duplicate", LogSeverity.Error, ""), Entry("duplicate", LogSeverity.Error, ""),
            Entry("gone", LogSeverity.Trace, "gone"),
        });
        string candidate = fixture.Save(new[]
        {
            Entry("duplicate", LogSeverity.Error, ""), Entry("new", LogSeverity.Critical, "fresh"),
            Entry("changing", LogSeverity.Warning, "service"), Entry("stable", LogSeverity.Information, "service"),
            Entry("duplicate", LogSeverity.Error, ""), Entry("changing", LogSeverity.Warning, "service"),
            Entry("changing", LogSeverity.Warning, "service"),
        });
        await using SessionComparisons comparisons = new(CancellationToken.None);
        ComparisonSnapshot result = await Compare(comparisons, fixture.Catalog, baseline, candidate, "raw");
        Assert.Equal(7, result.Baseline.MatchedCount);
        Assert.Equal(7, result.Candidate.MatchedCount);
        Assert.Equal(14, result.ProcessedEntries);
        Assert.Equal(14, result.TotalEntries);
        ComparisonGroups messages = comparisons.Groups(result.Id, "message", "all", 0, CancellationToken.None);
        Assert.Equal(6, messages.Total);
        AssertGroup(messages, "stable", 1, 1, "unchanged");
        AssertGroup(messages, "changing", 2, 3, "changed");
        AssertGroup(messages, "resolved", 1, 0, "resolved");
        AssertGroup(messages, "new", 0, 1, "new");
        AssertGroup(messages, "duplicate", 2, 2, "unchanged");
        ComparisonGroups severity = comparisons.Groups(result.Id, "severity", "all", 0, CancellationToken.None);
        AssertGroup(severity, "trace", 1, 0, "resolved");
        AssertGroup(severity, "critical", 0, 1, "new");
        AssertGroup(severity, "error", 3, 2, "changed");
        AssertGroup(severity, "information", 1, 1, "unchanged");
        ComparisonGroups categories = comparisons.Groups(result.Id, "category", "all", 0, CancellationToken.None);
        AssertGroup(categories, "service", 3, 4, "changed");
        AssertGroup(categories, "", 2, 2, "unchanged");
        ComparisonGroup noCategory = Assert.Single(categories.Groups, group => group.Category is null);
        Assert.Equal("resolved", noCategory.Change);
        Assert.Equal(new[] { "resolved" }, comparisons.Evidence(result.Id, noCategory.Id, "baseline", 0, CancellationToken.None).Entries.Select(entry => entry.Message));
        ComparisonGroup error = Assert.Single(severity.Groups, group => group.Label == "error");
        Assert.Equal(new[] { "resolved", "duplicate", "duplicate" },
            comparisons.Evidence(result.Id, error.Id, "baseline", 0, CancellationToken.None).Entries.Select(entry => entry.Message));
        Assert.Equal(new long[] { 1, 5 }, comparisons.Evidence(result.Id,
            Assert.Single(messages.Groups, group => group.Label == "duplicate").Id, "candidate", 0, CancellationToken.None).Entries.Select(entry => entry.Id));
        Assert.Empty(comparisons.Evidence(result.Id, noCategory.Id, "candidate", 0, CancellationToken.None).Entries);
        Assert.Equal(2, comparisons.Groups(result.Id, "message", "resolved", 0, CancellationToken.None).Total);
        Assert.Empty(comparisons.Groups(result.Id, "message", "all", long.MaxValue, CancellationToken.None).Groups);
    }

    [Fact]
    public async Task NormalizationCollisionsCombineAllRawMessagesWithoutCrossingSeverityOrCategory()
    {
        using Fixture fixture = new();
        string baseline = fixture.Save(new[]
        {
            Entry("Request 123", LogSeverity.Warning, "service"), Entry("Request 456", LogSeverity.Warning, "service"),
            Entry("Request <number>", LogSeverity.Warning, "service"),
            Entry("Request 789", LogSeverity.Error, "service"), Entry("Request 999", LogSeverity.Warning, ""),
            Entry("Request 888", LogSeverity.Warning),
        });
        string candidate = fixture.Save(new[]
        {
            Entry("Request 789", LogSeverity.Warning, "service"), Entry("Request 987", LogSeverity.Warning, "service"),
        });
        await using SessionComparisons comparisons = new(CancellationToken.None);
        ComparisonSnapshot normalized = await Compare(comparisons, fixture.Catalog, baseline, candidate);
        ComparisonGroups groups = comparisons.Groups(normalized.Id, "message", "all", 0, CancellationToken.None);
        Assert.Equal(4, groups.Total);
        ComparisonGroup collision = Assert.Single(groups.Groups, group => group.Severity == "warning" && group.Category == "service");
        Assert.Equal("Request <number>", collision.Label);
        Assert.Equal(3, collision.BaselineCount);
        Assert.Equal(2, collision.CandidateCount);
        Assert.Equal(new[] { "Request 456", "Request <number>" },
            comparisons.Evidence(normalized.Id, collision.Id, "baseline", 1, CancellationToken.None).Entries.Select(entry => entry.Message));
        ComparisonSnapshot raw = await Compare(comparisons, fixture.Catalog, baseline, candidate, "raw");
        Assert.Equal(8, comparisons.Groups(raw.Id, "message", "all", 0, CancellationToken.None).Total);
        Assert.Contains("preserve case", normalized.NormalizationRule, StringComparison.Ordinal);
        Assert.Equal("At <timestamp> id <guid> address <hex> elapsed <number> ms",
            ComparisonSignatures.Normalize("At 2026-10-25T11:12:13.123Z id 9f510d1f-f97c-42a0-9c91-9dc0a08102ab address 0xABCD elapsed 12.5 ms"));
        Assert.NotEqual(ComparisonSignatures.Normalize("Value 1"), ComparisonSignatures.Normalize("value 2"));
    }

    [Fact]
    public async Task SavedScopesFreezeIndependentFiltersAndInclusiveRelativeBoundsWithoutDurationNormalization()
    {
        using Fixture fixture = new();
        SessionFilters baselineFilters = Filters() with
        {
            Since = StartTime.AddSeconds(10).ToString("O"), Until = StartTime.AddSeconds(20).ToString("O"),
            Search = "message:keep -message:drop", Levels = new[] { "warning" }, Stream = "stderr", Category = "\"service\"",
            Conditions = new[] { new LogCondition("include", "message", "contains", "keep") },
        };
        SessionFilters candidateFilters = Filters() with { TimeWindow = 60_000 };
        string baseline = fixture.Save(new[]
        {
            Entry("keep lower", LogSeverity.Warning, "service", 10, LogStream.Stderr),
            Entry("keep upper", LogSeverity.Warning, "service", 20, LogStream.Stderr),
            Entry("keep early", LogSeverity.Warning, "service", 9, LogStream.Stderr),
            Entry("keep drop", LogSeverity.Warning, "service", 15, LogStream.Stderr),
            Entry("keep wrong level", LogSeverity.Error, "service", 15, LogStream.Stderr),
            Entry("keep wrong stream", LogSeverity.Warning, "service", 15),
        }, filters: baselineFilters, durationSeconds: 60);
        string candidate = fixture.Save(new[]
        {
            Entry("keep lower", seconds: 120), Entry("keep upper", seconds: 180), Entry("outside", seconds: 119),
            Entry("after", seconds: 181),
        }, filters: candidateFilters, durationSeconds: 180);
        await using SessionComparisons comparisons = new(CancellationToken.None);
        ComparisonSnapshot result = await Compare(comparisons, fixture.Catalog, baseline, candidate, filterScope: "saved");
        Assert.Equal(2, result.Baseline.MatchedCount);
        Assert.Equal(2, result.Candidate.MatchedCount);
        Assert.Equal(6, result.Baseline.TotalEntries);
        Assert.Equal(4, result.Candidate.TotalEntries);
        Assert.Equal(60_000d, result.Baseline.DurationMilliseconds);
        Assert.Equal(180_000d, result.Candidate.DurationMilliseconds);
        Assert.Equal(0, result.Candidate.Filters!.TimeWindow);
        Assert.Equal(StartTime.AddSeconds(120), DateTimeOffset.Parse(result.Candidate.Filters.Since, CultureInfo.InvariantCulture));
        Assert.Equal(StartTime.AddSeconds(180), DateTimeOffset.Parse(result.Candidate.Filters.Until, CultureInfo.InvariantCulture));
        fixture.Catalog.SaveFilters(baseline, Filters() with { Search = "nothing" }, fixture.Status);
        result.Baseline.Filters!.Levels![0] = "error";
        ComparisonSnapshot unchanged = comparisons.Snapshot(result.Id);
        Assert.Equal("warning", unchanged.Baseline.Filters!.Levels![0]);
        Assert.Equal("completed", unchanged.State);
        Assert.Equal(2, unchanged.Baseline.MatchedCount);
        ComparisonGroup group = Assert.Single(comparisons.Groups(result.Id, "severity", "all", 0, CancellationToken.None).Groups, item => item.Label == "warning");
        Assert.Equal(new[] { "keep lower", "keep upper" }, comparisons.Evidence(result.Id, group.Id, "baseline", 0, CancellationToken.None).Entries.Select(entry => entry.Message));
        ComparisonSnapshot all = await Compare(comparisons, fixture.Catalog, baseline, candidate);
        Assert.Null(all.Baseline.Filters);
        Assert.Null(all.Candidate.Filters);
        Assert.Equal(6, all.Baseline.MatchedCount);
        Assert.Equal(4, all.Candidate.MatchedCount);
    }

    [Fact]
    public async Task FullNondeletedJournalCountsAndEvidenceAreIndependentOfRetentionAndMetadataCounts()
    {
        using Fixture fixture = new();
        string baseline = fixture.Save(Enumerable.Range(0, 101).Select(_ => Entry("same")).ToArray(), retained: 2);
        string candidate = fixture.Save(Array.Empty<LogEntry>());
        await using SessionComparisons comparisons = new(CancellationToken.None);
        ComparisonSnapshot result = await Compare(comparisons, fixture.Catalog, baseline, candidate);
        Assert.Equal(2, result.Baseline.Session.EntryCount);
        Assert.Equal(101, result.Baseline.TotalEntries);
        Assert.Equal(101, result.Baseline.MatchedCount);
        Assert.Equal(0, result.Candidate.TotalEntries);
        ComparisonGroup group = Assert.Single(comparisons.Groups(result.Id, "message", "all", 0, CancellationToken.None).Groups);
        ComparisonEvidence first = comparisons.Evidence(result.Id, group.Id, "baseline", 0, CancellationToken.None);
        Assert.Equal(50, first.Entries.Length);
        Assert.Equal(1, first.Entries[0].Id);
        Assert.Equal(50, first.NextAfter);
        ComparisonEvidence second = comparisons.Evidence(result.Id, group.Id, "baseline", first.NextAfter!.Value, CancellationToken.None);
        Assert.Equal(50, second.Entries.Length);
        Assert.Equal(100, second.NextAfter);
        ComparisonEvidence last = comparisons.Evidence(result.Id, group.Id, "baseline", second.NextAfter!.Value, CancellationToken.None);
        Assert.Equal(101, Assert.Single(last.Entries).Id);
        Assert.Null(last.NextAfter);
        fixture.Catalog.Clear(baseline);
        ComparisonSnapshot empty = await Compare(comparisons, fixture.Catalog, baseline, candidate);
        Assert.Equal(0, empty.TotalEntries);
        Assert.Equal(0, comparisons.Groups(empty.Id, "message", "all", 0, CancellationToken.None).Total);
        Assert.Throws<FileNotFoundException>(() => comparisons.Evidence(empty.Id, "g1", "baseline", 0, CancellationToken.None));
    }

    [Fact]
    public async Task HighCardinalityUsesMultipleBoundedMergePassesAndExactPagedGroups()
    {
        using Fixture fixture = new();
        string baseline = fixture.Save(Enumerable.Range(0, 2300).Select(index => Entry("unique-" + index, category: "category-" + index)).ToArray());
        string candidate = fixture.Save(Enumerable.Range(1150, 2300).Select(index => Entry("unique-" + index, category: "category-" + index)).ToArray());
        await using SessionComparisons comparisons = new(CancellationToken.None, new(ChunkRows: 128, MergeFanIn: 4));
        ComparisonSnapshot result = await Compare(comparisons, fixture.Catalog, baseline, candidate, "raw");
        Assert.Equal(4600, result.TotalEntries);
        ComparisonGroups page = comparisons.Groups(result.Id, "message", "all", 50, CancellationToken.None);
        Assert.Equal(3450, page.Total);
        Assert.Equal(50, page.PageSize);
        Assert.Equal(50, page.Groups.Length);
        Assert.Equal(50, page.Offset);
        Assert.Equal(1150, comparisons.Groups(result.Id, "message", "new", 0, CancellationToken.None).Total);
        Assert.Equal(1150, comparisons.Groups(result.Id, "message", "resolved", 0, CancellationToken.None).Total);
        Assert.Equal(1150, comparisons.Groups(result.Id, "message", "unchanged", 0, CancellationToken.None).Total);
        Assert.Equal(3450, comparisons.Groups(result.Id, "category", "all", 0, CancellationToken.None).Total);
        ComparisonGroup selected = page.Groups[0];
        string side = selected.BaselineCount > 0 ? "baseline" : "candidate";
        Assert.Equal(selected.Label, Assert.Single(comparisons.Evidence(result.Id, selected.Id, side, 0, CancellationToken.None).Entries).Message);
        string work = Assert.Single(Directory.EnumerateDirectories(fixture.Root, ".comparison-*"));
        Assert.Equal(new[] { "groups.idx", "groups.jsonl" }, Directory.EnumerateFiles(work).Select(Path.GetFileName).OrderBy(name => name));
        Assert.Empty(Directory.EnumerateDirectories(work));
    }

    [Fact]
    public async Task InitialAndIntermediateSnapshotsKeepFrozenSideTotalsAndIndependentProcessedProgress()
    {
        using Fixture fixture = new();
        const int baselineCount = 8000;
        const int candidateCount = 4000;
        string baseline = fixture.Save(Enumerable.Range(0, baselineCount).Select(index => Entry("baseline-" + index)).ToArray(), retained: 2);
        string candidate = fixture.Save(Enumerable.Range(0, candidateCount).Select(index => Entry("candidate-" + index)).ToArray(), retained: 1);
        await using SessionComparisons comparisons = new(CancellationToken.None, new(ChunkRows: 32));
        ComparisonSnapshot initial = comparisons.Start(fixture.Catalog, new(baseline, candidate, "raw", "all"));
        Assert.Equal("running", initial.State);
        AssertTotals(initial);
        Assert.InRange(initial.ProcessedEntries, 0, baselineCount + candidateCount);
        bool observedProgress = false;
        for (int attempt = 0; attempt < 2000; attempt++)
        {
            ComparisonSnapshot snapshot = comparisons.Snapshot(initial.Id);
            AssertTotals(snapshot);
            Assert.InRange(snapshot.ProcessedEntries, 0, snapshot.TotalEntries);
            Assert.InRange(snapshot.Baseline.MatchedCount, 0, snapshot.Baseline.TotalEntries);
            Assert.InRange(snapshot.Candidate.MatchedCount, 0, snapshot.Candidate.TotalEntries);
            if (snapshot.State == "running" && snapshot.ProcessedEntries > 0 && snapshot.ProcessedEntries < snapshot.TotalEntries)
            {
                observedProgress = true;
                break;
            }
            if (snapshot.State != "running") break;
            await Task.Delay(1);
        }
        Assert.True(observedProgress);
        await comparisons.WaitForCompletionAsync(initial.Id);
        ComparisonSnapshot completed = comparisons.Snapshot(initial.Id);
        Assert.Equal("completed", completed.State);
        AssertTotals(completed);
        Assert.Equal(completed.TotalEntries, completed.ProcessedEntries);
        Assert.Equal(baselineCount, completed.Baseline.MatchedCount);
        Assert.Equal(candidateCount, completed.Candidate.MatchedCount);

        static void AssertTotals(ComparisonSnapshot snapshot)
        {
            Assert.Equal(baselineCount, snapshot.Baseline.TotalEntries);
            Assert.Equal(candidateCount, snapshot.Candidate.TotalEntries);
            Assert.Equal(snapshot.Baseline.TotalEntries + snapshot.Candidate.TotalEntries, snapshot.TotalEntries);
        }
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task ClearingOrDeletingEitherRunningOrCompletedSourceInvalidatesResultsAndReleasesStorage(bool running, bool delete)
    {
        using Fixture fixture = new();
        string baseline = fixture.Save(Enumerable.Range(0, running ? 10_000 : 2).Select(index => Entry("message-" + index)).ToArray());
        string candidate = fixture.Save(new[] { Entry("candidate") });
        await using SessionComparisons comparisons = new(CancellationToken.None, new(ChunkRows: 64));
        ComparisonSnapshot started = comparisons.Start(fixture.Catalog, new(baseline, candidate, "raw", "all"));
        if (running)
        {
            for (int attempt = 0; attempt < 2000 && comparisons.Snapshot(started.Id).ProcessedEntries == 0; attempt++) await Task.Delay(1);
            Assert.Equal("running", comparisons.Snapshot(started.Id).State);
        }
        else await comparisons.WaitForCompletionAsync(started.Id);
        string selected = delete ? candidate : baseline;
        if (delete) fixture.Catalog.Delete(selected);
        else fixture.Catalog.Clear(selected);
        Assert.Equal("invalidated", comparisons.Snapshot(started.Id).State);
        Assert.Throws<ComparisonUnavailableException>(() => comparisons.Groups(started.Id, "message", "all", 0, CancellationToken.None));
        Assert.Throws<ComparisonUnavailableException>(() => comparisons.Evidence(started.Id, "g1", "baseline", 0, CancellationToken.None));
        await comparisons.WaitForCompletionAsync(started.Id);
        Assert.Empty(Directory.EnumerateDirectories(fixture.Root, ".comparison-*"));
    }

    [Fact]
    public async Task CancellationCapacityExpiryAndShutdownBoundAndReleaseAllWork()
    {
        using Fixture fixture = new();
        string baseline = fixture.Save(Enumerable.Range(0, 5000).Select(index => Entry("entry-" + index)).ToArray());
        string candidate = fixture.Save(new[] { Entry("candidate") });
        await using SessionComparisons comparisons = new(CancellationToken.None, new(MaximumJobs: 2, MaximumWorkers: 1, ChunkRows: 64));
        ComparisonRequest request = new(baseline, candidate, "raw", "all");
        ComparisonSnapshot first = comparisons.Start(fixture.Catalog, request);
        Assert.Throws<ComparisonCapacityException>(() => comparisons.Start(fixture.Catalog, request));
        Assert.Equal("cancelled", comparisons.Cancel(first.Id).State);
        await comparisons.WaitForCompletionAsync(first.Id);
        Assert.Empty(Directory.EnumerateDirectories(fixture.Root, ".comparison-*"));
        ComparisonSnapshot completed = await Compare(comparisons, fixture.Catalog, baseline, candidate, "normalized");
        comparisons.Sweep(DateTimeOffset.UtcNow.AddMinutes(16));
        Assert.Equal("cancelled", comparisons.Snapshot(completed.Id).State);
        Assert.Contains("expired", comparisons.Snapshot(completed.Id).Error, StringComparison.Ordinal);
        Assert.Empty(Directory.EnumerateDirectories(fixture.Root, ".comparison-*"));
        using CancellationTokenSource shutdown = new();
        await using SessionComparisons shuttingDown = new(shutdown.Token, new(ChunkRows: 64));
        ComparisonSnapshot active = shuttingDown.Start(fixture.Catalog, request);
        shutdown.Cancel();
        await shuttingDown.WaitForCompletionAsync(active.Id);
        Assert.Equal("cancelled", shuttingDown.Snapshot(active.Id).State);
        Assert.Empty(Directory.EnumerateDirectories(fixture.Root, ".comparison-*"));
    }

    [Fact]
    public async Task ConcurrentCancellationStartAndSweepCannotDisposeCancellationBeforeStopFinishes()
    {
        using Fixture fixture = new();
        string baseline = fixture.Save(new[] { Entry("baseline") });
        string candidate = fixture.Save(new[] { Entry("candidate") });
        ComparisonRequest request = new(baseline, candidate, "raw", "all");
        await using SessionComparisons comparisons = new(CancellationToken.None, new(MaximumJobs: 1, MaximumWorkers: 1));
        for (int iteration = 0; iteration < 128; iteration++)
        {
            ComparisonSnapshot completed = await Compare(comparisons, fixture.Catalog, baseline, candidate, "raw");
            TaskCompletionSource ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
            Task<ComparisonSnapshot?>[] operations = Enumerable.Range(0, 8).Select(async index =>
            {
                await ready.Task;
                if (index < 4)
                {
                    try { comparisons.Cancel(completed.Id); }
                    catch (FileNotFoundException) { }
                    return null;
                }
                if (index < 6)
                {
                    comparisons.Sweep(DateTimeOffset.UtcNow);
                    return null;
                }
                try { return comparisons.Start(fixture.Catalog, request); }
                catch (ComparisonCapacityException) { return null; }
            }).ToArray();
            ready.SetResult();
            ComparisonSnapshot?[] replacements = await Task.WhenAll(operations);
            foreach (ComparisonSnapshot? replacement in replacements)
            {
                if (replacement is null) continue;
                comparisons.Cancel(replacement.Id);
                await comparisons.WaitForCompletionAsync(replacement.Id);
            }
        }
        Assert.Empty(Directory.EnumerateDirectories(fixture.Root, ".comparison-*"));
    }

    [Fact]
    public async Task DiskLimitAndCorruptJournalFailExplicitlyWithoutPartialResults()
    {
        using Fixture fixture = new();
        string baseline = fixture.Save(new[] { Entry(new string('x', 1024)) });
        string candidate = fixture.Save(new[] { Entry("candidate") });
        await using SessionComparisons limited = new(CancellationToken.None, new(MaximumWrittenBytes: 100, ChunkRows: 1));
        ComparisonSnapshot started = limited.Start(fixture.Catalog, new(baseline, candidate, "raw", "all"));
        await limited.WaitForCompletionAsync(started.Id);
        ComparisonSnapshot failed = limited.Snapshot(started.Id);
        Assert.Equal("failed", failed.State);
        Assert.Contains("disk-work limit", failed.Error, StringComparison.Ordinal);
        Assert.Throws<ComparisonUnavailableException>(() => limited.Groups(started.Id, "message", "all", 0, CancellationToken.None));
        Assert.Empty(Directory.EnumerateDirectories(fixture.Root, ".comparison-*"));
        File.WriteAllText(Path.Combine(fixture.Root, baseline, "entries.jsonl"), "");
        await using SessionComparisons corrupt = new(CancellationToken.None);
        ComparisonSnapshot invalid = corrupt.Start(fixture.Catalog, new(baseline, candidate, "raw", "all"));
        await corrupt.WaitForCompletionAsync(invalid.Id);
        Assert.Equal("failed", corrupt.Snapshot(invalid.Id).State);
        Assert.Empty(Directory.EnumerateDirectories(fixture.Root, ".comparison-*"));
    }

    [Fact]
    public async Task ImportedRecordsAreComparableAndClearingThroughAnotherCatalogInvalidatesThem()
    {
        using Fixture fixture = new();
        byte[] json = JsonSerializer.SerializeToUtf8Bytes(Entry("imported 123", LogSeverity.Error, ""), ViewerConstants.JsonOptions);
        using MemoryStream source = new(json);
        SessionInfo imported = await SessionTransfer.ImportAsync(source, "jsonl", "imported", fixture.Catalog, CancellationToken.None);
        string baseline = fixture.Save(new[] { Entry("imported 456", LogSeverity.Error, "") });
        await using SessionComparisons comparisons = new(CancellationToken.None);
        ComparisonSnapshot result = await Compare(comparisons, fixture.Catalog, baseline, imported.Id, filterScope: "saved");
        Assert.Null(result.Baseline.Filters);
        Assert.Null(result.Candidate.Filters);
        ComparisonGroup group = Assert.Single(comparisons.Groups(result.Id, "message", "unchanged", 0, CancellationToken.None).Groups);
        Assert.Equal("imported 123", Assert.Single(comparisons.Evidence(result.Id, group.Id, "candidate", 0, CancellationToken.None).Entries).Message);
        SessionCatalog other = new(new ConsoleLogViewerOptions { CaptureConsole = false, SessionsDirectory = fixture.Root }.Validate());
        other.Clear(imported.Id);
        Assert.Equal("invalidated", comparisons.Snapshot(result.Id).State);
        Assert.Throws<ComparisonUnavailableException>(() => comparisons.Evidence(result.Id, group.Id, "candidate", 0, CancellationToken.None));
        Assert.Empty(Directory.EnumerateDirectories(fixture.Root, ".comparison-*"));
    }

    [Fact]
    public async Task ClearingAnEmptySourceThroughAnotherCatalogInvalidatesEvenWhenLengthsAndCountsStayZero()
    {
        using Fixture fixture = new();
        string baseline = fixture.Save(Array.Empty<LogEntry>());
        string candidate = fixture.Save(Array.Empty<LogEntry>());
        await using SessionComparisons comparisons = new(CancellationToken.None);
        ComparisonSnapshot result = await Compare(comparisons, fixture.Catalog, baseline, candidate);
        Assert.Equal(0, result.TotalEntries);
        SessionCatalog other = new(new ConsoleLogViewerOptions { CaptureConsole = false, SessionsDirectory = fixture.Root }.Validate());
        LogClearResult cleared = other.Clear(baseline);
        Assert.Equal(0, cleared.DeletedCount);
        Assert.Equal(0, new FileInfo(Path.Combine(fixture.Root, baseline, "entries.jsonl")).Length);
        Assert.Equal(0, new FileInfo(Path.Combine(fixture.Root, baseline, "entries.idx")).Length);
        Assert.Equal("invalidated", comparisons.Snapshot(result.Id).State);
        Assert.Throws<ComparisonUnavailableException>(() => comparisons.Groups(result.Id, "message", "all", 0, CancellationToken.None));
        Assert.Throws<ComparisonUnavailableException>(() => comparisons.Evidence(result.Id, "g1", "baseline", 0, CancellationToken.None));
        Assert.Empty(Directory.EnumerateDirectories(fixture.Root, ".comparison-*"));
    }

    [Fact]
    public async Task OversizeJournalAndWorkDeadlineFailWithoutTruncationAndRequestCancellationIsHonored()
    {
        using Fixture fixture = new();
        string baseline = fixture.Save(Enumerable.Range(0, 2000).Select(index => Entry("record-" + index)).ToArray());
        string candidate = fixture.Save(new[] { Entry("candidate") });
        await using SessionComparisons timeout = new(CancellationToken.None, new(Timeout: TimeSpan.FromTicks(1)));
        ComparisonSnapshot timed = timeout.Start(fixture.Catalog, new(baseline, candidate, "raw", "all"));
        await timeout.WaitForCompletionAsync(timed.Id);
        Assert.Equal("failed", timeout.Snapshot(timed.Id).State);
        Assert.Contains("deadline", timeout.Snapshot(timed.Id).Error, StringComparison.Ordinal);
        await using SessionComparisons comparisons = new(CancellationToken.None);
        ComparisonSnapshot result = await Compare(comparisons, fixture.Catalog, baseline, candidate, "raw");
        using CancellationTokenSource cancelled = new();
        cancelled.Cancel();
        Assert.ThrowsAny<OperationCanceledException>(() => comparisons.Groups(result.Id, "message", "all", 0, cancelled.Token));
        Assert.ThrowsAny<OperationCanceledException>(() => comparisons.Evidence(result.Id, "g1", "baseline", 0, cancelled.Token));
        File.WriteAllText(Path.Combine(fixture.Root, baseline, "entries.jsonl"), new string('x', SessionTransfer.MaximumJsonLineCharacters + 1));
        Assert.Equal("invalidated", comparisons.Snapshot(result.Id).State);
        ComparisonSnapshot oversized = comparisons.Start(fixture.Catalog, new(baseline, candidate, "raw", "all"));
        await comparisons.WaitForCompletionAsync(oversized.Id);
        Assert.Equal("failed", comparisons.Snapshot(oversized.Id).State);
        Assert.Contains("supported size", comparisons.Snapshot(oversized.Id).Error, StringComparison.Ordinal);
        Assert.Empty(Directory.EnumerateDirectories(fixture.Root, ".comparison-*"));
    }

    [Fact]
    public async Task ByteBudgetFlushesEscapedLargeMessagesAndRejectsSingleOversizeRowsExplicitly()
    {
        using Fixture fixture = new();
        string escaped = new('\u0001', 16_000);
        string baseline = fixture.Save(Enumerable.Range(0, 30).Select(index => Entry(escaped + index)).ToArray());
        string candidate = fixture.Save(new[] { Entry(escaped + 0) });
        await using SessionComparisons comparisons = new(CancellationToken.None, new(ChunkRows: 1024, ChunkBytes: 128 * 1024, MergeFanIn: 4));
        ComparisonSnapshot result = await Compare(comparisons, fixture.Catalog, baseline, candidate, "raw");
        Assert.Equal(30, comparisons.Groups(result.Id, "message", "all", 0, CancellationToken.None).Total);
        ComparisonGroup same = Assert.Single(comparisons.Groups(result.Id, "message", "unchanged", 0, CancellationToken.None).Groups);
        Assert.Equal(escaped + 0, Assert.Single(comparisons.Evidence(result.Id, same.Id, "candidate", 0, CancellationToken.None).Entries).Message);
        comparisons.Cancel(result.Id);
        await using SessionComparisons limited = new(CancellationToken.None, new(ChunkBytes: 1024));
        ComparisonSnapshot failed = limited.Start(fixture.Catalog, new(baseline, candidate, "raw", "all"));
        await limited.WaitForCompletionAsync(failed.Id);
        Assert.Equal("failed", limited.Snapshot(failed.Id).State);
        Assert.Contains("chunk byte budget", limited.Snapshot(failed.Id).Error, StringComparison.Ordinal);
        Assert.Empty(Directory.EnumerateDirectories(fixture.Root, ".comparison-*"));
    }

    [Fact]
    public async Task InvalidCurrentLiveSameAndUnsupportedInputsAreRejected()
    {
        using Fixture fixture = new();
        string completed = fixture.Save(new[] { Entry("complete") });
        string live = fixture.Save(new[] { Entry("live") }, completed: false);
        await using SessionComparisons comparisons = new(CancellationToken.None);
        foreach (ComparisonRequest request in new[]
        {
            new ComparisonRequest(completed, completed, "raw", "all"), new(fixture.Catalog.Id, completed, "raw", "all"),
            new(live, completed, "raw", "all"), new(completed, live, "raw", "all"),
            new(completed, live, "other", "all"), new(completed, live, "raw", "other"),
            new("../outside", completed, "raw", "all"),
        })
            Assert.Throws<ArgumentException>(() => comparisons.Start(fixture.Catalog, request));
        Assert.Throws<DirectoryNotFoundException>(() => comparisons.Start(fixture.Catalog, new(completed, Guid.NewGuid().ToString("N"), "raw", "all")));
        Assert.Empty(Directory.EnumerateDirectories(fixture.Root, ".comparison-*"));
    }

    [Fact]
    public async Task SourceCaptureRejectsActiveWriterAndInconsistentCompletionMetadata()
    {
        using Fixture fixture = new();
        string candidate = fixture.Save(new[] { Entry("candidate") });
        await using SessionComparisons comparisons = new(CancellationToken.None);
        foreach (Func<SavedSession, SavedSession> mutate in new Func<SavedSession, SavedSession>[]
        {
            saved => saved with { Session = saved.Session with { IsCurrent = true } },
            saved => saved with { Status = saved.Status with { PendingEntries = 1 } },
            saved => saved with { Status = saved.Status with { IsCompleted = false } },
            saved => saved with { Status = saved.Status with { CompletedAt = null } },
            saved => saved with { Status = saved.Status with { CompletedAt = StartTime.AddDays(1) } },
        })
        {
            string baseline = fixture.Save(new[] { Entry("baseline") });
            string metadata = Path.Combine(fixture.Root, baseline, "session.json");
            SavedSession saved = JsonSerializer.Deserialize<SavedSession>(File.ReadAllText(metadata), ViewerConstants.JsonOptions)!;
            File.WriteAllText(metadata, JsonSerializer.Serialize(mutate(saved), ViewerConstants.JsonOptions));
            Assert.Throws<ArgumentException>(() => comparisons.Start(fixture.Catalog, new(baseline, candidate, "raw", "all")));
        }
        Assert.Empty(Directory.EnumerateDirectories(fixture.Root, ".comparison-*"));
    }

    [Fact]
    public async Task CompletedMetadataCannotSilentlyTruncateExtraJournalOrIndexRecords()
    {
        using Fixture fixture = new();
        string candidate = fixture.Save(Array.Empty<LogEntry>());
        await using SessionComparisons comparisons = new(CancellationToken.None);
        foreach (bool indexed in new[] { false, true })
        {
            string baseline = fixture.Save(new[] { Entry("original") });
            string directory = Path.Combine(fixture.Root, baseline);
            long offset = new FileInfo(Path.Combine(directory, "entries.jsonl")).Length;
            File.AppendAllText(Path.Combine(directory, "entries.jsonl"),
                JsonSerializer.Serialize(new LogEntry(2, StartTime, LogStream.Stdout, LogSeverity.Error, null, "outside completed metadata", false), ViewerConstants.JsonOptions) + "\n");
            if (indexed)
            {
                using FileStream index = new(Path.Combine(directory, "entries.idx"), FileMode.Append);
                byte[] bytes = new byte[sizeof(long)];
                BinaryPrimitives.WriteInt64LittleEndian(bytes, offset);
                index.Write(bytes);
            }
            ComparisonSnapshot result = comparisons.Start(fixture.Catalog, new(baseline, candidate, "raw", "all"));
            await comparisons.WaitForCompletionAsync(result.Id);
            Assert.Equal("failed", comparisons.Snapshot(result.Id).State);
            Assert.Contains("outside its completed metadata", comparisons.Snapshot(result.Id).Error, StringComparison.Ordinal);
            Assert.Throws<ComparisonUnavailableException>(() => comparisons.Groups(result.Id, "message", "all", 0, CancellationToken.None));
        }
        Assert.Empty(Directory.EnumerateDirectories(fixture.Root, ".comparison-*"));
    }

    [Fact]
    public async Task HttpContractPreservesActionOriginContentLimitsAndClearDeleteInvalidation()
    {
        using Fixture fixture = new();
        string baseline = fixture.Save(new[] { Entry("Request 1", LogSeverity.Warning, "service") });
        string candidate = fixture.Save(new[] { Entry("Request 2", LogSeverity.Warning, "service") });
        string live = fixture.Save(new[] { Entry("live") }, completed: false);
        await using ConsoleLogViewer viewer = ConsoleLogViewer.Start(new ConsoleLogViewerOptions
        {
            CaptureConsole = false, SessionsDirectory = fixture.Root,
        });
        using HttpClient client = new() { BaseAddress = viewer.Url };
        string body = JsonSerializer.Serialize(new ComparisonRequest(baseline, candidate, "normalized", "all"), ViewerConstants.JsonOptions);
        await AssertStatus(client, HttpMethod.Post, "api/comparison", body, null, HttpStatusCode.Forbidden);
        await AssertStatus(client, HttpMethod.Post, "api/comparison", body, "compare", HttpStatusCode.Forbidden, origin: "https://example.invalid");
        await AssertStatus(client, HttpMethod.Post, "api/comparison", body, "compare", HttpStatusCode.Forbidden, fetchSite: "cross-site");
        await AssertStatus(client, HttpMethod.Post, "api/comparison", body, "compare", HttpStatusCode.UnsupportedMediaType, contentType: "text/plain");
        await AssertStatus(client, HttpMethod.Post, "api/comparison", new string('x', 2049), "compare", HttpStatusCode.RequestEntityTooLarge);
        await AssertStatus(client, HttpMethod.Post, "api/comparison", "{", "compare", HttpStatusCode.BadRequest);
        await AssertStatus(client, HttpMethod.Post, "api/comparison", "{\"baselineId\":\"x\"}", "compare", HttpStatusCode.BadRequest);
        await AssertStatus(client, HttpMethod.Post, "api/comparison", body[..^1] + ",\"extra\":true}", "compare", HttpStatusCode.BadRequest);
        await AssertStatus(client, HttpMethod.Post, "api/comparison", body[..^1] + ",\"grouping\":\"raw\"}", "compare", HttpStatusCode.BadRequest);
        await AssertStatus(client, HttpMethod.Post, "api/comparison/groups", null, "compare", HttpStatusCode.MethodNotAllowed);
        await AssertStatus(client, HttpMethod.Get, "api/comparison", null, null, HttpStatusCode.BadRequest);
        await AssertStatus(client, HttpMethod.Get, "api/comparison?id=missing", null, null, HttpStatusCode.NotFound);
        foreach (string invalid in new[] { baseline, live })
            await AssertStatus(client, HttpMethod.Post, "api/comparison",
                JsonSerializer.Serialize(new ComparisonRequest(baseline, invalid, "raw", "all"), ViewerConstants.JsonOptions), "compare", HttpStatusCode.BadRequest);
        ComparisonSnapshot completed = await HttpCompare(client, body);
        Assert.False(completed.Baseline.Session.IsCurrent);
        Assert.Equal(1, completed.Baseline.TotalEntries);
        using JsonDocument groups = JsonDocument.Parse(await client.GetStringAsync("api/comparison/groups?id=" + completed.Id + "&kind=message&change=all&offset=0"));
        Assert.Equal(50, groups.RootElement.GetProperty("pageSize").GetInt32());
        string groupId = groups.RootElement.GetProperty("groups")[0].GetProperty("id").GetString()!;
        using JsonDocument evidence = JsonDocument.Parse(await client.GetStringAsync("api/comparison/evidence?id=" + completed.Id + "&groupId=" + groupId + "&side=candidate&after=0"));
        Assert.Equal(candidate, evidence.RootElement.GetProperty("sessionId").GetString());
        Assert.Equal("Request 2", evidence.RootElement.GetProperty("entries")[0].GetProperty("message").GetString());
        foreach (string suffix in new[] { "&kind=other", "&offset=-1", "&offset=9223372036854775808" })
            await AssertStatus(client, HttpMethod.Get, "api/comparison/groups?id=" + completed.Id + suffix, null, null, HttpStatusCode.BadRequest);
        await AssertStatus(client, HttpMethod.Get, "api/comparison/evidence?id=" + completed.Id + "&groupId=g1&side=other", null, null, HttpStatusCode.BadRequest);
        await AssertStatus(client, HttpMethod.Get, "api/comparison/evidence?id=" + completed.Id + "&groupId=g999&side=baseline", null, null, HttpStatusCode.NotFound);
        await AssertStatus(client, HttpMethod.Post, "api/comparison?id=" + completed.Id, null, null, HttpStatusCode.Forbidden);
        await AssertStatus(client, HttpMethod.Post, ViewerConstants.ClearRoute + "?sessionId=" + baseline, null, ViewerConstants.ClearRequestAction, HttpStatusCode.OK);
        ComparisonSnapshot invalidated = JsonSerializer.Deserialize<ComparisonSnapshot>(await client.GetStringAsync("api/comparison?id=" + completed.Id), ViewerConstants.JsonOptions)!;
        Assert.Equal("invalidated", invalidated.State);
        await AssertStatus(client, HttpMethod.Get, "api/comparison/groups?id=" + completed.Id, null, null, HttpStatusCode.Conflict);
        await AssertStatus(client, HttpMethod.Get, "api/comparison/evidence?id=" + completed.Id + "&groupId=" + groupId + "&side=baseline", null, null, HttpStatusCode.Conflict);
        ComparisonSnapshot next = await HttpCompare(client, body);
        await AssertStatus(client, HttpMethod.Post, "api/sessions?sessionId=" + candidate, null, ViewerConstants.DeleteSessionAction, HttpStatusCode.OK);
        Assert.Equal("invalidated", JsonSerializer.Deserialize<ComparisonSnapshot>(await client.GetStringAsync("api/comparison?id=" + next.Id), ViewerConstants.JsonOptions)!.State);
        ComparisonSnapshot cancellable = await HttpCompare(client,
            JsonSerializer.Serialize(new ComparisonRequest(baseline, fixture.Save(new[] { Entry("remaining") }), "raw", "all"), ViewerConstants.JsonOptions));
        using HttpRequestMessage cancel = Request(HttpMethod.Post, "api/comparison?id=" + cancellable.Id, null, "cancel-comparison");
        using HttpResponseMessage cancelled = await client.SendAsync(cancel);
        cancelled.EnsureSuccessStatusCode();
        Assert.Equal("cancelled", JsonSerializer.Deserialize<ComparisonSnapshot>(await cancelled.Content.ReadAsStringAsync(), ViewerConstants.JsonOptions)!.State);
    }

    [Fact]
    public async Task HttpRetainedJobCapacityCanBeReleasedWithExplicitCancellation()
    {
        using Fixture fixture = new();
        string baseline = fixture.Save(new[] { Entry("baseline") });
        string candidate = fixture.Save(new[] { Entry("candidate") });
        await using ConsoleLogViewer viewer = ConsoleLogViewer.Start(new ConsoleLogViewerOptions { CaptureConsole = false, SessionsDirectory = fixture.Root });
        using HttpClient client = new() { BaseAddress = viewer.Url };
        string body = JsonSerializer.Serialize(new ComparisonRequest(baseline, candidate, "raw", "all"), ViewerConstants.JsonOptions);
        List<ComparisonSnapshot> completed = new(4);
        for (int index = 0; index < 4; index++) completed.Add(await HttpCompare(client, body));
        await AssertStatus(client, HttpMethod.Post, "api/comparison", body, "compare", HttpStatusCode.TooManyRequests);
        await AssertStatus(client, HttpMethod.Post, "api/comparison?id=" + completed[0].Id, null, "cancel-comparison", HttpStatusCode.OK);
        await AssertStatus(client, HttpMethod.Get, "api/comparison/groups?id=" + completed[0].Id, null, null, HttpStatusCode.Conflict);
        Assert.Equal("completed", (await HttpCompare(client, body)).State);
        await AssertStatus(client, HttpMethod.Get, "api/comparison?id=" + completed[0].Id, null, null, HttpStatusCode.NotFound);
        SessionInfo[] sessions = JsonSerializer.Deserialize<SessionInfo[]>(await client.GetStringAsync(ViewerConstants.SessionsRoute), ViewerConstants.JsonOptions)!;
        string current = Assert.Single(sessions, item => item.IsCurrent).Id;
        await AssertStatus(client, HttpMethod.Post, "api/comparison?id=" + completed[1].Id, null, "cancel-comparison", HttpStatusCode.OK);
        await AssertStatus(client, HttpMethod.Post, "api/comparison",
            JsonSerializer.Serialize(new ComparisonRequest(current, baseline, "raw", "all"), ViewerConstants.JsonOptions), "compare", HttpStatusCode.BadRequest);
    }

    private static async Task<ComparisonSnapshot> Compare(SessionComparisons comparisons, SessionCatalog catalog, string baseline, string candidate,
        string grouping = "normalized", string filterScope = "all")
    {
        ComparisonSnapshot result = comparisons.Start(catalog, new(baseline, candidate, grouping, filterScope));
        await comparisons.WaitForCompletionAsync(result.Id).WaitAsync(TimeSpan.FromSeconds(60));
        result = comparisons.Snapshot(result.Id);
        Assert.True(result.State == "completed", result.State + ": " + result.Error);
        return result;
    }

    private static void AssertGroup(ComparisonGroups groups, string label, long baseline, long candidate, string change)
    {
        ComparisonGroup group = Assert.Single(groups.Groups, item => item.Label == label);
        Assert.Equal(baseline, group.BaselineCount);
        Assert.Equal(candidate, group.CandidateCount);
        Assert.Equal(candidate - baseline, group.Delta);
        Assert.Equal(change, group.Change);
    }

    private static SessionFilters Filters() => new("", false, "all", null, "all", "", 0, Array.Empty<LogCondition>(), "all");
    private static LogEntry Entry(string message, LogSeverity severity = LogSeverity.Information, string? category = null, int seconds = 1, LogStream stream = LogStream.Stdout) =>
        new(1, StartTime.AddSeconds(seconds), stream, severity, category, message, false);

    private static HttpRequestMessage Request(HttpMethod method, string url, string? body, string? action, string contentType = "application/json")
    {
        HttpRequestMessage request = new(method, url);
        if (action is not null) request.Headers.Add(ViewerConstants.ClearRequestHeader, action);
        if (body is not null) request.Content = new StringContent(body, Encoding.UTF8, contentType);
        return request;
    }

    private static async Task AssertStatus(HttpClient client, HttpMethod method, string url, string? body, string? action, HttpStatusCode expected,
        string contentType = "application/json", string? origin = null, string? fetchSite = null)
    {
        using HttpRequestMessage request = Request(method, url, body, action, contentType);
        if (origin is not null) request.Headers.Add("Origin", origin);
        if (fetchSite is not null) request.Headers.Add("Sec-Fetch-Site", fetchSite);
        using HttpResponseMessage response = await client.SendAsync(request);
        Assert.True(expected == response.StatusCode, $"{method} {url}: expected {expected}, got {response.StatusCode}: {await response.Content.ReadAsStringAsync()}");
    }

    private static async Task<ComparisonSnapshot> HttpCompare(HttpClient client, string body)
    {
        using HttpRequestMessage request = Request(HttpMethod.Post, "api/comparison", body, "compare");
        using HttpResponseMessage response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
        ComparisonSnapshot result = JsonSerializer.Deserialize<ComparisonSnapshot>(await response.Content.ReadAsStringAsync(), ViewerConstants.JsonOptions)!;
        for (int attempt = 0; result.State == "running" && attempt < 2000; attempt++)
        {
            await Task.Delay(1);
            result = JsonSerializer.Deserialize<ComparisonSnapshot>(await client.GetStringAsync("api/comparison?id=" + result.Id), ViewerConstants.JsonOptions)!;
        }
        Assert.True(result.State == "completed", result.State + ": " + result.Error);
        return result;
    }

    private sealed class Fixture : IDisposable
    {
        internal Fixture()
        {
            this.Root = Path.Combine(Directory.GetCurrentDirectory(), "comparison-tests-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(this.Root);
            this.Catalog = new SessionCatalog(new ConsoleLogViewerOptions { CaptureConsole = false, SessionsDirectory = this.Root }.Validate());
        }
        internal string Root { get; }
        internal SessionCatalog Catalog { get; }
        internal ViewerStatus Status => new("fixture", StartTime, 10, 0, 0, 0, 0, true, StartTime.AddMinutes(1), 0, 0, 0, 0, 0,
            ViewerConstants.DiskBufferBytes, 0, 1, this.Root, 0);

        internal string Save(LogEntry[] entries, SessionFilters? filters = null, int durationSeconds = 60, bool completed = true, int? retained = null)
        {
            string id = Guid.NewGuid().ToString("N");
            string directory = Path.Combine(this.Root, id);
            Directory.CreateDirectory(directory);
            long bytes;
            using (FileStream journal = File.Create(Path.Combine(directory, "entries.jsonl")))
            using (FileStream index = File.Create(Path.Combine(directory, "entries.idx")))
            {
                byte[] offset = new byte[sizeof(long)];
                for (int item = 0; item < entries.Length; item++)
                {
                    LogEntry source = entries[item];
                    LogEntry entry = new(item + 1, source.Timestamp, source.Stream, source.Severity, source.Category, source.Message, source.IsPartial);
                    BinaryPrimitives.WriteInt64LittleEndian(offset, journal.Position);
                    index.Write(offset);
                    byte[] json = JsonSerializer.SerializeToUtf8Bytes(entry, ViewerConstants.JsonOptions);
                    journal.Write(json);
                    journal.WriteByte((byte)'\n');
                }
                bytes = journal.Length;
            }
            int count = retained ?? entries.Length;
            SessionInfo info = new(id, "fixture", StartTime, completed ? StartTime.AddSeconds(durationSeconds) : null,
                null, count, null, Array.Empty<string>(), "", false, filters);
            ViewerStatus status = this.Status with
            {
                RetainedCount = count, FirstId = count == 0 ? 0 : entries.Length - count + 1, LastId = entries.Length,
                EvictedCount = entries.Length - count, IsCompleted = completed, CompletedAt = info.CompletedAt,
                JournalBytes = bytes, HistoryDirectory = directory,
            };
            File.WriteAllText(Path.Combine(directory, "session.json"),
                JsonSerializer.Serialize(new SavedSession(info, status, Array.Empty<string?>()), ViewerConstants.JsonOptions));
            return id;
        }

        public void Dispose() => Directory.Delete(this.Root, true);
    }
}
