using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace LogStudio.Tests;

public sealed class HttpTests
{
    private const int UnlimitedHistoryEntryCount = 10_005;

    [Fact]
    public async Task AssetsAndApisAreAvailableAtTheRootUrl()
    {
        await using ConsoleLogViewer viewer = CaptureTests.StartServer();
        Assert.Equal("http", viewer.Url.Scheme);
        Assert.Equal(ViewerConstants.LoopbackHost, viewer.Url.Host);
        Assert.Equal("/", viewer.Url.AbsolutePath);
        Assert.Equal(viewer.Url.GetLeftPart(UriPartial.Authority) + "/", viewer.Url.AbsoluteUri);
        using HttpClient client = new();
        using HttpResponseMessage index = await client.GetAsync(viewer.Url);
        Assert.Equal(HttpStatusCode.OK, index.StatusCode);
        Assert.Equal("no-store", index.Headers.CacheControl?.ToString());
        Assert.Contains("frame-ancestors 'none'", Assert.Single(index.Headers.GetValues(ViewerConstants.ContentSecurityPolicyHeader)), StringComparison.Ordinal);
        string html = await index.Content.ReadAsStringAsync();
        Assert.Contains("Log Studio", html, StringComparison.Ordinal);
        Assert.Contains("id=\"root\"", html, StringComparison.Ordinal);
        Assert.DoesNotContain(ViewerConstants.NoncePlaceholder, html, StringComparison.Ordinal);
        foreach (string file in new[] { ViewerConstants.StylesFile, ViewerConstants.ScriptFile, ViewerConstants.LicensesFile })
        {
            using HttpResponseMessage asset = await client.GetAsync(new Uri(viewer.Url, file));
            Assert.Equal(HttpStatusCode.OK, asset.StatusCode);
        }

        using HttpResponseMessage root = await client.GetAsync(new Uri(viewer.Url.GetLeftPart(UriPartial.Authority)));
        Assert.Equal(HttpStatusCode.OK, root.StatusCode);
        using HttpResponseMessage snapshot = await client.GetAsync(new Uri(viewer.Url.GetLeftPart(UriPartial.Authority) + "/api/logs"));
        Assert.Equal(HttpStatusCode.OK, snapshot.StatusCode);
        using HttpResponseMessage unknown = await client.GetAsync(new Uri(viewer.Url, "unknown/api/logs"));
        Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
    }

    [Fact]
    public async Task SnapshotShapeRetentionAndCompletionAreExact()
    {
        await using ConsoleLogViewer viewer = CaptureTests.StartServer(capacity: 3);
        for (int index = 1; index <= 5; index++) viewer.Record($"entry-{index}");
        viewer.Complete(7);
        using HttpClient client = new();
        using JsonDocument snapshot = JsonDocument.Parse(await client.GetStringAsync(new Uri(viewer.Url, ViewerConstants.SnapshotRoute)));
        JsonElement root = snapshot.RootElement;
        Assert.Equal(new[] { 3L, 4L, 5L }, root.GetProperty("entries").EnumerateArray().Select(entry => entry.GetProperty("id").GetInt64()));
        JsonElement status = root.GetProperty("status");
        Assert.Equal(3, status.GetProperty("retainedCount").GetInt32());
        Assert.Equal(3, status.GetProperty("capacity").GetInt32());
        Assert.Equal(2, status.GetProperty("evictedCount").GetInt64());
        Assert.True(status.GetProperty("isCompleted").GetBoolean());
        Assert.Equal(7, status.GetProperty("exitCode").GetInt32());
        Assert.Equal("stdout", root.GetProperty("entries")[0].GetProperty("stream").GetString());
        Assert.Equal("output", root.GetProperty("entries")[0].GetProperty("severity").GetString());
    }

