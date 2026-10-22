using System;
using System.Collections.Specialized;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace LogStudio.Tests;

public sealed class LogControlsTests
{
    private const int HistorySize = 1200;
    private const string JournalFileName = "entries.jsonl";
    private const string IndexFileName = "entries.idx";

    [Theory]
    [InlineData(1)]
    [InlineData(7)]
    [InlineData(50)]
    [InlineData(250)]
    [InlineData(500)]
    [InlineData(1000)]
    [InlineData(1001)]
    [InlineData(5000)]
    [InlineData(int.MaxValue)]
    public void PageSizeAppliesToTailFilteredAndAdjacentPages(int size)
    {
        using LogBuffer store = new(new ConsoleLogViewerOptions().Validate());
        for (int index = 1; index <= HistorySize; index++) store.Append($"match-{index}", LogStream.Stdout);
        using LogHistoryReader reader = store.OpenHistory();
        NameValueCollection parameters = new() { [ViewerConstants.PageSizeQuery] = size.ToString(System.Globalization.CultureInfo.InvariantCulture) };
        int expectedCount = Math.Min(size, HistorySize);
        LogSearchResult tail = LogQuery.Parse(parameters).Search(reader, CancellationToken.None);
        Assert.Equal(size, tail.PageSize);
        Assert.Equal(expectedCount, tail.Entries.Length);
        Assert.Equal(HistorySize, tail.MatchCount);
        Assert.Equal(HistorySize - expectedCount + 1, tail.Entries[0].Id);
        parameters[ViewerConstants.SearchQuery] = "match-";
        LogSearchResult filtered = LogQuery.Parse(parameters).Search(reader, CancellationToken.None);
        Assert.Equal(tail.Entries, filtered.Entries);
        parameters[ViewerConstants.SearchQuery] = null;
        parameters[ViewerConstants.AfterQuery] = "0";
        LogSearchResult oldest = LogQuery.Parse(parameters).Search(reader, CancellationToken.None);
        Assert.Equal(1, oldest.Entries[0].Id);
        Assert.Equal(expectedCount, oldest.Entries[^1].Id);
        int adjacentCount = Math.Min(size, HistorySize - expectedCount);
        foreach (string? search in new string?[] { null, "match-" })
        {
            parameters[ViewerConstants.SearchQuery] = search;
            parameters[ViewerConstants.AfterQuery] = null;
            parameters[ViewerConstants.BeforeQuery] = tail.Entries[0].Id.ToString(System.Globalization.CultureInfo.InvariantCulture);
            LogSearchResult older = LogQuery.Parse(parameters).Search(reader, CancellationToken.None);
            Assert.Equal(Enumerable.Range(HistorySize - expectedCount - adjacentCount + 1, adjacentCount).Select(id => (long)id),
                older.Entries.Select(entry => entry.Id));
            parameters[ViewerConstants.BeforeQuery] = null;
            parameters[ViewerConstants.AfterQuery] = oldest.Entries[^1].Id.ToString(System.Globalization.CultureInfo.InvariantCulture);
            LogSearchResult newer = LogQuery.Parse(parameters).Search(reader, CancellationToken.None);
            Assert.Equal(Enumerable.Range(expectedCount + 1, adjacentCount).Select(id => (long)id), newer.Entries.Select(entry => entry.Id));
        }
    }

    [Theory]
    [InlineData(null)]
    [InlineData("missing")]
    public void LargePageSizesDoNotAllocateForMissingEntries(string? search)
    {
        using LogBuffer store = new(new ConsoleLogViewerOptions().Validate());
        using LogHistoryReader reader = store.OpenHistory();
        LogSearchResult page = LogQuery.Parse(new NameValueCollection
        {
            [ViewerConstants.PageSizeQuery] = int.MaxValue.ToString(System.Globalization.CultureInfo.InvariantCulture),
            [ViewerConstants.SearchQuery] = search,
        }).Search(reader, CancellationToken.None);
        Assert.Empty(page.Entries);
        Assert.Equal(int.MaxValue, page.PageSize);
        Assert.Equal(0, page.MatchCount);
    }

    [Theory]
    [InlineData(1001)]
    [InlineData(5000)]
    [InlineData(int.MaxValue)]
    public async Task SearchEndpointAcceptsLargeUserSelectedPageSizes(int size)
    {
        await using ConsoleLogViewer viewer = CaptureTests.StartServer();
        for (int index = 1; index <= HistorySize; index++) viewer.Record($"match-{index}");
        using HttpClient client = new();
        foreach (string filter in new[] { "", "&q=match-" })
        {
            using JsonDocument page = JsonDocument.Parse(await client.GetStringAsync(new Uri(viewer.Url,
                ViewerConstants.SearchRoute + "?pageSize=" + size.ToString(System.Globalization.CultureInfo.InvariantCulture) + filter)));
            Assert.Equal(size, page.RootElement.GetProperty("pageSize").GetInt32());
            Assert.Equal(Math.Min(size, HistorySize), page.RootElement.GetProperty("entries").GetArrayLength());
        }
    }

