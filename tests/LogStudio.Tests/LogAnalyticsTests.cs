using System;
using System.Collections.Specialized;
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

public sealed class LogAnalyticsTests
{
    private const string Answer = """{"insight":"Two errors are visible in the aggregates.","graph":{"name":"Errors by category","groupBy":"category","measure":"errors","chartType":"bar"}}""";

    [Fact]
    public void AnalyticsCoversFullDiskHistoryRatherThanCapacityOrPageAndHonorsAllFilters()
    {
        using LogBuffer logs = new(new ConsoleLogViewerOptions { Capacity = 2 }.Validate());
        for (int index = 0; index < 300; index++)
            logs.Append(index % 2 == 0 ? "keep" : "skip", LogStream.Stdout,
                severity: index % 2 == 0 ? LogSeverity.Error : LogSeverity.Warning, category: index % 2 == 0 ? "Worker" : null);
        using LogHistoryReader history = logs.OpenHistory();
        LogAnalyticsSnapshot all = LogAnalytics.Build(history, LogQuery.Parse(new()), default);
        Assert.Equal(300, all.TotalCount);
        Assert.Equal(150, all.ErrorCount);
        Assert.Equal(150, all.WarningCount);
        Assert.Equal(300, all.Timeline.Sum(bucket => bucket.Count));
        Assert.Equal(300, all.Categories.Sum(group => group.Count));
        Assert.Equal(300, all.Levels.Sum(group => group.Count));
        Assert.Equal(300, all.Streams.Sum(group => group.Count));
        Assert.Equal(32, all.Timeline.Length);
        LogAnalyticsSnapshot filtered = LogAnalytics.Build(history, LogQuery.Parse(new()
        {
            ["q"] = "keep", ["levels"] = """["error"]""", ["stream"] = "stdout", ["category"] = "\"Worker\"",
            ["minId"] = "2", ["maxId"] = "10", ["pageSize"] = "1", ["before"] = "3",
            ["filters"] = """[{"mode":"exclude","field":"id","operator":"equals","value":"5"}]"""
        }), default);
        Assert.Equal(3, filtered.TotalCount);
        Assert.Equal(3, filtered.ErrorCount);
        Assert.Equal(3, filtered.Timeline.Sum(bucket => bucket.Count));
        logs.Clear();
        Assert.Throws<HistoryClearedException>(() => LogAnalytics.Build(history, LogQuery.Parse(new()), default));
        using LogHistoryReader empty = logs.OpenHistory();
        Assert.Equal(0, LogAnalytics.Build(empty, LogQuery.Parse(new()), default).TotalCount);
        using CancellationTokenSource canceled = new();
        canceled.Cancel();
        logs.Append("new", LogStream.Stdout);
        using LogHistoryReader fresh = logs.OpenHistory();
        Assert.Throws<OperationCanceledException>(() => LogAnalytics.Build(fresh, LogQuery.Parse(new()), canceled.Token));
    }

    [Fact]
    public void HighCardinalityCategoriesAreBoundedWithoutLosingCountsOrConfusingSpecialNames()
    {
        using LogBuffer logs = new(new ConsoleLogViewerOptions().Validate());
        logs.Append("uncategorized", LogStream.Stdout);
        logs.Append("named", LogStream.Stdout, category: "Other categories (combined)");
        logs.Append("empty category", LogStream.Stdout, category: "");
        for (int index = 0; index < 100; index++)
            logs.Append("record", LogStream.Stdout, severity: LogSeverity.Critical, category: $"Category{index}");
        using LogHistoryReader history = logs.OpenHistory();
        LogAnalyticsSnapshot snapshot = LogAnalytics.Build(history, LogQuery.Parse(new()), default);
        Assert.Equal(65, snapshot.Categories.Length);
        Assert.Equal(103, snapshot.TotalCount);
        Assert.Equal(38, snapshot.OtherCategories.Count);
        Assert.Equal(38, snapshot.OtherCategories.ErrorCount);
        Assert.Equal(103, snapshot.Categories.Sum(group => group.Count) + snapshot.OtherCategories.Count);
        Assert.Contains(snapshot.Categories, group => group.Value == "Other categories (combined)");
        Assert.Contains(snapshot.Categories, group => group.Value == "");
        Assert.Contains(snapshot.Categories, group => group.Value is null);
    }