    [Fact]
    public async Task SnapshotAndReplayKeepEntireHistoryBeyondTenThousandEntries()
    {
        await using ConsoleLogViewer viewer = CaptureTests.StartServer();
        for (int index = 1; index <= UnlimitedHistoryEntryCount; index++) viewer.Record($"entry-{index}");
        viewer.Complete(0);
        using HttpClient client = new() { Timeout = Timeout.InfiniteTimeSpan };
        using JsonDocument snapshot = JsonDocument.Parse(await client.GetStringAsync(new Uri(viewer.Url, ViewerConstants.SnapshotRoute)));
        JsonElement root = snapshot.RootElement;
        Assert.Equal(UnlimitedHistoryEntryCount, root.GetProperty("entries").GetArrayLength());
        Assert.Equal(0, root.GetProperty("status").GetProperty("capacity").GetInt32());
        Assert.Equal(0, root.GetProperty("status").GetProperty("evictedCount").GetInt64());
        Assert.Equal("entry-1", root.GetProperty("entries")[0].GetProperty("message").GetString());

        using HttpResponseMessage response = await client.GetAsync(new Uri(viewer.Url, ViewerConstants.EventsRoute), HttpCompletionOption.ResponseHeadersRead);
        using StreamReader reader = new(await response.Content.ReadAsStreamAsync());
        long cursor = 0;
        while (cursor < UnlimitedHistoryEntryCount)
        {
            SseEvent batch = await ReadUntilAsync(reader, ViewerConstants.BatchEvent);
            Assert.InRange(batch.Data.GetArrayLength(), 1, ViewerConstants.StreamBatchSize);
            foreach (JsonElement entry in batch.Data.EnumerateArray())
            {
                Assert.Equal(++cursor, entry.GetProperty("id").GetInt64());
                Assert.Equal($"entry-{cursor}", entry.GetProperty("message").GetString());
            }

            Assert.Equal(cursor, batch.Id);
        }

        Assert.Equal(UnlimitedHistoryEntryCount, cursor);
    }

    [Fact]
    public async Task PagedSearchAndStreamingExportCoverTheFullDiskHistory()
    {
        await using ConsoleLogViewer viewer = CaptureTests.StartServer();
        for (int index = 1; index <= UnlimitedHistoryEntryCount; index++) viewer.Record($"entry-{index}");
        viewer.Complete(0);
        using HttpClient client = new();
        using JsonDocument page = JsonDocument.Parse(await client.GetStringAsync(new Uri(viewer.Url, ViewerConstants.SearchRoute)));
        Assert.Equal(ViewerConstants.PageSize, page.RootElement.GetProperty("entries").GetArrayLength());
        Assert.Equal(UnlimitedHistoryEntryCount, page.RootElement.GetProperty("matchCount").GetInt64());
        Assert.Equal(UnlimitedHistoryEntryCount - ViewerConstants.PageSize + 1, page.RootElement.GetProperty("entries")[0].GetProperty("id").GetInt64());
        using JsonDocument oldest = JsonDocument.Parse(await client.GetStringAsync(new Uri(viewer.Url, ViewerConstants.SearchRoute + "?q=id%3A1")));
        Assert.Equal("entry-1", oldest.RootElement.GetProperty("entries")[0].GetProperty("message").GetString());
        using HttpResponseMessage export = await client.GetAsync(new Uri(viewer.Url, ViewerConstants.ExportRoute), HttpCompletionOption.ResponseHeadersRead);
        Assert.Equal("application/x-ndjson", export.Content.Headers.ContentType?.MediaType);
        Assert.Equal("attachment", export.Content.Headers.ContentDisposition?.DispositionType);
        using StreamReader reader = new(await export.Content.ReadAsStreamAsync());
        long cursor = 0;
        string? line;
        while ((line = await reader.ReadLineAsync()) is not null)
        {
            using JsonDocument entry = JsonDocument.Parse(line);
            Assert.Equal(++cursor, entry.RootElement.GetProperty("id").GetInt64());
        }

        Assert.Equal(UnlimitedHistoryEntryCount, cursor);
    }

    [Fact]
    public async Task ExportAndSearchApplyTheSameIncludeExcludeConditions()
    {
        await using ConsoleLogViewer viewer = CaptureTests.StartServer();
        viewer.Record("retry keep", category: "Application.Skill");
        viewer.Record("retry noisy", category: "Microsoft.Hosting");
        viewer.Record("other", category: "Application.Skill");
        LogCondition[] conditions =
        {
            new("include", "message", "regex", "^retry "),
            new("exclude", "category", "startsWith", "Microsoft."),
        };
        string query = "?filters=" + Uri.EscapeDataString(JsonSerializer.Serialize(conditions, ViewerConstants.JsonOptions));
        using HttpClient client = new();
        using JsonDocument page = JsonDocument.Parse(await client.GetStringAsync(new Uri(viewer.Url, ViewerConstants.SearchRoute + query)));
        Assert.Equal(1, page.RootElement.GetProperty("matchCount").GetInt64());
        string export = await client.GetStringAsync(new Uri(viewer.Url, ViewerConstants.ExportRoute + query));
        using JsonDocument entry = JsonDocument.Parse(export.Trim());
        Assert.Equal("retry keep", entry.RootElement.GetProperty("message").GetString());
    }

