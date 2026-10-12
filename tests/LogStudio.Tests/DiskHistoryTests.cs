using System;
using System.Collections.Specialized;
using System.IO;
using System.Linq;
using System.Threading;
using Xunit;

namespace LogStudio.Tests;

public sealed class DiskHistoryTests
{
    private const int MemoryTestEntryCount = 20_000;
    private const int MemoryTestMessageLength = 1024;
    private const long MaximumRetainedHeapGrowth = 8 * 1024 * 1024;
    private const string JournalFileName = "entries.jsonl";
    private const string IndexFileName = "entries.idx";
    private const string SyntheticCategory = "Disk.Tests";

    [Fact]
    public void LargeHistoryGrowsDiskInsteadOfKeepingEntriesOnTheHeap()
    {
        using LogBuffer store = new(new ConsoleLogViewerOptions().Validate());
        store.Append("warmup", LogStream.Stdout);
        long before = GC.GetTotalMemory(true);
        string message = new('x', MemoryTestMessageLength);
        for (int index = 0; index < MemoryTestEntryCount; index++) store.Append(message, LogStream.Stdout);
        long growth = GC.GetTotalMemory(true) - before;
        ViewerStatus status = store.GetStatus();
        Assert.True(growth < MaximumRetainedHeapGrowth, $"Retained heap grew by {growth} bytes for disk-backed history.");
        Assert.Equal(MemoryTestEntryCount + 1, status.RetainedCount);
        Assert.Equal(ViewerConstants.DiskBufferBytes * 2, status.IoBufferBytes);
        Assert.True(status.JournalBytes > MemoryTestEntryCount * MemoryTestMessageLength);
        Assert.InRange(status.PendingEntries, 0, status.FlushEveryEntries - 1);
        GC.KeepAlive(store);
    }

    [Fact]
    public void FlushCadenceAndReadsMakeLatestBufferedEntriesAvailable()
    {
        using LogBuffer store = new(new ConsoleLogViewerOptions { FlushEveryEntries = 3 }.Validate());
        store.Append("one", LogStream.Stdout);
        store.Append("two", LogStream.Stderr);
        Assert.Equal(2, store.GetStatus().PendingEntries);
        store.Append("three", LogStream.Stdout);
        Assert.Equal(0, store.GetStatus().PendingEntries);
        Assert.True(new FileInfo(Path.Combine(store.StorageDirectory, JournalFileName)).Length > 0);
        store.Append("four", LogStream.Stdout);
        Assert.Equal(1, store.GetStatus().PendingEntries);
        using LogHistoryReader history = store.OpenHistory();
        Assert.Equal(new[] { "one", "two", "three", "four" }, history.ReadEntries().Select(entry => entry.Message));
        Assert.Equal(0, store.GetStatus().PendingEntries);
    }

    [Fact]
    public void DiskReaderSeeksAcrossUtf8AndLengthBoundaries()
    {
        using LogBuffer store = new(new ConsoleLogViewerOptions { MaxLineLength = 64, FlushEveryEntries = 2 }.Validate());
        store.Append("first", LogStream.Stdout);
        store.Append("Unicode \u05e9\u05dc\u05d5\u05dd \U0001F642", LogStream.Stdout);
        store.Append(new string('x', 400), LogStream.Stderr);
        LogBatch replay = store.ReadAfter(1);
        Assert.Equal("Unicode \u05e9\u05dc\u05d5\u05dd \U0001F642", replay.Entries[0].Message);
        Assert.Equal(new string('x', 400), string.Concat(replay.Entries.Skip(1).Select(entry => entry.Message)));
        Assert.All(replay.Entries, entry => Assert.InRange(entry.Message.Length, 1, 64));
    }

    [Fact]
    public void ReaderSnapshotRemainsStableWhileCaptureContinues()
    {
        using LogBuffer store = new(new ConsoleLogViewerOptions().Validate());
        store.Append("one", LogStream.Stdout);
        using LogHistoryReader first = store.OpenHistory();
        store.Append("two", LogStream.Stdout);
        Assert.Equal("one", Assert.Single(first.ReadEntries()).Message);
        using LogHistoryReader second = store.OpenHistory();
        Assert.Equal(new[] { "one", "two" }, second.ReadEntries().Select(entry => entry.Message));
    }