    [Theory]
    [InlineData("0")]
    [InlineData("-1")]
    [InlineData("")]
    [InlineData("2147483648")]
    [InlineData("invalid")]
    [InlineData("1.5")]
    public void InvalidPageSizesFailExplicitly(string size)
    {
        Assert.Throws<ArgumentException>(() => LogQuery.Parse(new NameValueCollection { [ViewerConstants.PageSizeQuery] = size }));
    }

    [Fact]
    public void ClearDeletesPhysicalHistoryAndKeepsMonotonicIds()
    {
        using LogBuffer store = new(new ConsoleLogViewerOptions { Capacity = 2 }.Validate());
        store.Append("first", LogStream.Stdout, severity: LogSeverity.Warning, category: "Old.Category");
        store.Append("second", LogStream.Stderr);
        store.Append("third", LogStream.Stdout);
        using LogHistoryReader old = store.OpenHistory();
        LogClearResult cleared = store.Clear();
        Assert.Equal(3, cleared.DeletedCount);
        Assert.Equal(3, cleared.Status.ClearedThroughId);
        Assert.Equal(0, cleared.Status.RetainedCount);
        Assert.Equal(0, cleared.Status.FirstId);
        Assert.Equal(3, cleared.Status.LastId);
        Assert.Equal(0, cleared.Status.JournalBytes);
        Assert.Equal(0, cleared.Status.ErrorCount);
        Assert.Equal(0, cleared.Status.WarningCount);
        Assert.Equal(0, cleared.Status.EvictedCount);
        Assert.Equal(0, new FileInfo(Path.Combine(store.StorageDirectory, JournalFileName)).Length);
        Assert.Equal(0, new FileInfo(Path.Combine(store.StorageDirectory, IndexFileName)).Length);
        Assert.Empty(store.Snapshot().Entries);
        Assert.False(store.ReadAfter(0).HasMore);
        Assert.Throws<HistoryClearedException>(() => old.ReadEntries().ToArray());
        store.Append("new", LogStream.Stdout, category: "New.Category");
        LogSnapshot latest = store.Snapshot();
        Assert.Equal("new", Assert.Single(latest.Entries).Message);
        Assert.Equal(4, latest.Entries[0].Id);
        Assert.Equal(4, latest.Status.FirstId);
        Assert.Equal(1, latest.Status.RetainedCount);
        using LogHistoryReader current = store.OpenHistory();
        Assert.Equal(new[] { "New.Category" }, current.Categories);
        Assert.Equal(1, store.Clear().DeletedCount);
        Assert.Equal(0, store.Clear().DeletedCount);
    }

    [Fact]
    public void ClearInvalidatesAlreadyBufferedReaders()
    {
        using LogBuffer store = new(new ConsoleLogViewerOptions().Validate());
        for (int index = 0; index < 20; index++) store.Append($"entry-{index}", LogStream.Stdout);
        using LogHistoryReader reader = store.OpenHistory();
        using System.Collections.Generic.IEnumerator<LogEntry> entries = reader.ReadEntries().GetEnumerator();
        Assert.True(entries.MoveNext());
        store.Clear();
        Assert.Throws<HistoryClearedException>(() => entries.MoveNext());
    }

    [Fact]
    public async Task ConcurrentClearAndCaptureRetainOnlyRecordsAfterTheDeletionPoint()
    {
        using LogBuffer store = new(new ConsoleLogViewerOptions().Validate());
        for (int index = 0; index < 100; index++) store.Append($"before-{index}", LogStream.Stdout);
        Task writer = Task.Run(() =>
        {
            for (int index = 0; index < 1000; index++) store.Append($"racing-{index}", LogStream.Stdout);
        });
        Task<LogClearResult> clearing = Task.Run(store.Clear);
        await Task.WhenAll(writer, clearing);
        LogClearResult cleared = await clearing;
        store.Append("after", LogStream.Stdout);
        LogSnapshot snapshot = store.Snapshot();
        Assert.All(snapshot.Entries, entry => Assert.True(entry.Id > cleared.Status.ClearedThroughId));
        Assert.Equal(1101 - cleared.Status.ClearedThroughId, snapshot.Entries.Length);
        Assert.Equal("after", snapshot.Entries[^1].Message);
        Assert.Equal(1101, snapshot.Entries[^1].Id);
    }