    [Theory]
    [InlineData("?q=%22unfinished")]
    [InlineData("?filters=broken")]
    [InlineData("?includeMode=unknown")]
    [InlineData("?stream=unknown")]
    [InlineData("?category=123")]
    [InlineData("?before=1&after=2")]
    [InlineData("?since=invalid")]
    [InlineData("?until=invalid")]
    [InlineData("?since=2026-10-12T00:00:00Z&until=2026-10-11T00:00:00Z")]
    public async Task InvalidSearchRequestsReturnActionableErrors(string query)
    {
        await using ConsoleLogViewer viewer = CaptureTests.StartServer();
        using HttpClient client = new();
        using HttpResponseMessage response = await client.GetAsync(new Uri(viewer.Url, ViewerConstants.SearchRoute + query));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        using JsonDocument error = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.False(string.IsNullOrWhiteSpace(error.RootElement.GetProperty("error").GetString()));
    }

    [Fact]
    public async Task CsvExportStreamsAllFilteredMatchesRatherThanOnlyTheVisiblePage()
    {
        await using ConsoleLogViewer viewer = CaptureTests.StartServer();
        for (int index = 1; index <= 300; index++)
            viewer.Record("keep " + index, severity: index % 2 == 0 ? LogSeverity.Error : LogSeverity.Information);
        using HttpClient client = new();
        string parameters = "?q=keep&levels=%5B%22error%22%5D&minId=10&maxId=290&pageSize=1";
        using HttpResponseMessage csv = await client.GetAsync(new Uri(viewer.Url, ViewerConstants.ExportRoute + parameters + "&format=csv"));
        Assert.Equal(HttpStatusCode.OK, csv.StatusCode);
        Assert.Equal("text/csv", csv.Content.Headers.ContentType?.MediaType);
        Assert.EndsWith(".csv", csv.Content.Headers.ContentDisposition?.FileName?.Trim('"'), StringComparison.Ordinal);
        byte[] bytes = await csv.Content.ReadAsByteArrayAsync();
        Assert.Equal(new byte[] { 0xEF, 0xBB, 0xBF }, bytes.Take(3));
        string[] lines = (await csv.Content.ReadAsStringAsync()).TrimStart('\uFEFF').Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(LogCsv.Header, lines[0]);
        Assert.Equal(141, lines.Length);
        Assert.StartsWith("\"12\",", lines[1], StringComparison.Ordinal);
        Assert.StartsWith("\"290\",", lines[^1], StringComparison.Ordinal);
        using JsonDocument page = JsonDocument.Parse(await client.GetStringAsync(new Uri(viewer.Url, ViewerConstants.SearchRoute + parameters)));
        Assert.Single(page.RootElement.GetProperty("entries").EnumerateArray());
        Assert.Equal(140, page.RootElement.GetProperty("matchCount").GetInt64());
        using HttpResponseMessage invalid = await client.GetAsync(new Uri(viewer.Url, ViewerConstants.ExportRoute + "?format=unknown"));
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
    }