    [Fact]
    public void TemporaryHistoryIsPrivateAndDeletedOnDispose()
    {
        ConsoleLogViewer viewer = CaptureTests.StartServer();
        string directory = viewer.HistoryDirectory;
        viewer.Record("private synthetic history");
        viewer.GetLogs();
        Assert.True(Directory.Exists(directory));
        if (!OperatingSystem.IsWindows())
        {
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute, File.GetUnixFileMode(directory));
            foreach (string file in Directory.GetFiles(directory))
                Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(file));
        }

        viewer.Dispose();
        viewer.Dispose();
        Assert.False(Directory.Exists(directory));
        Assert.Throws<ObjectDisposedException>(() => viewer.GetLogs());
    }

    [Fact]
    public void DamagedSeekIndexFailsExplicitly()
    {
        using LogBuffer store = new(new ConsoleLogViewerOptions().Validate());
        store.Append("entry", LogStream.Stdout);
        using (LogHistoryReader history = store.OpenHistory()) Assert.Single(history.ReadEntries());
        using (FileStream index = new(Path.Combine(store.StorageDirectory, IndexFileName), FileMode.Open, FileAccess.Write, FileShare.ReadWrite))
            index.SetLength(0);
        Assert.Throws<EndOfStreamException>(() => store.Snapshot());
    }

    [Fact]
    public void CategorySuggestionsAreBoundedWithoutRestrictingCategorySearch()
    {
        using LogBuffer store = new(new ConsoleLogViewerOptions().Validate());
        for (int index = 0; index < ViewerConstants.MaximumCategorySuggestions + 10; index++)
            store.Append($"entry-{index}", LogStream.Stdout, category: $"category-{index}");
        using LogHistoryReader history = store.OpenHistory();
        Assert.Equal(ViewerConstants.MaximumCategorySuggestions, history.Categories.Length);
        LogQuery query = LogQuery.Parse(new NameValueCollection { [ViewerConstants.SearchQuery] = $"category:category-{ViewerConstants.MaximumCategorySuggestions + 9}" });
        LogSearchResult result = query.Search(history, CancellationToken.None);
        Assert.Equal(1, result.MatchCount);
    }

    [Theory]
    [InlineData("alpha beta", false, 2)]
    [InlineData("\"alpha beta\" -cancelled", false, 1)]
    [InlineData("ALPHA", true, 0)]
    [InlineData("ALPHA", false, 2)]
    [InlineData("id:2", false, 1)]
    [InlineData("category:Disk.Tests level:warning", false, 1)]
    [InlineData("stream:stderr message:\"skill failed\"", false, 1)]
    [InlineData("\"(a+)+$\"", false, 0)]
    public void DiskSearchPreservesLiteralSearchGrammar(string search, bool matchCase, long expected)
    {
        using LogBuffer store = new(new ConsoleLogViewerOptions().Validate());
        store.Append("alpha beta", LogStream.Stdout, severity: LogSeverity.Warning, category: SyntheticCategory);
        store.Append("alpha beta cancelled", LogStream.Stdout);
        store.Append("skill failed", LogStream.Stderr);
        using LogHistoryReader history = store.OpenHistory();
        LogQuery query = LogQuery.Parse(new NameValueCollection
        {
            [ViewerConstants.SearchQuery] = search,
            [ViewerConstants.MatchCaseQuery] = matchCase.ToString(),
        });
        Assert.Equal(expected, query.Search(history, CancellationToken.None).MatchCount);
    }

    [Fact]
    public void DiskPagingReturnsAtMostOnePageAndAccurateWholeHistoryCounts()
    {
        using LogBuffer store = new(new ConsoleLogViewerOptions().Validate());
        for (int index = 1; index <= 10_005; index++)
            store.Append($"entry-{index}", LogStream.Stdout, severity: index % 2 == 0 ? LogSeverity.Warning : LogSeverity.Information);
        using LogHistoryReader history = store.OpenHistory();
        LogSearchResult tail = LogQuery.Parse(new NameValueCollection()).Search(history, CancellationToken.None);
        Assert.Equal(ViewerConstants.PageSize, tail.Entries.Length);
        Assert.Equal(10_005, tail.MatchCount);
        Assert.Equal(5002, tail.WarningCount);
        Assert.Equal(9756, tail.Entries[0].Id);
        Assert.Equal(9755, tail.OlderCount);
        Assert.Equal(0, tail.NewerCount);

        LogSearchResult oldest = LogQuery.Parse(new NameValueCollection { [ViewerConstants.BeforeQuery] = "251" }).Search(history, CancellationToken.None);
        Assert.Equal(1, oldest.Entries[0].Id);
        Assert.Equal(250, oldest.Entries[^1].Id);
        LogSearchResult next = LogQuery.Parse(new NameValueCollection { [ViewerConstants.AfterQuery] = "250" }).Search(history, CancellationToken.None);
        Assert.Equal(251, next.Entries[0].Id);
        Assert.Equal(500, next.Entries[^1].Id);
        LogSearchResult early = LogQuery.Parse(new NameValueCollection { [ViewerConstants.SearchQuery] = "id:1" }).Search(history, CancellationToken.None);
        Assert.Equal("entry-1", Assert.Single(early.Entries).Message);
    }

    [Fact]
    public void SearchHonorsCategoryTimeStreamSeverityClearAndPauseBounds()
    {
        using LogBuffer store = new(new ConsoleLogViewerOptions().Validate());
        store.Append("first", LogStream.Stdout, severity: LogSeverity.Warning, category: SyntheticCategory);
        store.Append("second", LogStream.Stderr, severity: LogSeverity.Error, category: SyntheticCategory);
        store.Append("third", LogStream.Stderr, severity: LogSeverity.Error, category: SyntheticCategory);
        using LogHistoryReader history = store.OpenHistory();
        LogQuery query = LogQuery.Parse(new NameValueCollection
        {
            [ViewerConstants.MinimumIdQuery] = "1",
            [ViewerConstants.MaximumIdQuery] = "2",
            [ViewerConstants.StreamQuery] = "stderr",
            [ViewerConstants.SeverityQuery] = "errorPlus",
            [ViewerConstants.CategoryQuery] = "\"Disk.Tests\"",
            [ViewerConstants.SinceQuery] = DateTimeOffset.UtcNow.AddMinutes(-1).ToString("O"),
        });
        LogSearchResult result = query.Search(history, CancellationToken.None);
        Assert.Equal("second", Assert.Single(result.Entries).Message);
        Assert.Equal(1, result.ErrorCount);
        Assert.Equal(0, result.WarningCount);
    }
}
