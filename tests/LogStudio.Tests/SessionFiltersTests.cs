using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using Xunit;

namespace LogStudio.Tests;

public sealed class SessionFiltersTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CurrentFiltersFollowCompletionRenameClearAndDisposalWithoutPrematureSaving(bool saveSession)
    {
        using Fixture fixture = new(saveSession);
        SessionFilters initial = Filters();
        SessionInfo current = await fixture.Save(initial);
        Assert.True(current.IsCurrent);
        AssertFilters(initial, current.Filters);
        Assert.Empty(Directory.GetDirectories(fixture.Root));
        fixture.Viewer.Record("all captured logs survive filters");
        fixture.Viewer.Complete(7);
        string metadata = Path.Combine(fixture.Root, current.Id, "session.json");
        Assert.Equal(saveSession, File.Exists(metadata));

        SessionFilters latest = initial with { Search = "changed", Levels = Array.Empty<string>(), TimeWindow = 900_000 };
        SessionInfo changed = await fixture.Save(latest, current.Id);
        AssertFilters(latest, changed.Filters);
        if (saveSession) AssertFilters(latest, ReadMetadata(metadata).Session.Filters);
        fixture.Viewer.RenameSession("Renamed with filters");
        fixture.Viewer.ClearLogs();
        fixture.Viewer.Complete(7);
        fixture.Viewer.Dispose();

        if (saveSession)
        {
            SavedSession saved = ReadMetadata(metadata);
            AssertFilters(latest, saved.Session.Filters);
            Assert.Equal("Renamed with filters", saved.Session.Name);
            Assert.Equal(saved.Session.Name, saved.Status.ApplicationName);
            Assert.Equal(0, saved.Session.EntryCount);
            using ConsoleLogViewer restarted = ConsoleLogViewer.Start(new ConsoleLogViewerOptions
            {
                CaptureConsole = false,
                SessionsDirectory = fixture.Root,
            });
            SessionInfo[] sessions = JsonSerializer.Deserialize<SessionInfo[]>(
                await fixture.Client.GetStringAsync(new Uri(restarted.Url, ViewerConstants.SessionsRoute)), ViewerConstants.JsonOptions)!;
            AssertFilters(latest, sessions.Single(session => !session.IsCurrent).Filters);
        }
        else
        {
            Assert.Empty(Directory.GetDirectories(fixture.Root));
        }
    }

    [Fact]
    public void CatalogOwnsFilterSnapshotsAndSavedEditsSurviveRepeatedSaveRenameAndClear()
    {
        using Fixture fixture = new();
        ViewerSettings settings = new ConsoleLogViewerOptions
        {
            CaptureConsole = false,
            SaveSession = true,
            SessionsDirectory = fixture.Root,
            ApplicationName = "Saved name",
        }.Validate();
        using LogBuffer logs = new(settings);
        logs.Append("retained", LogStream.Stdout);
        SessionCatalog catalog = new(settings);
        SessionFilters filters = Filters();
        SessionInfo updated = catalog.SaveFilters(null, filters, logs.GetStatus());
        filters.Levels![0] = "critical";
        filters.Conditions[0] = filters.Conditions[0] with { Value = "mutated input" };
        updated.Filters!.Levels![0] = "error";
        updated.Filters.Conditions[0] = updated.Filters.Conditions[0] with { Value = "mutated response" };
        AssertFilters(Filters(), catalog.Describe(logs.GetStatus()).Filters);
        catalog.Save(logs);
        SessionFilters latest = Filters() with { Search = "latest" };
        catalog.SaveFilters(catalog.Id, latest, logs.GetStatus());
        catalog.Save(logs);

        SessionCatalog restarted = new(settings);
        AssertFilters(latest, restarted.Information(catalog.Id, logs.GetStatus()).Filters);
        SessionFilters edited = latest with { Search = "saved edit", Levels = null, Conditions = Array.Empty<LogCondition>() };
        restarted.SaveFilters(catalog.Id, edited, logs.GetStatus());
        restarted.Rename(catalog.Id, "Renamed saved session");
        restarted.Clear(catalog.Id);
        SavedSession saved = ReadMetadata(Path.Combine(fixture.Root, catalog.Id, "session.json"));
        AssertFilters(edited, saved.Session.Filters);
        Assert.Equal(saved.Session.Name, saved.Status.ApplicationName);
        Assert.Equal(0, saved.Session.EntryCount);
        Assert.False(saved.Session.IsCurrent);
        Assert.False(File.Exists(Path.Combine(fixture.Root, catalog.Id, "session.json.pending")));
    }

    [Theory]
    [MemberData(nameof(InvalidFilters))]
    public async Task InvalidTypedFiltersAreRejectedWithoutMutatingMemoryOrSavedMetadata(string filters)
    {
        using Fixture fixture = new(saveSession: true);
        SessionInfo original = await fixture.Save(Filters());
        fixture.Viewer.Record("retained");
        fixture.Viewer.Complete();
        string path = Path.Combine(fixture.Root, original.Id, "session.json");
        string before = File.ReadAllText(path);
        using HttpResponseMessage response = await fixture.Post("{\"filters\":" + filters + "}");
        Assert.True(response.StatusCode == HttpStatusCode.BadRequest, "Unexpectedly accepted filters: " + filters);
        AssertFilters(original.Filters!, (await fixture.Current()).Filters);
        Assert.Equal(before, File.ReadAllText(path));
    }

    [Theory]
    [InlineData("{")]
    [InlineData("[]")]
    [InlineData("{}")]
    [InlineData("{\"filters\":null}")]
    [InlineData("{\"filters\":[]}")]
    public async Task InvalidRequestBodiesAreBadRequests(string body)
    {
        using Fixture fixture = new();
        using HttpResponseMessage response = await fixture.Post(body);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Null((await fixture.Current()).Filters);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ActualFilterRequestBytesAreBoundedBeforeJsonParsing(bool chunked)
    {
        using Fixture fixture = new();
        string valid = JsonSerializer.Serialize(new { filters = Filters() }, ViewerConstants.JsonOptions);
        using (HttpResponseMessage response = await fixture.Post(valid, chunked: chunked))
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        string oversized = valid + new string(' ', ViewerConstants.MaximumSessionFiltersBytes);
        using HttpResponseMessage invalid = await fixture.Post(oversized, chunked: chunked);
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        AssertFilters(Filters(), (await fixture.Current()).Filters);
        Assert.Empty(Directory.GetDirectories(fixture.Root));
    }

    [Fact]
    public async Task FilterActionsRequireExplicitHeaderAndSameOriginAndMissingSessionsAreNotFound()
    {
        using Fixture fixture = new();
        string body = JsonSerializer.Serialize(new { filters = Filters() }, ViewerConstants.JsonOptions);
        using (HttpResponseMessage missing = await fixture.Post(body, action: null))
            Assert.Equal(HttpStatusCode.Forbidden, missing.StatusCode);
        using (HttpResponseMessage foreign = await fixture.Post(body, origin: "https://foreign.invalid"))
            Assert.Equal(HttpStatusCode.Forbidden, foreign.StatusCode);
        using (HttpResponseMessage missingSession = await fixture.Post(body, Guid.NewGuid().ToString("N")))
            Assert.Equal(HttpStatusCode.NotFound, missingSession.StatusCode);
        using (HttpResponseMessage invalidId = await fixture.Post(body, "../other"))
            Assert.Equal(HttpStatusCode.BadRequest, invalidId.StatusCode);
        Assert.Null((await fixture.Current()).Filters);
        Assert.Empty(Directory.GetDirectories(fixture.Root));
    }

    [Fact]
    public async Task SavedFilterEditsPersistImmediatelyThroughTheSessionApi()
    {
        using Fixture fixture = new(saveSession: true);
        fixture.Viewer.Record("saved record");
        fixture.Viewer.Complete();
        SessionInfo saved = await fixture.Current();
        using Fixture other = new(root: fixture.Root);
        SessionInfo updated = await other.Save(Filters(), saved.Id);
        Assert.False(updated.IsCurrent);
        Assert.Equal(saved.Name, updated.Name);
        AssertFilters(Filters(), ReadMetadata(Path.Combine(fixture.Root, saved.Id, "session.json")).Session.Filters);
        Assert.Null((await other.Current()).Filters);
    }

    [Theory]
    [InlineData("界")]
    [InlineData("<")]
    [InlineData("😀")]
    public async Task ValidRuntimeConditionsCanBeSavedWithoutEncoderLengthExpansion(string symbol)
    {
        string value = string.Concat(Enumerable.Repeat(symbol, ViewerConstants.MaximumConditionValueLength / symbol.Length));
        SessionFilters filters = Filters() with
        {
            Conditions = Enumerable.Repeat(new LogCondition("exclude", "message", "contains", value), 3).ToArray(),
        };
        string runtimeConditions = "[" + string.Join(",", Enumerable.Repeat(
            "{\"mode\":\"exclude\",\"field\":\"message\",\"operator\":\"contains\",\"value\":\"" + value + "\"}", 3)) + "]";
        Assert.True(runtimeConditions.Length <= ViewerConstants.MaximumConditionsJsonLength);
        Assert.True(JsonSerializer.Serialize(filters.Conditions, ViewerConstants.JsonOptions).Length > ViewerConstants.MaximumConditionsJsonLength);
        _ = LogQuery.Parse(new NameValueCollection { [ViewerConstants.ConditionsQuery] = runtimeConditions });

        using Fixture fixture = new(saveSession: true);
        SessionInfo saved = await fixture.Save(filters);
        fixture.Viewer.Complete();
        AssertFilters(filters, saved.Filters);
        string metadata = Path.Combine(fixture.Root, saved.Id, "session.json");
        AssertFilters(filters, ReadMetadata(metadata).Session.Filters);
        Assert.Contains(JsonSerializer.Serialize(symbol, ViewerConstants.JsonOptions)[1..^1], File.ReadAllText(metadata), StringComparison.Ordinal);
    }

    [Fact]
    public void EverySupportedEnumNameAndTimeWindowIsAccepted()
    {
        SessionFilters defaults = Filters() with { Search = string.Empty, Category = string.Empty, Conditions = Array.Empty<LogCondition>(), Levels = null };
        foreach (LogSeverity severity in Enum.GetValues<LogSeverity>())
        {
            string name = JsonNamingPolicy.CamelCase.ConvertName(severity.ToString());
            (defaults with { Severity = name, Levels = new[] { name } }).Validate();
        }
        foreach (LogStream stream in Enum.GetValues<LogStream>())
            (defaults with { Stream = JsonNamingPolicy.CamelCase.ConvertName(stream.ToString()) }).Validate();
        foreach (int window in new[] { 0, 60_000, 300_000, 900_000 })
            (defaults with { TimeWindow = window, Severity = "errorPlus", Category = "null", Levels = Array.Empty<string>() }).Validate();
    }

    public static IEnumerable<object[]> InvalidFilters()
    {
        JsonObject original = JsonSerializer.SerializeToNode(Filters(), ViewerConstants.JsonOptions)!.AsObject();
        foreach (string property in original.Select(property => property.Key))
        {
            JsonObject missing = (JsonObject)original.DeepClone();
            missing.Remove(property);
            yield return new object[] { missing.ToJsonString() };
            if (property != "levels") yield return Case(property, "null");
        }
        foreach ((string property, string value) in new (string, string)[]
        {
            ("search", "true"), ("matchCase", "\"true\""), ("severity", "1"), ("severity", "\"1\""), ("severity", "\"unknown\""), ("severity", "\"Error\""),
            ("stream", "1"), ("stream", "\"1\""), ("stream", "\"unknown\""), ("stream", "\"Stdout\""), ("levels", "\"error\""),
            ("levels", "[1]"), ("levels", "[\"1\"]"), ("levels", "[null]"), ("levels", "[\"all\"]"), ("levels", "[\"unknown\"]"),
            ("levels", "[\"Error\"]"),
            ("includeMode", "\"unknown\""), ("timeWindow", "\"60000\""), ("timeWindow", "1"), ("timeWindow", "-1"),
            ("category", "\"not-json\""), ("category", "\"12\""), ("conditions", "{}"), ("conditions", "[null]"),
            ("pageSize", "250"), ("sessionId", "\"other\""), ("dismissedThroughId", "12"), ("maxId", "12"),
        })
            yield return Case(property, value);
        yield return Case("search", JsonSerializer.Serialize(new string('x', ViewerConstants.MaximumSearchLength + 1)));
        yield return Case("search", JsonSerializer.Serialize(string.Join(" ", Enumerable.Repeat("x", ViewerConstants.MaximumSearchTerms + 1))));
        yield return Case("search", JsonSerializer.Serialize("\"unfinished"));
        yield return Case("category", JsonSerializer.Serialize(JsonSerializer.Serialize(new string('x', ViewerConstants.MaximumCategoryLength + 1))));
        yield return Case("levels", JsonSerializer.Serialize(Enumerable.Repeat("error", Enum.GetValues<LogSeverity>().Length + 1)));
        yield return Case("conditions", JsonSerializer.Serialize(Enumerable.Repeat(Filters().Conditions[0], ViewerConstants.MaximumConditions + 1), ViewerConstants.JsonOptions));
        foreach (LogCondition condition in new[]
        {
            new LogCondition("unknown", "message", "contains", "x"),
            new LogCondition("include", "unknown", "contains", "x"),
            new LogCondition("include", "message", "unknown", "x"),
            new LogCondition("include", "message", "contains", ""),
            new LogCondition("include", "message", "contains", new string('x', ViewerConstants.MaximumConditionValueLength + 1)),
            new LogCondition("include", "message", "regex", "["),
            new LogCondition("include", "message", "regex", "(?=unsupported)"),
        })
            yield return Case("conditions", JsonSerializer.Serialize(new[] { condition }, ViewerConstants.JsonOptions));
        yield return Case("conditions", "[{}]");
        yield return Case("conditions", JsonSerializer.Serialize(
            Enumerable.Repeat(new LogCondition("include", "message", "contains", new string('x', 256)), 16), ViewerConstants.JsonOptions));

        object[] Case(string property, string value)
        {
            JsonObject changed = (JsonObject)original.DeepClone();
            changed[property] = JsonNode.Parse(value);
            return new object[] { changed.ToJsonString() };
        }
    }

    internal static SessionFilters Filters() => new(
        "message:\"saved phrase\"", true, "warningPlus", new[] { "warning", "error" }, "stderr", "\"Saved.Category\"",
        300_000, new[] { new LogCondition("exclude", "message", "contains", "ignored") }, "any");

    internal static void AssertFilters(SessionFilters expected, SessionFilters? actual) =>
        Assert.Equal(JsonSerializer.Serialize(expected, ViewerConstants.JsonOptions), JsonSerializer.Serialize(actual, ViewerConstants.JsonOptions));

    private static SavedSession ReadMetadata(string path) =>
        JsonSerializer.Deserialize<SavedSession>(File.ReadAllText(path), ViewerConstants.JsonOptions)!;

    private sealed class Fixture : IDisposable
    {
        private readonly bool ownsRoot;

        internal Fixture(bool saveSession = false, string? root = null)
        {
            this.ownsRoot = root is null;
            this.Root = root ?? Path.GetFullPath(".session-filters-test-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(this.Root);
            this.Viewer = ConsoleLogViewer.Start(new ConsoleLogViewerOptions
            {
                CaptureConsole = false,
                SaveSession = saveSession,
                SessionsDirectory = this.Root,
                ApplicationName = "Filter fixture",
            });
        }

        internal string Root { get; }
        internal ConsoleLogViewer Viewer { get; }
        internal HttpClient Client { get; } = new();

        internal async Task<SessionInfo> Current() =>
            JsonSerializer.Deserialize<SessionInfo[]>(await this.Client.GetStringAsync(new Uri(this.Viewer.Url, ViewerConstants.SessionsRoute)),
                ViewerConstants.JsonOptions)!.Single(session => session.IsCurrent);

        internal async Task<SessionInfo> Save(SessionFilters filters, string? id = null)
        {
            using HttpResponseMessage response = await this.Post(JsonSerializer.Serialize(new { filters }, ViewerConstants.JsonOptions), id);
            response.EnsureSuccessStatusCode();
            return JsonSerializer.Deserialize<SessionInfo>(await response.Content.ReadAsStringAsync(), ViewerConstants.JsonOptions)!;
        }

        internal async Task<HttpResponseMessage> Post(string body, string? id = null, bool chunked = false,
            string? action = ViewerConstants.SaveFiltersAction, string? origin = null)
        {
            string route = ViewerConstants.SessionsRoute + (id is null ? string.Empty : "?sessionId=" + Uri.EscapeDataString(id));
            using HttpRequestMessage request = new(HttpMethod.Post, new Uri(this.Viewer.Url, route));
            request.Content = chunked ? new ChunkedContent(body) : new StringContent(body, Encoding.UTF8, "application/json");
            if (action is not null) request.Headers.Add(ViewerConstants.ClearRequestHeader, action);
            if (origin is not null) request.Headers.Add(ViewerConstants.OriginHeader, origin);
            return await this.Client.SendAsync(request);
        }

        public void Dispose()
        {
            this.Client.Dispose();
            this.Viewer.Dispose();
            if (this.ownsRoot) Directory.Delete(this.Root, true);
        }
    }

    private sealed class ChunkedContent(string text) : HttpContent
    {
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) =>
            stream.WriteAsync(Encoding.UTF8.GetBytes(text)).AsTask();

        protected override bool TryComputeLength(out long length)
        {
            length = 0;
            return false;
        }
    }
}
