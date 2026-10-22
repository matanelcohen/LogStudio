using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace LogStudio.Tests;

public sealed class ApplicationHistoryTests
{
    [Fact]
    public async Task SwitchingRestoresDiskHistoryAndKeepsClearSearchCountersAndExportsIsolated()
    {
        using ConsoleLogViewer viewer = StartViewer();
        using HttpClient client = new();
        viewer.SelectApplicationHistory("process:1:10", "App A");
        viewer.Record("A warning", severity: LogSeverity.Warning, category: "A.Category");
        viewer.Record("A error", severity: LogSeverity.Error, category: "A.Category");
        LogEntry[] original = viewer.GetLogs().ToArray();
        string firstDirectory = viewer.HistoryDirectory;
        viewer.RenameSession("Renamed A");
        SessionInfo firstSession = await CurrentSessionAsync(client, viewer);
        LogSearchResult first = await SearchAsync(client, viewer);

        viewer.SelectApplicationHistory("process:2:20", "App B");
        string secondDirectory = viewer.HistoryDirectory;
        Assert.NotEqual(firstDirectory, secondDirectory);
        Assert.Empty(viewer.GetLogs());
        viewer.Record("B error", severity: LogSeverity.Error, category: "B.Category");
        LogEntry second = Assert.Single(viewer.GetLogs());
        LogSearchResult other = await SearchAsync(client, viewer);
        Assert.True(other.Status.Revision > first.Status.Revision);
        Assert.Equal(1, other.Status.ErrorCount);
        Assert.Equal(0, other.Status.WarningCount);
        Assert.Equal(new[] { "B.Category" }, other.Categories);
        Assert.Equal("B error", Assert.Single(other.Entries).Message);
        Assert.DoesNotContain("A warning", await client.GetStringAsync(new Uri(viewer.Url, ViewerConstants.ExportRoute)), StringComparison.Ordinal);
        Assert.Empty((await SearchAsync(client, viewer, "?q=%22A%20warning%22")).Entries);

        viewer.SelectApplicationHistory("process:1:10", "App A");
        Assert.Equal(firstDirectory, viewer.HistoryDirectory);
        Assert.Equal(original, viewer.GetLogs());
        SessionInfo restoredSession = await CurrentSessionAsync(client, viewer);
        Assert.Equal(firstSession.Id, restoredSession.Id);
        Assert.Equal(firstSession.Name, restoredSession.Name);
        Assert.Equal(firstSession.StartedAt, restoredSession.StartedAt);
        LogSearchResult restored = await SearchAsync(client, viewer);
        Assert.True(restored.Status.Revision > other.Status.Revision);
        Assert.Equal("Renamed A", restored.Status.ApplicationName);
        Assert.Equal(1, restored.Status.ErrorCount);
        Assert.Equal(1, restored.Status.WarningCount);
        Assert.Equal(new[] { "A.Category" }, restored.Categories);
        Assert.Contains("A warning", await client.GetStringAsync(new Uri(viewer.Url, ViewerConstants.ExportRoute)), StringComparison.Ordinal);
        Assert.Empty((await SearchAsync(client, viewer, "?q=%22B%20error%22")).Entries);
        viewer.Record("A resumed");
        Assert.Equal(original[^1].Id + 1, viewer.GetLogs()[^1].Id);
        using (HttpRequestMessage request = new(HttpMethod.Post, new Uri(viewer.Url, ViewerConstants.ClearRoute)))
        {
            request.Headers.Add(ViewerConstants.ClearRequestHeader, ViewerConstants.ClearRequestAction);
            using HttpResponseMessage response = await client.SendAsync(request);
            response.EnsureSuccessStatusCode();
            LogClearResult result = JsonSerializer.Deserialize<LogClearResult>(await response.Content.ReadAsStringAsync(), ViewerConstants.JsonOptions)!;
            Assert.Equal(3, result.DeletedCount);
            Assert.Equal(firstDirectory, result.Status.HistoryDirectory);
        }
        LogSearchResult cleared = await SearchAsync(client, viewer);
        Assert.Empty(cleared.Entries);
        Assert.Empty(cleared.Categories);
        Assert.Equal(0, cleared.Status.ErrorCount);
        Assert.Equal(0, cleared.Status.WarningCount);

        viewer.SelectApplicationHistory("process:2:20", "App B");
        Assert.Equal(secondDirectory, viewer.HistoryDirectory);
        Assert.Equal(second, Assert.Single(viewer.GetLogs()));
        viewer.Record("B resumed");
        Assert.Equal(second.Id + 1, viewer.GetLogs()[^1].Id);
        viewer.SelectApplicationHistory("process:1:10", "App A");
        Assert.Empty(viewer.GetLogs());
        viewer.Record("A after clear");
        Assert.Equal(4, Assert.Single(viewer.GetLogs()).Id);
        viewer.SelectApplicationHistory("process:1:11", "Reused PID");
        Assert.Empty(viewer.GetLogs());
        Assert.NotEqual(firstDirectory, viewer.HistoryDirectory);
        viewer.SelectApplicationHistory("process:1:10", "App A");
        Assert.Equal("A after clear", Assert.Single(viewer.GetLogs()).Message);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AllApplicationSessionsAreSavedWithStableIdentitiesAndCleanedUp(bool complete)
    {
        string root = Path.Combine(Environment.CurrentDirectory, ".application-history-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        string[] directories = [];
        try
        {
            using HttpClient client = new();
            SessionInfo first;
            SessionInfo second;
            using (ConsoleLogViewer viewer = StartViewer(root))
            {
                viewer.SelectApplicationHistory("group:shared-path", "App A");
                viewer.Record("group history");
                viewer.RenameSession("Group investigation");
                first = await CurrentSessionAsync(client, viewer);
                string groupDirectory = viewer.HistoryDirectory;
                viewer.SelectApplicationHistory("process:1:10", "App A");
                Assert.Empty(viewer.GetLogs());
                viewer.Record("process history");
                second = await CurrentSessionAsync(client, viewer);
                Assert.NotEqual(first.Id, second.Id);
                directories = [groupDirectory, viewer.HistoryDirectory];
                viewer.SelectApplicationHistory("group:shared-path", "App A");
                Assert.Equal(groupDirectory, viewer.HistoryDirectory);
                Assert.Equal("group history", Assert.Single(viewer.GetLogs()).Message);
                Assert.Equal(first.Id, (await CurrentSessionAsync(client, viewer)).Id);
                if (complete) viewer.Complete(7);
            }

            Assert.All(directories, directory => Assert.False(Directory.Exists(directory)));
            Assert.Equal(2, Directory.GetDirectories(root).Length);
            SessionCatalog catalog = new(new ConsoleLogViewerOptions { CaptureConsole = false, SessionsDirectory = root }.Validate());
            using LogHistoryReader grouped = catalog.Open(first.Id);
            using LogHistoryReader process = catalog.Open(second.Id);
            Assert.Equal("group history", Assert.Single(grouped.ReadEntries()).Message);
            Assert.Equal("process history", Assert.Single(process.ReadEntries()).Message);
            Assert.Equal("Group investigation", grouped.Status.ApplicationName);
            Assert.Equal("App A", process.Status.ApplicationName);
            Assert.Equal(complete, grouped.Status.IsCompleted);
            Assert.Equal(complete, process.Status.IsCompleted);
            Assert.Equal(complete ? 7 : (int?)null, grouped.Status.ExitCode);
            Assert.Equal(complete ? 7 : (int?)null, process.Status.ExitCode);
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    [Theory]
    [InlineData(ViewerConstants.EventsRoute)]
    [InlineData(ViewerConstants.UpdatesRoute)]
    public async Task IdleStreamsFollowApplicationSwitchesAndReplayFromTheSelectedHistory(string route)
    {
        using ConsoleLogViewer viewer = StartViewer();
        viewer.SelectApplicationHistory("process:1:10", "App A");
        viewer.Record("A first");
        viewer.Record("A second");
        string firstDirectory = viewer.HistoryDirectory;
        using HttpClient client = new() { Timeout = Timeout.InfiniteTimeSpan };
        using HttpResponseMessage response = await client.GetAsync(new Uri(viewer.Url, route), HttpCompletionOption.ResponseHeadersRead);
        using StreamReader reader = new(await response.Content.ReadAsStreamAsync());
        JsonElement first = await ReadEventAsync(reader, ViewerConstants.StatusEvent);
        if (route == ViewerConstants.EventsRoute) await ReadEventAsync(reader, ViewerConstants.BatchEvent);

        viewer.SelectApplicationHistory("process:2:20", "App B");
        JsonElement switched = await ReadEventAsync(reader, ViewerConstants.StatusEvent);
        Assert.Equal(viewer.HistoryDirectory, switched.GetProperty("historyDirectory").GetString());
        Assert.Equal(0, switched.GetProperty("lastId").GetInt64());
        Assert.True(switched.GetProperty("revision").GetInt64() > first.GetProperty("revision").GetInt64());
        viewer.Record("B first");
        if (route == ViewerConstants.EventsRoute)
        {
            JsonElement batch = await ReadEventAsync(reader, ViewerConstants.BatchEvent);
            Assert.Equal("B first", Assert.Single(batch.EnumerateArray()).GetProperty("message").GetString());
        }
        else
        {
            Assert.Equal(1, (await ReadEventAsync(reader, ViewerConstants.StatusEvent)).GetProperty("lastId").GetInt64());
        }

        viewer.SelectApplicationHistory("process:1:10", "App A");
        JsonElement restored = await ReadEventAsync(reader, ViewerConstants.StatusEvent);
        Assert.Equal(firstDirectory, restored.GetProperty("historyDirectory").GetString());
        Assert.True(restored.GetProperty("revision").GetInt64() > switched.GetProperty("revision").GetInt64());
        if (route == ViewerConstants.EventsRoute)
        {
            JsonElement batch = await ReadEventAsync(reader, ViewerConstants.BatchEvent);
            Assert.Equal(new[] { "A first", "A second" }, batch.EnumerateArray().Select(entry => entry.GetProperty("message").GetString()));
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ListenAllReconnectResetsCursorsAheadOfTheSelectedApplication(bool header)
    {
        using ConsoleLogViewer viewer = StartViewer();
        viewer.SelectApplicationHistory("process:1:10", "App A");
        viewer.Record("A first");
        viewer.Record("A second");
        viewer.SelectApplicationHistory("process:2:20", "App B");
        viewer.Record("B first");
        using HttpClient client = new() { Timeout = Timeout.InfiniteTimeSpan };
        using HttpRequestMessage request = new(HttpMethod.Get, new Uri(viewer.Url, ViewerConstants.EventsRoute + (header ? "" : "?after=2")));
        if (header) request.Headers.Add(ViewerConstants.LastEventIdHeader, "2");
        using HttpResponseMessage response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using StreamReader reader = new(await response.Content.ReadAsStreamAsync());
        JsonElement batch = await ReadEventAsync(reader, ViewerConstants.BatchEvent);
        Assert.Equal("B first", Assert.Single(batch.EnumerateArray()).GetProperty("message").GetString());
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task ListenAllReconnectReplaysAnotherApplicationEvenWhenItsLastIdIsHigher(bool header, bool legacy)
    {
        using ConsoleLogViewer viewer = StartViewer();
        viewer.SelectApplicationHistory("process:1:10", "App A");
        for (int index = 1; index <= 50; index++) viewer.Record($"A {index}");
        using HttpClient client = new() { Timeout = Timeout.InfiniteTimeSpan };
        SessionInfo firstSession = await CurrentSessionAsync(client, viewer);
        string cursor;
        using (HttpResponseMessage initial = await client.GetAsync(new Uri(viewer.Url, ViewerConstants.EventsRoute), HttpCompletionOption.ResponseHeadersRead))
        using (StreamReader reader = new(await initial.Content.ReadAsStreamAsync()))
        {
            (string? id, JsonElement batch) = await ReadEventWithIdAsync(reader, ViewerConstants.BatchEvent);
            Assert.Equal(50, batch.GetArrayLength());
            Assert.Equal($"{firstSession.Id}:50", id);
            cursor = legacy ? "50" : id!;
        }

        viewer.SelectApplicationHistory("process:2:20", "App B");
        for (int index = 1; index <= 100; index++) viewer.Record($"B {index}");
        SessionInfo secondSession = await CurrentSessionAsync(client, viewer);
        using HttpRequestMessage request = new(HttpMethod.Get, new Uri(viewer.Url,
            ViewerConstants.EventsRoute + (header ? "" : "?after=" + Uri.EscapeDataString(cursor))));
        if (header) request.Headers.Add(ViewerConstants.LastEventIdHeader, cursor);
        using HttpResponseMessage response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using StreamReader resumed = new(await response.Content.ReadAsStreamAsync());
        (string? eventId, JsonElement replay) = await ReadEventWithIdAsync(resumed, ViewerConstants.BatchEvent);
        Assert.Equal(Enumerable.Range(1, 100).Select(index => $"B {index}"),
            replay.EnumerateArray().Select(entry => entry.GetProperty("message").GetString()));
        Assert.Equal($"{secondSession.Id}:100", eventId);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ListenAllReconnectResumesTheSameApplicationWithoutDuplicates(bool header)
    {
        using ConsoleLogViewer viewer = StartViewer();
        viewer.SelectApplicationHistory("process:1:10", "App A");
        viewer.Record("A first");
        viewer.Record("A second");
        using HttpClient client = new() { Timeout = Timeout.InfiniteTimeSpan };
        SessionInfo session = await CurrentSessionAsync(client, viewer);
        string cursor;
        using (HttpResponseMessage initial = await client.GetAsync(new Uri(viewer.Url, ViewerConstants.EventsRoute), HttpCompletionOption.ResponseHeadersRead))
        using (StreamReader reader = new(await initial.Content.ReadAsStreamAsync()))
        {
            (string? id, JsonElement batch) = await ReadEventWithIdAsync(reader, ViewerConstants.BatchEvent);
            Assert.Equal(2, batch.GetArrayLength());
            Assert.Equal($"{session.Id}:2", id);
            cursor = id!;
        }

        viewer.SelectApplicationHistory("process:2:20", "App B");
        viewer.Record("B first");
        viewer.SelectApplicationHistory("process:1:10", "App A");
        viewer.Record("A resumed");
        using HttpRequestMessage request = new(HttpMethod.Get, new Uri(viewer.Url,
            ViewerConstants.EventsRoute + (header ? "" : "?after=" + Uri.EscapeDataString(cursor))));
        if (header) request.Headers.Add(ViewerConstants.LastEventIdHeader, cursor);
        using HttpResponseMessage response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using StreamReader resumed = new(await response.Content.ReadAsStreamAsync());
        (string? eventId, JsonElement replay) = await ReadEventWithIdAsync(resumed, ViewerConstants.BatchEvent);
        Assert.Equal("A resumed", Assert.Single(replay.EnumerateArray()).GetProperty("message").GetString());
        Assert.Equal($"{session.Id}:3", eventId);
    }

    [Theory]
    [InlineData("-1")]
    [InlineData("hello")]
    [InlineData("9223372036854775808")]
    [InlineData("invalid:1")]
    [InlineData("00000000000000000000000000000000:-1")]
    [InlineData("00000000000000000000000000000000:")]
    [InlineData("00000000000000000000000000000000:9223372036854775808")]
    [InlineData("00000000000000000000000000000000:1:2")]
    public async Task ListenAllReconnectRejectsInvalidCursorsInHeadersAndQueries(string cursor)
    {
        using ConsoleLogViewer viewer = StartViewer();
        using HttpClient client = new();
        foreach (bool header in new[] { false, true })
        {
            using HttpRequestMessage request = new(HttpMethod.Get, new Uri(viewer.Url,
                ViewerConstants.EventsRoute + (header ? "" : "?after=" + Uri.EscapeDataString(cursor))));
            if (header) request.Headers.Add(ViewerConstants.LastEventIdHeader, cursor);
            using HttpResponseMessage response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            using JsonDocument error = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            Assert.Contains("session replay tokens", error.RootElement.GetProperty("error").GetString(), StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task BundleExportsCaptureOneApplicationContextForMetadataAndLogs()
    {
        ViewerSettings settings = new ConsoleLogViewerOptions { CaptureConsole = false, ApplicationName = "App A" }.Validate();
        using LogBuffer first = new(settings);
        using LogBuffer second = new(settings with { ApplicationName = "App B" });
        first.Append("A record", LogStream.Stdout);
        second.Append("B record", LogStream.Stdout);
        SessionCatalog firstCatalog = new(settings);
        ViewerSession firstSession = new(first, firstCatalog, first.Clear, _ => throw new InvalidOperationException());
        ViewerSession secondSession = new(second, new SessionCatalog(settings), second.Clear, _ => throw new InvalidOperationException());
        int selections = 0;
        await using HttpLogServer server = new(settings,
            () => Interlocked.Increment(ref selections) == 1 ? firstSession : secondSession, TextWriter.Null);
        using HttpClient client = new();
        using Stream content = await client.GetStreamAsync(new Uri(server.Url, ViewerConstants.BundleExportRoute));
        using ZipArchive bundle = new(content, ZipArchiveMode.Read);
        using Stream manifest = bundle.GetEntry("session.json")!.Open();
        SessionBundle metadata = (await JsonSerializer.DeserializeAsync<SessionBundle>(manifest, ViewerConstants.JsonOptions))!;
        using StreamReader logs = new(bundle.GetEntry("logs.jsonl")!.Open());
        using JsonDocument entry = JsonDocument.Parse((await logs.ReadLineAsync())!);
        Assert.Equal(firstCatalog.Id, metadata.Session.Id);
        Assert.Equal("App A", metadata.Session.Name);
        Assert.Equal("A record", entry.RootElement.GetProperty("message").GetString());
        Assert.Equal(1, selections);
    }

    private static ConsoleLogViewer StartViewer(string? savedDirectory = null) => ConsoleLogViewer.Start(new ConsoleLogViewerOptions
    {
        CaptureConsole = false,
        RunningApplications = new Applications(),
        SessionsDirectory = savedDirectory,
        SaveSession = savedDirectory is not null,
    });

    private static async Task<SessionInfo> CurrentSessionAsync(HttpClient client, ConsoleLogViewer viewer) =>
        (JsonSerializer.Deserialize<SessionInfo[]>(await client.GetStringAsync(new Uri(viewer.Url, ViewerConstants.SessionsRoute)), ViewerConstants.JsonOptions)!)
        .Single(session => session.IsCurrent);

    private static async Task<LogSearchResult> SearchAsync(HttpClient client, ConsoleLogViewer viewer, string query = "") =>
        JsonSerializer.Deserialize<LogSearchResult>(await client.GetStringAsync(new Uri(viewer.Url, ViewerConstants.SearchRoute + query)), ViewerConstants.JsonOptions)!;

    private static async Task<JsonElement> ReadEventAsync(StreamReader reader, string expected) =>
        (await ReadEventWithIdAsync(reader, expected)).Data;

    private static async Task<(string? Id, JsonElement Data)> ReadEventWithIdAsync(StreamReader reader, string expected)
    {
        using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(5));
        string? type = null;
        string? data = null;
        string? id = null;
        while (true)
        {
            string? line = await reader.ReadLineAsync(timeout.Token);
            Assert.NotNull(line);
            if (line.StartsWith("event: ", StringComparison.Ordinal)) type = line[7..];
            else if (line.StartsWith("data: ", StringComparison.Ordinal)) data = line[6..];
            else if (line.StartsWith("id: ", StringComparison.Ordinal)) id = line[4..];
            else if (line.Length == 0)
            {
                if (type == expected && data is not null)
                {
                    using JsonDocument document = JsonDocument.Parse(data);
                    return (id, document.RootElement.Clone());
                }
                type = null;
                data = null;
                id = null;
            }
        }
    }

    private sealed class Applications : IRunningApplications
    {
        public RunningApplicationsState GetState() => new([], null, null);
        public Task<RunningApplicationsState> SelectAsync(int processId, long startedAtTicks, CancellationToken cancellationToken, bool includeRelated = false) =>
            Task.FromResult(this.GetState());
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