    [Fact]
    public async Task ExactTimeBoundsApplyToSearchAndBothExportFormats()
    {
        await using ConsoleLogViewer viewer = CaptureTests.StartServer();
        viewer.Record("at boundary");
        LogEntry entry = Assert.Single(viewer.GetLogs());
        string timestamp = Uri.EscapeDataString(entry.Timestamp.ToString("O", System.Globalization.CultureInfo.InvariantCulture));
        using HttpClient client = new();
        string bounds = "?since=" + timestamp + "&until=" + timestamp;
        using JsonDocument included = JsonDocument.Parse(await client.GetStringAsync(new Uri(viewer.Url, ViewerConstants.SearchRoute + bounds)));
        Assert.Equal(1, included.RootElement.GetProperty("matchCount").GetInt64());
        string jsonl = await client.GetStringAsync(new Uri(viewer.Url, ViewerConstants.ExportRoute + bounds));
        Assert.Contains("at boundary", jsonl, StringComparison.Ordinal);
        string csv = await client.GetStringAsync(new Uri(viewer.Url, ViewerConstants.ExportRoute + bounds + "&format=csv"));
        Assert.Contains("\"at boundary\"", csv, StringComparison.Ordinal);
        string before = "?until=" + Uri.EscapeDataString(entry.Timestamp.AddTicks(-1).ToString("O", System.Globalization.CultureInfo.InvariantCulture));
        using JsonDocument excluded = JsonDocument.Parse(await client.GetStringAsync(new Uri(viewer.Url, ViewerConstants.SearchRoute + before)));
        Assert.Equal(0, excluded.RootElement.GetProperty("matchCount").GetInt64());
        Assert.Empty(await client.GetStringAsync(new Uri(viewer.Url, ViewerConstants.ExportRoute + before)));
    }

