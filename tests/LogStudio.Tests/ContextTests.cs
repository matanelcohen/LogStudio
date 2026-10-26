using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace LogStudio.Tests;

public sealed class ContextTests
{
    [Theory]
    [InlineData(1, 1, 26, 0, 26)]
    [InlineData(25, 1, 50, 0, 50)]
    [InlineData(26, 1, 51, 0, 51)]
    [InlineData(50, 25, 75, 25, 75)]
    [InlineData(75, 50, 100, 50, 0)]
    [InlineData(100, 75, 100, 75, 0)]
    public async Task InitialContextIsOldestFirstAndClampedToTwentyFiveOnEachSide(
        long anchor, int first, int last, long before, long after)
    {
        using Fixture fixture = new();
        fixture.Append(100);
        LogContextResult result = await fixture.Context(anchor);
        AssertPage(result, anchor, first, last, before, after);
        Assert.Equal(fixture.Current.Catalog.Id, result.SessionId);
        Assert.True(result.FiltersBypassed);
        Assert.Equal(100, result.Status.RetainedCount);
        Assert.InRange(result.Entries.Length, 1, 51);
        Assert.Single(result.Entries, entry => entry.Id == anchor);
    }

    [Fact]
    public async Task ContinuationEdgesDescribeEveryPageAndCanCrossTheOriginalAnchor()
    {
        using Fixture fixture = new();
        fixture.Append(100);
        AssertPage(await fixture.Context(50), 50, 25, 75, 25, 75);
        AssertPage(await fixture.Context(50, suffix: "&before=25"), 50, 1, 24, 0, 24);
        AssertPage(await fixture.Context(50, suffix: "&after=24"), 50, 25, 49, 25, 49);
        AssertPage(await fixture.Context(50, suffix: "&after=49"), 50, 50, 74, 50, 74);
        AssertPage(await fixture.Context(50, suffix: "&after=75"), 50, 76, 100, 76, 0);
        AssertPage(await fixture.Context(50, suffix: "&before=76"), 50, 51, 75, 51, 75);
        AssertPage(await fixture.Context(50, suffix: "&before=51"), 50, 26, 50, 26, 50);
    }

    [Fact]
    public async Task ContextIgnoresFiltersAndPageSizeAndUsesOnlyBoundedIndexedReads()
    {
        using Fixture fixture = new();
        fixture.Append(1000);
        fixture.Current.Logs.OpenHistory().Dispose();
        fixture.CorruptIndex(1);
        string ignored = "&q=does-not-match&levels=broken&filters=broken&minId=999&maxId=1&pageSize=2147483647";
        AssertPage(await fixture.Context(500, suffix: ignored), 500, 475, 525, 475, 525);
        AssertPage(await fixture.Context(500, suffix: "&before=475" + ignored), 500, 450, 474, 450, 474);
        AssertPage(await fixture.Context(500, suffix: "&after=525" + ignored), 500, 526, 550, 526, 550);

        fixture.CorruptIndex(500);
        using (LogHistoryReader damaged = fixture.Current.Logs.OpenHistory())
            Assert.Throws<InvalidDataException>(() => damaged.ReadEntries(500, 500).ToArray());
        await fixture.Error(fixture.Route(500, suffix: "&after=525"), HttpStatusCode.InternalServerError);
    }