    [Fact]
    public void LibraryClearFlushesPendingConsoleTextBeforeDeletion()
    {
        using ConsoleLogViewer viewer = CaptureTests.StartServer();
        using StringWriter original = new();
        using TextWriter capture = viewer.CreateCaptureWriter(original, LogStream.Stdout);
        capture.Write("pending prompt");
        Assert.Equal(1, viewer.ClearLogs());
        Assert.Empty(viewer.GetLogs());
        capture.WriteLine("new output");
        Assert.Equal("new output", Assert.Single(viewer.GetLogs()).Message);
        Assert.Contains("pending prompt", original.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task ClearEndpointRequiresExplicitSameOriginPostAndDeletesAllHistory()
    {
        await using ConsoleLogViewer viewer = CaptureTests.StartServer();
        viewer.Record("remove-me");
        using HttpClient client = new();
        Uri route = new(viewer.Url, ViewerConstants.ClearRoute);
        using HttpResponseMessage get = await client.GetAsync(route);
        Assert.Equal(HttpStatusCode.MethodNotAllowed, get.StatusCode);
        using HttpResponseMessage noHeader = await client.PostAsync(route, null);
        Assert.Equal(HttpStatusCode.Forbidden, noHeader.StatusCode);
        using HttpRequestMessage otherOrigin = new(HttpMethod.Post, route);
        otherOrigin.Headers.Add(ViewerConstants.ClearRequestHeader, ViewerConstants.ClearRequestAction);
        otherOrigin.Headers.Add(ViewerConstants.OriginHeader, "https://example.invalid");
        using HttpResponseMessage denied = await client.SendAsync(otherOrigin);
        Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        Assert.Single(viewer.GetLogs());
        using HttpRequestMessage clear = new(HttpMethod.Post, route);
        clear.Headers.Add(ViewerConstants.ClearRequestHeader, ViewerConstants.ClearRequestAction);
        using HttpResponseMessage response = await client.SendAsync(clear);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using JsonDocument result = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal(1, result.RootElement.GetProperty("deletedCount").GetInt64());
        Assert.Empty(viewer.GetLogs());
        string exported = await client.GetStringAsync(new Uri(viewer.Url, ViewerConstants.ExportRoute));
        Assert.Equal(string.Empty, exported);
        viewer.Record("after-clear");
        using JsonDocument page = JsonDocument.Parse(await client.GetStringAsync(new Uri(viewer.Url, ViewerConstants.SearchRoute + "?pageSize=7")));
        Assert.Equal(7, page.RootElement.GetProperty("pageSize").GetInt32());
        Assert.Equal("after-clear", page.RootElement.GetProperty("entries")[0].GetProperty("message").GetString());
        Assert.Equal(2, page.RootElement.GetProperty("entries")[0].GetProperty("id").GetInt64());
    }

    [Fact]
    public async Task MultipleLevelsUseOrAndApplyToPagesAndExports()
    {
        await using ConsoleLogViewer viewer = CaptureTests.StartServer();
        viewer.Record("info-row", severity: LogSeverity.Information);
        viewer.Record("warning-row", severity: LogSeverity.Warning);
        viewer.Record("error-row", severity: LogSeverity.Error);
        viewer.Record("debug-row", severity: LogSeverity.Debug);
        string levels = Uri.EscapeDataString("[\"information\",\"error\"]");
        using HttpClient client = new();
        using JsonDocument page = JsonDocument.Parse(await client.GetStringAsync(new Uri(viewer.Url, ViewerConstants.SearchRoute + "?pageSize=1&levels=" + levels)));
        Assert.Equal(2, page.RootElement.GetProperty("matchCount").GetInt64());
        Assert.Equal(1, page.RootElement.GetProperty("entries").GetArrayLength());
        Assert.Equal("error-row", page.RootElement.GetProperty("entries")[0].GetProperty("message").GetString());
        string export = await client.GetStringAsync(new Uri(viewer.Url, ViewerConstants.ExportRoute + "?levels=" + levels));
        Assert.Contains("info-row", export, StringComparison.Ordinal);
        Assert.Contains("error-row", export, StringComparison.Ordinal);
        Assert.DoesNotContain("warning-row", export, StringComparison.Ordinal);
        Assert.DoesNotContain("debug-row", export, StringComparison.Ordinal);
        using JsonDocument none = JsonDocument.Parse(await client.GetStringAsync(new Uri(viewer.Url, ViewerConstants.SearchRoute + "?levels=%5B%5D")));
        Assert.Equal(0, none.RootElement.GetProperty("matchCount").GetInt64());
        using JsonDocument all = JsonDocument.Parse(await client.GetStringAsync(new Uri(viewer.Url, ViewerConstants.SearchRoute)));
        Assert.Equal(4, all.RootElement.GetProperty("matchCount").GetInt64());
    }

    [Theory]
    [InlineData("broken")]
    [InlineData("null")]
    [InlineData("[null]")]
    [InlineData("[\"unknown\"]")]
    [InlineData("[\"all\"]")]
    public void InvalidMultiLevelFiltersAreRejected(string levels)
    {
        Assert.Throws<ArgumentException>(() => LogQuery.Parse(new NameValueCollection { [ViewerConstants.LevelsQuery] = levels }));
    }
}