    [Fact]
    public async Task CorruptDiskIndexProducesAnExplicitServerError()
    {
        await using ConsoleLogViewer viewer = CaptureTests.StartServer();
        viewer.Record("synthetic log");
        viewer.GetLogs();
        using (FileStream index = new(Path.Combine(viewer.HistoryDirectory, "entries.idx"), FileMode.Open, FileAccess.Write, FileShare.ReadWrite))
            index.SetLength(0);
        using HttpClient client = new();
        using HttpResponseMessage response = await client.GetAsync(new Uri(viewer.Url, ViewerConstants.SearchRoute));
        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        using JsonDocument error = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Contains("Could not read temporary history", error.RootElement.GetProperty("error").GetString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task BrowserUpdateStreamSendsMetadataWithoutReplayingHistory()
    {
        await using ConsoleLogViewer viewer = CaptureTests.StartServer();
        viewer.Record("existing");
        using HttpClient client = new() { Timeout = Timeout.InfiniteTimeSpan };
        using HttpResponseMessage response = await client.GetAsync(new Uri(viewer.Url, ViewerConstants.UpdatesRoute), HttpCompletionOption.ResponseHeadersRead);
        using StreamReader reader = new(await response.Content.ReadAsStreamAsync());
        SseEvent initial = await ReadUntilAsync(reader, ViewerConstants.StatusEvent);
        Assert.Equal(1, initial.Data.GetProperty("lastId").GetInt64());
        viewer.Record("new");
        SseEvent update = await ReadUntilAsync(reader, ViewerConstants.StatusEvent);
        Assert.Equal(2, update.Data.GetProperty("lastId").GetInt64());
        Assert.False(update.Data.TryGetProperty("entries", out _));
    }

    [Fact]
    public async Task RenameNotifiesIdleLiveClientsWithoutChangingHistory()
    {
        await using ConsoleLogViewer viewer = CaptureTests.StartServer();
        viewer.Record("existing");
        using HttpClient client = new() { Timeout = Timeout.InfiniteTimeSpan };
        using HttpResponseMessage response = await client.GetAsync(new Uri(viewer.Url, ViewerConstants.UpdatesRoute), HttpCompletionOption.ResponseHeadersRead);
        using StreamReader reader = new(await response.Content.ReadAsStreamAsync());
        SseEvent initial = await ReadUntilAsync(reader, ViewerConstants.StatusEvent);
        viewer.RenameSession("Live investigation");
        SseEvent update = await ReadUntilAsync(reader, ViewerConstants.StatusEvent);
        Assert.Equal("Live investigation", update.Data.GetProperty("applicationName").GetString());
        Assert.Equal(initial.Data.GetProperty("revision").GetInt64() + 1, update.Data.GetProperty("revision").GetInt64());
        Assert.Equal(1, update.Data.GetProperty("lastId").GetInt64());
        Assert.False(update.Data.GetProperty("isCompleted").GetBoolean());
        Assert.Equal("existing", Assert.Single(viewer.GetLogs()).Message);
    }

    [Fact]
    public async Task LiveStreamReplaysHistoryAndDeliversNewOutput()
    {
        await using ConsoleLogViewer viewer = CaptureTests.StartServer();
        viewer.Record("before-connect");
        using HttpClient client = new() { Timeout = Timeout.InfiniteTimeSpan };
        using HttpResponseMessage response = await client.GetAsync(new Uri(viewer.Url, ViewerConstants.EventsRoute), HttpCompletionOption.ResponseHeadersRead);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/event-stream", response.Content.Headers.ContentType?.MediaType);
        using StreamReader reader = new(await response.Content.ReadAsStreamAsync());
        SseEvent first = await ReadUntilAsync(reader, ViewerConstants.BatchEvent);
        Assert.Equal("before-connect", first.Data[0].GetProperty("message").GetString());
        viewer.Record("after-connect", LogStream.Stderr);
        SseEvent live = await ReadUntilAsync(reader, ViewerConstants.BatchEvent);
        Assert.Equal("after-connect", live.Data[0].GetProperty("message").GetString());
        Assert.Equal("stderr", live.Data[0].GetProperty("stream").GetString());
        Assert.Equal(2, live.Id);
    }

    [Fact]
    public async Task ReconnectionUsesLastEventIdAndReportsExpiredHistory()
    {
        await using ConsoleLogViewer viewer = CaptureTests.StartServer(capacity: 3);
        for (int index = 1; index <= 6; index++) viewer.Record($"entry-{index}");
        using HttpClient client = new() { Timeout = Timeout.InfiniteTimeSpan };
        using HttpRequestMessage request = new(HttpMethod.Get, new Uri(viewer.Url, ViewerConstants.EventsRoute + "?after=0"));
        request.Headers.Add(ViewerConstants.LastEventIdHeader, "1");
        using HttpResponseMessage response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
        using StreamReader reader = new(await response.Content.ReadAsStreamAsync());
        SseEvent gap = await ReadUntilAsync(reader, ViewerConstants.GapEvent);
        Assert.Equal(2, gap.Data.GetProperty("missedCount").GetInt64());
        SseEvent batch = await ReadUntilAsync(reader, ViewerConstants.BatchEvent);
        Assert.Equal(new[] { 4L, 5L, 6L }, batch.Data.EnumerateArray().Select(entry => entry.GetProperty("id").GetInt64()));
    }

    [Theory]
    [InlineData("?after=-1")]
    [InlineData("?after=hello")]
    [InlineData("?after=")]
    [InlineData("?after=999999")]
    public async Task InvalidReplayCursorReturnsAnExplicitError(string query)
    {
        await using ConsoleLogViewer viewer = CaptureTests.StartServer();
        using HttpClient client = new();
        using HttpResponseMessage response = await client.GetAsync(new Uri(viewer.Url, ViewerConstants.EventsRoute + query));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        using JsonDocument error = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.False(string.IsNullOrWhiteSpace(error.RootElement.GetProperty("error").GetString()));
    }

    [Fact]
    public async Task CrossOriginAndMutationRequestsAreRejected()
    {
        await using ConsoleLogViewer viewer = CaptureTests.StartServer();
        using HttpClient client = new();
        using HttpRequestMessage crossOrigin = new(HttpMethod.Get, new Uri(viewer.Url, ViewerConstants.SnapshotRoute));
        crossOrigin.Headers.Add(ViewerConstants.OriginHeader, "https://example.invalid");
        crossOrigin.Headers.Add(ViewerConstants.FetchSiteHeader, "same-origin");
        using HttpResponseMessage denied = await client.SendAsync(crossOrigin);
        Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        using HttpResponseMessage mutation = await client.PostAsync(new Uri(viewer.Url, ViewerConstants.SnapshotRoute), null);
        Assert.Equal(HttpStatusCode.MethodNotAllowed, mutation.StatusCode);
    }

    [Theory]
    [InlineData("cross-site")]
    [InlineData("same-site")]
    [InlineData("unexpected")]
    public async Task ForeignBrowserRequestsWithoutOriginAreRejected(string fetchSite)
    {
        await using ConsoleLogViewer viewer = CaptureTests.StartServer();
        viewer.Record("retained");
        using HttpClient client = new();
        foreach (string route in new[] { "", ViewerConstants.ScriptFile, ViewerConstants.SnapshotRoute, ViewerConstants.ClearRoute })
        {
            using HttpRequestMessage request = new(
                route == ViewerConstants.ClearRoute ? HttpMethod.Post : HttpMethod.Get,
                new Uri(viewer.Url, route));
            request.Headers.Add(ViewerConstants.FetchSiteHeader, fetchSite);
            request.Headers.Add(ViewerConstants.ClearRequestHeader, ViewerConstants.ClearRequestAction);
            using HttpResponseMessage response = await client.SendAsync(request);
            Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        }
        Assert.Equal("retained", Assert.Single(viewer.GetLogs()).Message);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("none")]
    [InlineData("same-origin")]
    public async Task DirectAndSameOriginRequestsAreAllowed(string? fetchSite)
    {
        await using ConsoleLogViewer viewer = CaptureTests.StartServer();
        using HttpClient client = new();
        foreach (string route in new[] { "", ViewerConstants.ScriptFile, ViewerConstants.SnapshotRoute })
        {
            using HttpRequestMessage request = new(HttpMethod.Get, new Uri(viewer.Url, route));
            if (fetchSite is not null) request.Headers.Add(ViewerConstants.FetchSiteHeader, fetchSite);
            using HttpResponseMessage response = await client.SendAsync(request);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }
    }

    [Fact]
    public async Task SlowTabsAreBoundedAndShutdownClosesActiveStreams()
    {
        ConsoleLogViewer viewer = CaptureTests.StartServer();
        using HttpClient client = new() { Timeout = Timeout.InfiniteTimeSpan };
        List<HttpResponseMessage> responses = new();
        try
        {
            for (int index = 0; index < ViewerConstants.MaximumLiveClients; index++)
            {
                responses.Add(await client.GetAsync(new Uri(viewer.Url, ViewerConstants.EventsRoute), HttpCompletionOption.ResponseHeadersRead));
            }

            using HttpResponseMessage overflow = await client.GetAsync(new Uri(viewer.Url, ViewerConstants.EventsRoute));
            Assert.Equal(HttpStatusCode.TooManyRequests, overflow.StatusCode);
            await viewer.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
        }
        finally
        {
            foreach (HttpResponseMessage response in responses) response.Dispose();
            await viewer.DisposeAsync();
        }
    }

    [Fact]
    public async Task MultipleViewersGetIndependentPortsAndSessions()
    {
        ConsoleLogViewer[] viewers = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ => Task.Run(() => CaptureTests.StartServer())));
        try
        {
            Assert.Equal(viewers.Length, viewers.Select(viewer => viewer.Url.Port).Distinct().Count());
            Assert.All(viewers, viewer => Assert.Equal("/", viewer.Url.AbsolutePath));
        }
        finally
        {
            foreach (ConsoleLogViewer viewer in viewers) await viewer.DisposeAsync();
        }
    }