    [Fact]
    public async Task RetentionNeverLeaksExpiredEntriesAndRevalidatesTheAnchorOnEveryPage()
    {
        using Fixture fixture = new(capacity: 10);
        fixture.Append(30);
        AssertPage(await fixture.Context(25), 25, 21, 30, 0, 0);
        AssertPage(await fixture.Context(25, suffix: "&before=25"), 25, 21, 24, 0, 24);
        await fixture.Error(fixture.Route(20), HttpStatusCode.Gone);
        fixture.Append(6);
        await fixture.Error(fixture.Route(25, suffix: "&after=30"), HttpStatusCode.Gone);
        await fixture.Error(fixture.Route(37), HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task MissingAndClearedAnchorsAreDistinctAndCaptureCanContinueAfterClear()
    {
        using Fixture fixture = new();
        await fixture.Error(fixture.Route(1), HttpStatusCode.NotFound);
        fixture.Append(2);
        await fixture.Error(fixture.Route(3), HttpStatusCode.NotFound);
        await fixture.Action(ViewerConstants.ClearRoute, ViewerConstants.ClearRequestAction);
        await fixture.Error(fixture.Route(1), HttpStatusCode.Gone);
        fixture.Append(1);
        await fixture.Error(fixture.Route(2, suffix: "&after=2"), HttpStatusCode.Gone);
        AssertPage(await fixture.Context(3), 3, 3, 3, 0, 0);
    }

    [Fact]
    public async Task CurrentSavedAndImportedDuplicateEntryIdsStayIsolated()
    {
        using Fixture fixture = new();
        fixture.Append(1, "current");
        string saved = fixture.Save("saved", 100, capacity: 10);
        LogEntry importedEntry = new(999, DateTimeOffset.UtcNow, LogStream.Stderr, LogSeverity.Error, "Import", "imported", false);
        using MemoryStream input = new(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(importedEntry, ViewerConstants.JsonOptions) + "\n"));
        SessionInfo imported = await SessionTransfer.ImportAsync(input, SessionTransfer.JsonLinesFormat, "Imported", fixture.Current.Catalog, default);

        Assert.Equal("current", Assert.Single((await fixture.Context(1)).Entries).Message);
        Assert.Equal("imported", Assert.Single((await fixture.Context(1, imported.Id)).Entries).Message);
        AssertPage(await fixture.Context(95, saved), 95, 91, 100, 0, 0);
        await fixture.Error(fixture.Route(1, saved), HttpStatusCode.Gone);
        await fixture.Error(fixture.Route(1, Guid.NewGuid().ToString("N")), HttpStatusCode.NotFound);

        foreach (string id in new[] { fixture.Current.Catalog.Id, saved, imported.Id })
        {
            using JsonDocument search = JsonDocument.Parse(await fixture.Client.GetStringAsync(
                new Uri(fixture.Server.Url, ViewerConstants.SearchRoute + "?sessionId=" + id)));
            Assert.Equal(id, search.RootElement.GetProperty("sessionId").GetString());
        }
        using JsonDocument current = JsonDocument.Parse(await fixture.Client.GetStringAsync(new Uri(fixture.Server.Url, ViewerConstants.SearchRoute + "?q=current")));
        Assert.Equal(fixture.Current.Catalog.Id, current.RootElement.GetProperty("sessionId").GetString());
    }

    [Fact]
    public async Task SavedClearAndDeleteInvalidateFurtherContextRequests()
    {
        using Fixture fixture = new();
        fixture.Append(1, "current");
        string saved = fixture.Save("saved", 100);
        AssertPage(await fixture.Context(50, saved), 50, 25, 75, 25, 75);
        await fixture.Action(ViewerConstants.ClearRoute + "?sessionId=" + saved, ViewerConstants.ClearRequestAction);
        await fixture.Error(fixture.Route(50, saved, "&after=75"), HttpStatusCode.Gone);
        await fixture.Action(ViewerConstants.SessionsRoute + "?sessionId=" + saved, ViewerConstants.DeleteSessionAction);
        await fixture.Error(fixture.Route(50, saved), HttpStatusCode.NotFound);
        Assert.Equal("current", Assert.Single((await fixture.Context(1)).Entries).Message);
    }

    [Fact]
    public async Task ExplicitContextIdentityNeverResolvesToAnotherLiveHistoryAfterSwitching()
    {
        using Fixture fixture = new();
        fixture.Append(1, "first history");
        ViewerSession first = fixture.Current;
        using JsonDocument search = JsonDocument.Parse(await fixture.Client.GetStringAsync(new Uri(fixture.Server.Url, ViewerConstants.SearchRoute)));
        string captured = search.RootElement.GetProperty("sessionId").GetString()!;
        fixture.Current = fixture.CreateSession("Second");
        fixture.Append(1, "second history");
        await fixture.Error(fixture.Route(1, captured), HttpStatusCode.NotFound);
        Assert.Equal("second history", Assert.Single((await fixture.Context(1)).Entries).Message);
        fixture.Current = first;
        Assert.Equal("first history", Assert.Single((await fixture.Context(1, captured)).Entries).Message);
    }

    [Fact]
    public async Task SearchReturnsTheIdentityCapturedWithItsEntriesEvenIfCurrentChanges()
    {
        using Fixture fixture = new();
        fixture.Append(1, "first history");
        ViewerSession first = fixture.Current;
        ViewerSession second = fixture.CreateSession("Second");
        second.Logs.Append("second history", LogStream.Stdout);
        fixture.ResolveSession = () =>
        {
            fixture.Current = second;
            return first;
        };
        using JsonDocument search = JsonDocument.Parse(await fixture.Client.GetStringAsync(new Uri(fixture.Server.Url, ViewerConstants.SearchRoute)));
        Assert.Equal(first.Catalog.Id, search.RootElement.GetProperty("sessionId").GetString());
        Assert.Equal("first history", search.RootElement.GetProperty("entries")[0].GetProperty("message").GetString());
        fixture.ResolveSession = null;
        await fixture.Error(fixture.Route(1, first.Catalog.Id), HttpStatusCode.NotFound);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void SavedReadersAreInvalidatedAcrossCatalogSwitches(bool delete)
    {
        using Fixture fixture = new();
        string saved = fixture.Save("saved", 100);
        using LogHistoryReader reader = fixture.Current.Catalog.Open(saved);
        fixture.Current = fixture.CreateSession("Second");
        if (delete) fixture.Current.Catalog.Delete(saved);
        else fixture.Current.Catalog.Clear(saved);
        Assert.Throws<HistoryClearedException>(() => Query(saved, 50, after: 75).Read(reader, default));
    }

    [Fact]
    public void ReplacingASavedHistoryInvalidatesReadersFromAnotherCatalogEvenIfCopyIsBlocked()
    {
        using Fixture fixture = new(saveSession: true);
        fixture.Append(100);
        ViewerSession first = fixture.Current;
        first.Catalog.Save(first.Logs);
        fixture.Current = fixture.CreateSession("Second");
        using LogHistoryReader reader = fixture.Current.Catalog.Open(first.Catalog.Id);
        first.Logs.Clear();
        first.Logs.Append("after clear", LogStream.Stdout);
        Exception? failure = Record.Exception(() => first.Catalog.Save(first.Logs));
        Assert.True(failure is null or IOException);
        Assert.Throws<HistoryClearedException>(() => Query(first.Catalog.Id, 50).Read(reader, default));
    }

    [Fact]
    public void ClearDuringABoundedReadAndDisposeInvalidateReaders()
    {
        using Fixture fixture = new();
        fixture.Append(100);
        ViewerStatus status;
        using (LogHistoryReader flushed = fixture.Current.Logs.OpenHistory()) status = flushed.Status;
        int probes = 0;
        using LogHistoryReader history = new(
            Path.Combine(fixture.Current.Logs.StorageDirectory, "entries.jsonl"),
            Path.Combine(fixture.Current.Logs.StorageDirectory, "entries.idx"), status, [], () =>
            {
                if (++probes == 5) fixture.Current.Logs.Clear();
                return fixture.Current.Logs.GetStatus().ClearedThroughId == status.ClearedThroughId;
            });
        Assert.Throws<HistoryClearedException>(() => Query(fixture.Current.Catalog.Id, 50).Read(history, default));

        fixture.Append(1);
        using LogHistoryReader disposed = fixture.Current.Logs.OpenHistory();
        fixture.Current.Logs.Dispose();
        Assert.Throws<HistoryClearedException>(() => Query(fixture.Current.Catalog.Id, 101).Read(disposed, default));
    }

    [Fact]
    public async Task ConcurrentlyUnavailableCurrentHistoryReturnsConflict()
    {
        using Fixture fixture = new();
        fixture.Append(1);
        fixture.Current.Logs.Dispose();
        await fixture.Error(fixture.Route(1), HttpStatusCode.Conflict);
    }

    [Theory]
    [InlineData("")]
    [InlineData("?entryId=1")]
    [InlineData("?sessionId=current&entryId=1")]
    [InlineData("?sessionId=../outside&entryId=1")]
    [InlineData("?sessionId=&entryId=1")]
    [InlineData("?sessionId={id}")]
    [InlineData("?sessionId={id}&entryId=")]
    [InlineData("?sessionId={id}&entryId=0")]
    [InlineData("?sessionId={id}&entryId=-1")]
    [InlineData("?sessionId={id}&entryId=1.5")]
    [InlineData("?sessionId={id}&entryId=9223372036854775808")]
    [InlineData("?sessionId={id}&entryId=1&entryId=2")]
    [InlineData("?sessionId={id}&sessionId={id}&entryId=1")]
    [InlineData("?sessionId={id}&entryId=1&before=1&after=2")]
    [InlineData("?sessionId={id}&entryId=1&before=")]
    [InlineData("?sessionId={id}&entryId=1&before=0")]
    [InlineData("?sessionId={id}&entryId=1&after=-1")]
    [InlineData("?sessionId={id}&entryId=1&after=invalid")]
    [InlineData("?sessionId={id}&entryId=1&after=9223372036854775808")]
    public async Task InvalidContextRequestsReturnExplicitBadRequests(string query)
    {
        using Fixture fixture = new();
        await fixture.Error(ViewerConstants.ContextRoute + query.Replace("{id}", fixture.Current.Catalog.Id, StringComparison.Ordinal), HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task CursorExtremesAndAlternateGuidFormattingAreSafe()
    {
        using Fixture fixture = new();
        fixture.Append(100);
        string formatted = Guid.Parse(fixture.Current.Catalog.Id).ToString("D").ToUpperInvariant();
        AssertPage(await fixture.Context(50, formatted, "&before=9223372036854775807"), 50, 76, 100, 76, 0);
        foreach (string suffix in new[] { "&before=1", "&after=100", "&after=9223372036854775807" })
        {
            LogContextResult empty = await fixture.Context(50, suffix: suffix);
            Assert.Empty(empty.Entries);
            Assert.Null(empty.Before);
            Assert.Null(empty.After);
        }
        AssertPage(await fixture.Context(50, suffix: "&after=1"), 50, 2, 26, 2, 26);
        await fixture.Error(fixture.Route(long.MaxValue), HttpStatusCode.NotFound);
    }

    [Fact]
    public void IndexedContextAtTheMaximumLongIdDoesNotOverflow()
    {
        using Fixture fixture = new();
        string journalPath = Path.Combine(fixture.Root, "high.jsonl");
        string indexPath = Path.Combine(fixture.Root, "high.idx");
        long first = long.MaxValue - 74;
        using (FileStream journal = File.Create(journalPath))
        using (FileStream index = File.Create(indexPath))
        {
            byte[] offset = new byte[sizeof(long)];
            for (int ordinal = 0; ordinal < 75; ordinal++)
            {
                BinaryPrimitives.WriteInt64LittleEndian(offset, journal.Position);
                index.Write(offset);
                journal.Write(JsonSerializer.SerializeToUtf8Bytes(
                    new LogEntry(first + ordinal, DateTimeOffset.UtcNow, LogStream.Stdout, LogSeverity.Output, null, "high", false),
                    ViewerConstants.JsonOptions));
                journal.WriteByte((byte)'\n');
            }
        }
        ViewerStatus status = fixture.Current.Logs.GetStatus() with
        {
            FirstId = first, LastId = long.MaxValue, ClearedThroughId = first - 1, RetainedCount = 75,
        };
        using LogHistoryReader history = new(journalPath, indexPath, status, [], () => true);
        LogContextResult initial = Query(fixture.Current.Catalog.Id, long.MaxValue).Read(history, default);
        Assert.Equal(26, initial.Entries.Length);
        Assert.Equal(long.MaxValue, initial.Entries[^1].Id);
        Assert.Null(initial.After);
        LogContextResult page = Query(fixture.Current.Catalog.Id, long.MaxValue, after: long.MaxValue - 25).Read(history, default);
        Assert.Equal(25, page.Entries.Length);
        Assert.Equal(long.MaxValue, page.Entries[^1].Id);
        Assert.Empty(Query(fixture.Current.Catalog.Id, long.MaxValue, after: long.MaxValue).Read(history, default).Entries);
    }

    [Fact]
    public async Task ContextKeepsTheSharedOriginMethodAndHistoryConcurrencyGuards()
    {
        using Fixture fixture = new();
        fixture.Append(1);
        using (HttpRequestMessage request = new(HttpMethod.Get, new Uri(fixture.Server.Url, fixture.Route(1))))
        {
            request.Headers.Add(ViewerConstants.OriginHeader, "https://example.invalid");
            using HttpResponseMessage response = await fixture.Client.SendAsync(request);
            Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        }
        using (HttpRequestMessage request = new(HttpMethod.Get, new Uri(fixture.Server.Url, fixture.Route(1))))
        {
            request.Headers.Add(ViewerConstants.FetchSiteHeader, "cross-site");
            using HttpResponseMessage response = await fixture.Client.SendAsync(request);
            Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        }
        using (HttpResponseMessage response = await fixture.Client.PostAsync(new Uri(fixture.Server.Url, fixture.Route(1)), null))
            Assert.Equal(HttpStatusCode.MethodNotAllowed, response.StatusCode);

        SemaphoreSlim slots = (SemaphoreSlim)typeof(HttpLogServer).GetField("historySlots", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(fixture.Server)!;
        for (int index = 0; index < 4; index++) Assert.True(slots.Wait(0));
        try
        {
            await fixture.Error(fixture.Route(1), HttpStatusCode.TooManyRequests);
            await fixture.Error(ViewerConstants.SearchRoute, HttpStatusCode.TooManyRequests);
            await fixture.Error(ViewerConstants.ExportRoute, HttpStatusCode.TooManyRequests);
        }
        finally
        {
            slots.Release(4);
        }
        Assert.Single((await fixture.Context(1)).Entries);
    }

    private static void AssertPage(LogContextResult page, long anchor, int first, int last, long before, long after)
    {
        Assert.Equal(anchor, page.AnchorId);
        Assert.Equal(Enumerable.Range(first, last - first + 1).Select(id => (long)id), page.Entries.Select(entry => entry.Id));
        Assert.Equal(before == 0 ? (long?)null : before, page.Before);
        Assert.Equal(after == 0 ? (long?)null : after, page.After);
    }

    private static LogContextQuery Query(string id, long anchor, long? after = null) => LogContextQuery.Parse(new NameValueCollection
    {
        [ViewerConstants.SessionIdQuery] = id,
        ["entryId"] = anchor.ToString(CultureInfo.InvariantCulture),
        [ViewerConstants.AfterQuery] = after?.ToString(CultureInfo.InvariantCulture),
    });

    private sealed class Fixture : IDisposable
    {
        private readonly SessionCatalogMutations mutations = new();
        private readonly List<LogBuffer> buffers = [];
        private readonly ViewerSettings settings;

        internal Fixture(int capacity = 0, bool saveSession = false)
        {
            this.Root = Path.Combine(Environment.CurrentDirectory, ".context-tests-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(this.Root);
            this.settings = new ConsoleLogViewerOptions
            {
                CaptureConsole = false, SessionsDirectory = this.Root, Capacity = capacity, SaveSession = saveSession,
            }.Validate();
            this.Current = this.CreateSession("Current");
            this.Server = new HttpLogServer(this.settings, () => this.ResolveSession?.Invoke() ?? this.Current, TextWriter.Null);
        }

        internal string Root { get; }
        internal ViewerSession Current { get; set; }
        internal Func<ViewerSession>? ResolveSession { get; set; }
        internal HttpLogServer Server { get; }
        internal HttpClient Client { get; } = new();

        internal ViewerSession CreateSession(string name)
        {
            LogBuffer logs = new(this.settings with { ApplicationName = name });
            this.buffers.Add(logs);
            SessionCatalog catalog = new(this.settings, this.mutations);
            return new ViewerSession(logs, catalog, logs.Clear, value =>
            {
                logs.Rename(value);
                return catalog.Describe(logs.GetStatus());
            });
        }

        internal void Append(int count, string message = "entry")
        {
            for (int index = 0; index < count; index++) this.Current.Logs.Append(message, LogStream.Stdout);
        }

        internal string Save(string message, int count, int capacity = 0)
        {
            ViewerSettings savedSettings = this.settings with { SaveSession = true, Capacity = capacity, ApplicationName = "Saved" };
            using LogBuffer logs = new(savedSettings);
            for (int index = 0; index < count; index++) logs.Append(message, LogStream.Stdout);
            SessionCatalog catalog = new(savedSettings, this.mutations);
            catalog.Save(logs, closing: true);
            return catalog.Id;
        }

        internal string Route(long anchor, string? id = null, string suffix = "") =>
            ViewerConstants.ContextRoute + "?sessionId=" + (id ?? this.Current.Catalog.Id) +
            "&entryId=" + anchor.ToString(CultureInfo.InvariantCulture) + suffix;

        internal async Task<LogContextResult> Context(long anchor, string? id = null, string suffix = "") =>
            JsonSerializer.Deserialize<LogContextResult>(await this.Client.GetStringAsync(new Uri(this.Server.Url, this.Route(anchor, id, suffix))), ViewerConstants.JsonOptions)!;

        internal async Task Error(string route, HttpStatusCode expected)
        {
            using HttpResponseMessage response = await this.Client.GetAsync(new Uri(this.Server.Url, route));
            string body = await response.Content.ReadAsStringAsync();
            Assert.True(expected == response.StatusCode, $"Expected {expected}, received {response.StatusCode}: {body}");
            using JsonDocument error = JsonDocument.Parse(body);
            Assert.False(string.IsNullOrWhiteSpace(error.RootElement.GetProperty("error").GetString()));
        }

        internal async Task Action(string route, string action)
        {
            using HttpRequestMessage request = new(HttpMethod.Post, new Uri(this.Server.Url, route));
            request.Headers.Add(ViewerConstants.ClearRequestHeader, action);
            using HttpResponseMessage response = await this.Client.SendAsync(request);
            response.EnsureSuccessStatusCode();
        }

        internal void CorruptIndex(long id)
        {
            using FileStream index = new(Path.Combine(this.Current.Logs.StorageDirectory, "entries.idx"), FileMode.Open, FileAccess.Write, FileShare.ReadWrite);
            index.Seek((id - 1) * sizeof(long), SeekOrigin.Begin);
            byte[] offset = new byte[sizeof(long)];
            BinaryPrimitives.WriteInt64LittleEndian(offset, -1);
            index.Write(offset);
        }

        public void Dispose()
        {
            this.Client.Dispose();
            this.Server.DisposeAsync().AsTask().GetAwaiter().GetResult();
            foreach (LogBuffer buffer in this.buffers) buffer.Dispose();
            Directory.Delete(this.Root, true);
        }
    }
}