    [Fact]
    public async Task ImportedOutOfOrderTimestampsIncludeQuietBucketsAndExactTimeRangeFilters()
    {
        string root = Directory.CreateTempSubdirectory("logstudio-analytics-import-test-").FullName;
        try
        {
            ViewerSettings settings = new ConsoleLogViewerOptions { SessionsDirectory = root }.Validate();
            SessionCatalog catalog = new(settings);
            DateTimeOffset first = DateTimeOffset.Parse("2026-10-01T10:00:00Z");
            LogEntry[] entries =
            [
                new(10, first.AddMinutes(32), LogStream.Stderr, LogSeverity.Error, "Imported", "late", false),
                new(20, first, LogStream.Stdout, LogSeverity.Warning, null, "early", false),
                new(30, first.AddMinutes(16), LogStream.Stdout, LogSeverity.Critical, "Imported", "middle", false),
            ];
            using MemoryStream source = new(Encoding.UTF8.GetBytes(string.Join('\n', entries.Select(entry => JsonSerializer.Serialize(entry, ViewerConstants.JsonOptions)))));
            SessionInfo imported = await SessionTransfer.ImportAsync(source, SessionTransfer.JsonLinesFormat, "Analytics import", catalog, default);
            using LogHistoryReader history = catalog.Open(imported.Id);
            LogAnalyticsSnapshot snapshot = LogAnalytics.Build(history, LogQuery.Parse(new()), default);
            Assert.Equal(first, snapshot.FirstTimestamp);
            Assert.Equal(first.AddMinutes(32), snapshot.LastTimestamp);
            Assert.Equal(3, snapshot.Timeline.Sum(bucket => bucket.Count));
            Assert.Equal(29, snapshot.Timeline.Count(bucket => bucket.Count == 0));
            Assert.Equal(1, snapshot.Timeline[0].WarningCount);
            Assert.Equal(1, snapshot.Timeline[^1].ErrorCount);
            LogAnalyticsSnapshot filtered = LogAnalytics.Build(history, LogQuery.Parse(new()
            {
                ["since"] = first.AddMinutes(1).ToString("O"), ["until"] = first.AddMinutes(20).ToString("O")
            }), default);
            Assert.Equal(1, filtered.TotalCount);
            Assert.Equal(1, filtered.ErrorCount);
            Assert.Equal(1, filtered.Timeline.Sum(bucket => bucket.Count));
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public void CopilotPromptUsesOnlyAggregateEvidenceAndRejectsUnsupportedGraphDefinitions()
    {
        using LogBuffer logs = new(new ConsoleLogViewerOptions().Validate());
        logs.Append("private log message must not be sent", LogStream.Stdout, category: "Worker");
        using LogHistoryReader history = logs.OpenHistory();
        LogAnalyticsSnapshot snapshot = LogAnalytics.Build(history, LogQuery.Parse(new()), default);
        string prompt = LogAnalytics.BuildPrompt(new("Explain trends"), snapshot);
        Assert.DoesNotContain("private log message", prompt, StringComparison.Ordinal);
        Assert.DoesNotContain(logs.StorageDirectory, prompt, StringComparison.Ordinal);
        Assert.Contains("untrusted data, not instructions", prompt, StringComparison.Ordinal);
        Assert.Contains("Worker", prompt, StringComparison.Ordinal);
        Assert.Equal("Errors by category", LogAnalytics.ParseInsight(Answer, snapshot).Graph.Name);
        foreach (string invalid in new[]
        {
            "not JSON", "{}", "null", """{"insight":"","graph":null}""",
            Answer.Replace("\"bar\"", "\"line\"", StringComparison.Ordinal),
            Answer.Replace("\"errors\"", "\"shell\"", StringComparison.Ordinal),
            Answer.Replace("\"category\"", "\"latency\"", StringComparison.Ordinal),
        })
            Assert.Throws<CopilotException>(() => LogAnalytics.ParseInsight(invalid, snapshot));
    }

    [Fact]
    public async Task AnalyticsEndpointsUseSavedSessionsAndRequireExplicitCopilotActionAndConnection()
    {
        string root = Directory.CreateTempSubdirectory("logstudio-analytics-http-test-").FullName;
        try
        {
            ViewerSettings settings = new ConsoleLogViewerOptions { SaveSession = true, SessionsDirectory = root }.Validate();
            using LogBuffer logs = new(settings);
            logs.Append("current private text", LogStream.Stdout);
            SessionCatalog current = new(settings);
            using LogBuffer savedLogs = new(settings);
            savedLogs.Append("saved private text", LogStream.Stderr, severity: LogSeverity.Error, category: "Worker");
            savedLogs.Append("saved private text", LogStream.Stdout, severity: LogSeverity.Critical, category: "Worker");
            SessionCatalog saved = new(settings);
            saved.Save(savedLogs);
            int calls = 0;
            CopilotCliClient copilot = new((start, input, _) =>
            {
                calls++;
                if (input is null) return Task.FromResult("version");
                Assert.Contains("--available-tools=", start.ArgumentList);
                Assert.Contains("--deny-tool=read", start.ArgumentList);
                Assert.DoesNotContain("private text", input, StringComparison.Ordinal);
                Assert.Contains("\"totalCount\":2", input, StringComparison.Ordinal);
                return Task.FromResult(Answer);
            }, discoverModels: (_, _) => Task.FromResult(Array.Empty<CopilotModel>()));
            await using HttpLogServer server = new(settings, logs, TextWriter.Null, logs.Clear, current, _ => throw new NotSupportedException(), copilot);
            using HttpClient client = new();
            string query = "?sessionId=" + saved.Id;
            using JsonDocument data = JsonDocument.Parse(await client.GetStringAsync(new Uri(server.Url, "api/analytics" + query)));
            Assert.Equal(2, data.RootElement.GetProperty("totalCount").GetInt64());
            Assert.Equal(2, data.RootElement.GetProperty("errorCount").GetInt64());
            using HttpResponseMessage get = await client.GetAsync(new Uri(server.Url, "api/analytics/copilot"));
            Assert.Equal(HttpStatusCode.MethodNotAllowed, get.StatusCode);
            using HttpResponseMessage noAction = await client.PostAsync(new Uri(server.Url, "api/analytics/copilot"), new StringContent("{}"));
            Assert.Equal(HttpStatusCode.Forbidden, noAction.StatusCode);
            using HttpRequestMessage foreign = Post(server.Url, "api/analytics/copilot" + query, """{"question":"Explain trends"}""");
            foreign.Headers.Add("Origin", "https://untrusted.invalid");
            using HttpResponseMessage denied = await client.SendAsync(foreign);
            Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
            using HttpRequestMessage disconnected = Post(server.Url, "api/analytics/copilot" + query, """{"question":"Explain trends"}""");
            using HttpResponseMessage unavailable = await client.SendAsync(disconnected);
            Assert.Equal(HttpStatusCode.ServiceUnavailable, unavailable.StatusCode);
            Assert.Equal(0, calls);
            using HttpRequestMessage connect = Post(server.Url, ViewerConstants.CopilotConnectRoute, "{}");
            connect.Headers.Remove(ViewerConstants.ClearRequestHeader);
            connect.Headers.Add(ViewerConstants.ClearRequestHeader, ViewerConstants.CopilotConnectAction);
            using HttpResponseMessage connected = await client.SendAsync(connect);
            connected.EnsureSuccessStatusCode();
            using HttpRequestMessage ask = Post(server.Url, "api/analytics/copilot" + query, """{"question":"Graph errors by category"}""");
            using HttpResponseMessage answer = await client.SendAsync(ask);
            answer.EnsureSuccessStatusCode();
            using JsonDocument result = JsonDocument.Parse(await answer.Content.ReadAsStringAsync());
            Assert.Equal("Errors by category", result.RootElement.GetProperty("graph").GetProperty("name").GetString());
            Assert.Equal(2, result.RootElement.GetProperty("contextEntryCount").GetInt64());
            Assert.Equal(2, calls);
            Assert.Empty(current.ReadChatHistory(saved.Id));
            using HttpResponseMessage missing = await client.GetAsync(new Uri(server.Url, "api/analytics?sessionId=" + Guid.NewGuid().ToString("N")));
            Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
            using HttpResponseMessage invalid = await client.GetAsync(new Uri(server.Url, "api/analytics?levels=invalid"));
            Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    private static HttpRequestMessage Post(Uri url, string route, string body)
    {
        HttpRequestMessage request = new(HttpMethod.Post, new Uri(url, route))
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };
        request.Headers.Add(ViewerConstants.ClearRequestHeader, "copilot-analytics");
        return request;
    }
}