    [Fact]
    public void AnOccupiedExplicitPortFailsInsteadOfChangingTheRequestedPort()
    {
        using TcpListener occupied = new(IPAddress.Loopback, 0);
        occupied.Start();
        int port = ((IPEndPoint)occupied.LocalEndpoint).Port;
        Assert.Throws<HttpListenerException>(() => ConsoleLogViewer.Start(new ConsoleLogViewerOptions { Port = port, CaptureConsole = false }));
    }

    private static async Task<SseEvent> ReadUntilAsync(StreamReader reader, string eventName)
    {
        using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(5));
        string? type = null;
        string? data = null;
        long? id = null;
        while (true)
        {
            string? line = await reader.ReadLineAsync(timeout.Token);
            Assert.NotNull(line);
            if (line.StartsWith("event: ", StringComparison.Ordinal)) type = line[7..];
            else if (line.StartsWith("data: ", StringComparison.Ordinal)) data = line[6..];
            else if (line.StartsWith("id: ", StringComparison.Ordinal)) id = long.Parse(line[4..], System.Globalization.CultureInfo.InvariantCulture);
            else if (line.Length == 0 && type is not null && data is not null)
            {
                if (type == eventName)
                {
                    using JsonDocument document = JsonDocument.Parse(data);
                    return new SseEvent(id, document.RootElement.Clone());
                }

                type = null;
                data = null;
                id = null;
            }
        }
    }

    private sealed record SseEvent(long? Id, JsonElement Data);
}
