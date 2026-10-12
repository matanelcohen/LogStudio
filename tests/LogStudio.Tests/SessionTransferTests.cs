using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace LogStudio.Tests;

public sealed class SessionTransferTests
{
    private const string ManifestFile = "session.json";
    private const string LogsFile = "logs.jsonl";
    private const string JournalFile = "entries.jsonl";
    private const string IndexFile = "entries.idx";
    private const string UnexpectedFile = "unexpected.txt";
    private const string SyntheticSecret = "synthetic-transfer-secret";
    private const uint CentralDirectorySignature = 0x02014b50;
    private static readonly DateTimeOffset CapturedAt = new(2026, 10, 11, 8, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task PortableBundleRoundTripPreservesRetainedLogsAndRedactedRunDetails()
    {
        using Fixture fixture = new(capacity: 2);
        fixture.Viewer.Record("expired");
        fixture.Viewer.Record("retained first", category: "Transfer.Tests", severity: LogSeverity.Warning);
        fixture.Viewer.Record("retained second", LogStream.Stderr, severity: LogSeverity.Error, category: "Transfer.Tests");
        fixture.Viewer.Complete(7);
        SessionInfo original = (await fixture.List()).Single();
        using HttpResponseMessage exported = await fixture.Client.GetAsync(fixture.Url(ViewerConstants.BundleExportRoute + "?levels=not-json&q=missing"));
        Assert.Equal(HttpStatusCode.OK, exported.StatusCode);
        Assert.Equal(ViewerConstants.ZipContentType, exported.Content.Headers.ContentType?.MediaType);
        Assert.EndsWith(".logstudio.zip", exported.Content.Headers.ContentDisposition?.FileName?.Trim('"'), StringComparison.Ordinal);
        byte[] bytes = await exported.Content.ReadAsByteArrayAsync();
        using (ZipArchive archive = new(new MemoryStream(bytes), ZipArchiveMode.Read))
        {
            Assert.Equal(new[] { LogsFile, ManifestFile }, archive.Entries.Select(entry => entry.FullName).OrderBy(name => name, StringComparer.Ordinal));
            using StreamReader metadata = new(archive.GetEntry(ManifestFile)!.Open());
            string manifest = await metadata.ReadToEndAsync();
            Assert.DoesNotContain(SyntheticSecret, manifest, StringComparison.Ordinal);
            Assert.Contains("[redacted]", manifest, StringComparison.Ordinal);
        }

        SessionInfo imported = await fixture.Import(bytes, SessionTransfer.BundleFormat);
        Assert.NotEqual(original.Id, imported.Id);
        Assert.False(imported.IsCurrent);
        Assert.Equal(original.Name, imported.Name);
        Assert.Equal(original.StartedAt, imported.StartedAt);
        Assert.Equal(original.CompletedAt, imported.CompletedAt);
        Assert.Equal(7, imported.ExitCode);
        Assert.Equal(original.Command, imported.Command);
        Assert.Equal(original.Arguments, imported.Arguments);
        Assert.Equal(original.WorkingDirectory, imported.WorkingDirectory);
        using LogHistoryReader history = fixture.Catalog.Open(imported.Id);
        LogEntry[] logs = history.ReadEntries().ToArray();
        Assert.Equal(new long[] { 1, 2 }, logs.Select(entry => entry.Id));
        Assert.Equal(new[] { "retained first", "retained second" }, logs.Select(entry => entry.Message));
        Assert.Equal(LogStream.Stderr, logs[1].Stream);
        Assert.Equal(1, history.Status.ErrorCount);
        Assert.Equal(1, history.Status.WarningCount);
        Assert.Equal(2, history.Status.RetainedCount);
        Assert.Equal(2, fixture.Viewer.GetLogs().Count);
        Assert.Empty(Directory.GetDirectories(fixture.Root, ".import-*"));
        if (!OperatingSystem.IsWindows())
        {
            string directory = Path.Combine(fixture.Root, imported.Id);
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute, File.GetUnixFileMode(directory));
            foreach (string file in Directory.GetFiles(directory))
                Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(file));
        }
    }

    [Fact]
    public async Task FilteredJsonlImportRebuildsDenseIdsAndKeepsFieldsAndDates()
    {
        using Fixture fixture = new();
        for (int index = 1; index <= 5; index++)
            fixture.Viewer.Record("record " + index, category: "Transfer.Tests", severity: index % 2 == 0 ? LogSeverity.Error : LogSeverity.Information);
        string query = "?levels=" + Uri.EscapeDataString("[\"error\"]");
        byte[] bytes = await fixture.Client.GetByteArrayAsync(fixture.Url(ViewerConstants.ExportRoute + query));
        Assert.Contains("\"id\":2", Encoding.UTF8.GetString(bytes), StringComparison.Ordinal);
        Assert.Contains("\"id\":4", Encoding.UTF8.GetString(bytes), StringComparison.Ordinal);
        SessionInfo imported = await fixture.Import(bytes, SessionTransfer.JsonLinesFormat, "Filtered errors");
        using LogHistoryReader history = fixture.Catalog.Open(imported.Id);
        LogEntry[] logs = history.ReadEntries().ToArray();
        Assert.Equal(new long[] { 1, 2 }, logs.Select(entry => entry.Id));
        Assert.Equal(new[] { "record 2", "record 4" }, logs.Select(entry => entry.Message));
        Assert.All(logs, entry => Assert.Equal("Transfer.Tests", entry.Category));
        Assert.Equal(2, history.Status.ErrorCount);
        Assert.Equal(logs.Min(entry => entry.Timestamp), imported.StartedAt);
        Assert.Equal(logs.Max(entry => entry.Timestamp), imported.CompletedAt);
        Assert.Equal(2 * sizeof(long), new FileInfo(Path.Combine(fixture.Root, imported.Id, IndexFile)).Length);
        Assert.Equal(5, fixture.Viewer.GetLogs().Count);
        using JsonDocument page = JsonDocument.Parse(await fixture.Client.GetStringAsync(fixture.Url(ViewerConstants.SearchRoute + "?sessionId=" + imported.Id)));
        Assert.Equal(2, page.RootElement.GetProperty("matchCount").GetInt64());
    }

    [Fact]
    public async Task EmptyRetainedSessionBundleIsValidButEmptyJsonlIsRejected()
    {
        using Fixture fixture = new();
        fixture.Viewer.Record("deleted");
        using HttpResponseMessage cleared = await fixture.Action(ViewerConstants.ClearRoute, ViewerConstants.ClearRequestAction);
        cleared.EnsureSuccessStatusCode();
        byte[] bytes = await fixture.Client.GetByteArrayAsync(fixture.Url(ViewerConstants.BundleExportRoute));
        SessionInfo imported = await fixture.Import(bytes, SessionTransfer.BundleFormat);
        Assert.Equal(0, imported.EntryCount);
        using LogHistoryReader history = fixture.Catalog.Open(imported.Id);
        Assert.Empty(history.ReadEntries());
        Assert.Equal(0, history.Status.LastId);
        using HttpResponseMessage invalid = await fixture.Upload(Encoding.UTF8.GetBytes(" \n\r\n"), SessionTransfer.JsonLinesFormat);
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        Assert.Contains("no log entries", await invalid.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        Assert.Empty(Directory.GetDirectories(fixture.Root, ".import-*"));
    }

    [Theory]
    [InlineData("id", "\"bad\"")]
    [InlineData("id", "0")]
    [InlineData("timestamp", "12")]
    [InlineData("timestamp", "\"not-a-date\"")]
    [InlineData("message", "null")]
    [InlineData("category", "true")]
    [InlineData("isPartial", "\"false\"")]
    [InlineData("severity", "\"1\"")]
    [InlineData("severity", "\"unknown\"")]
    [InlineData("stream", "\"1\"")]
    [InlineData("stream", "\"unknown\"")]
    public async Task InvalidRecordFieldsAreRejectedAndPartialImportIsRemoved(string field, string value)
    {
        JsonObject record = JsonNode.Parse(Record())?.AsObject() ?? throw new InvalidOperationException();
        record[field] = JsonNode.Parse(value);
        using Fixture fixture = new();
        using HttpResponseMessage invalid = await fixture.Upload(Encoding.UTF8.GetBytes(Record() + "\n" + record.ToJsonString()), SessionTransfer.JsonLinesFormat);
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        Assert.Contains("Line 2", await invalid.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        Assert.Empty(Directory.GetDirectories(fixture.Root));
        Assert.Single(await fixture.List());
    }

    [Theory]
    [InlineData("")]
    [InlineData("{")]
    [InlineData("[]")]
    [InlineData("{}")]
    public async Task InvalidJsonlDoesNotCreateSavedSession(string records)
    {
        using Fixture fixture = new();
        using HttpResponseMessage invalid = await fixture.Upload(Encoding.UTF8.GetBytes(records), SessionTransfer.JsonLinesFormat);
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        Assert.Empty(Directory.GetDirectories(fixture.Root));
    }

    [Fact]
    public async Task RecordLengthAndEncodingLimitsAreEnforced()
    {
        using Fixture fixture = new();
        foreach (string records in new[]
        {
            Record(new string('x', ViewerConstants.MaximumMaxLineLength + 1)),
            Record(category: new string('x', ViewerConstants.MaximumCategoryLength + 1)),
            new string(' ', SessionTransfer.MaximumJsonLineCharacters + 1),
        })
        {
            using HttpResponseMessage invalid = await fixture.Upload(Encoding.UTF8.GetBytes(records), SessionTransfer.JsonLinesFormat);
            Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
            Assert.Empty(Directory.GetDirectories(fixture.Root));
        }
        using HttpResponseMessage encoding = await fixture.Upload(new byte[] { 0xff, 0xff, 0xff }, SessionTransfer.JsonLinesFormat);
        Assert.Equal(HttpStatusCode.BadRequest, encoding.StatusCode);
        Assert.Contains("encoding", await encoding.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        Assert.Empty(Directory.GetDirectories(fixture.Root));
    }

    [Theory]
    [InlineData("../logs.jsonl")]
    [InlineData("nested/logs.jsonl")]
    [InlineData("duplicate")]
    [InlineData("extra")]
    public async Task ZipPathsDuplicatesAndExtraEntriesAreRejected(string variant)
    {
        using Fixture fixture = new();
        List<(string Name, string Content)> entries = new()
        {
            (ManifestFile, JsonSerializer.Serialize(new SessionBundle(1, Information()), ViewerConstants.JsonOptions)),
            (variant is "duplicate" or "extra" ? LogsFile : variant, Record()),
        };
        if (variant == "duplicate") entries.Add((LogsFile, Record()));
        if (variant == "extra") entries.Add((IndexFile, "untrusted index"));
        using HttpResponseMessage invalid = await fixture.Upload(CreateZip(entries.ToArray()), SessionTransfer.BundleFormat);
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        Assert.Empty(Directory.GetDirectories(fixture.Root));
    }

    [Fact]
    public async Task BundleVersionsCountsAndMetadataLimitsAreValidated()
    {
        using Fixture fixture = new();
        foreach (byte[] bytes in new[]
        {
            Bundle(Record(), Information(), version: 2),
            Bundle(Record(), Information() with { EntryCount = 2 }),
            Bundle(Record(), Information() with { Name = string.Empty }),
            Bundle(Record(), Information() with { StartedAt = default }),
            Bundle(Record(), Information() with { WorkingDirectory = new string('x', 8193) }),
            Bundle(Record(), Information() with { Arguments = Enumerable.Repeat(string.Empty, 1025).ToArray() }),
            CreateZip((ManifestFile, new string(' ', SessionTransfer.MaximumManifestBytes + 1)), (LogsFile, Record())),
            CreateZip((ManifestFile, "{"), (LogsFile, Record())),
            Encoding.UTF8.GetBytes("not a ZIP"),
        })
        {
            using HttpResponseMessage invalid = await fixture.Upload(bytes, SessionTransfer.BundleFormat);
            Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
            Assert.Empty(Directory.GetDirectories(fixture.Root));
        }
    }

    [Fact]
    public async Task ExpandedZipLimitIsCheckedBeforeOpeningItsLogStream()
    {
        byte[] bytes = Bundle(Record(), Information());
        using (ZipArchive archive = new(new MemoryStream(bytes), ZipArchiveMode.Read))
            Assert.Equal(2, archive.Entries.Count);
        bool patched = false;
        for (int offset = 0; offset <= bytes.Length - 46; offset++)
        {
            if (BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(offset)) != CentralDirectorySignature) continue;
            int nameLength = BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(offset + 28));
            if (Encoding.UTF8.GetString(bytes, offset + 46, nameLength) != LogsFile) continue;
            BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(offset + 24), checked((uint)(SessionTransfer.MaximumExpandedBytes + 1)));
            patched = true;
            break;
        }
        Assert.True(patched);
        using Fixture fixture = new();
        using HttpResponseMessage invalid = await fixture.Upload(bytes, SessionTransfer.BundleFormat);
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        Assert.Contains("size limits", await invalid.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        Assert.Empty(Directory.GetDirectories(fixture.Root));
    }

    [Fact]
    public async Task ActualUploadLimitAndCancellationCleanStaging()
    {
        using Fixture fixture = new();
        using Stream oversized = new GeneratedStream(SessionTransfer.MaximumUploadBytes + 1);
        await Assert.ThrowsAsync<SessionImportException>(() => SessionTransfer.ImportAsync(oversized, SessionTransfer.JsonLinesFormat, null, fixture.Catalog, CancellationToken.None));
        Assert.Empty(Directory.GetDirectories(fixture.Root));
        using CancellationTokenSource cancellation = new();
        cancellation.Cancel();
        using MemoryStream source = new(Encoding.UTF8.GetBytes(Record()));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => SessionTransfer.ImportAsync(source, SessionTransfer.JsonLinesFormat, null, fixture.Catalog, cancellation.Token));
        Assert.Empty(Directory.GetDirectories(fixture.Root));
    }

    [Fact]
    public async Task UnnamedJsonLinesImportsReceiveUniqueRandomNames()
    {
        using Fixture fixture = new();
        byte[] records = Encoding.UTF8.GetBytes(Record());
        SessionInfo first = await fixture.Import(records, SessionTransfer.JsonLinesFormat);
        SessionInfo second = await fixture.Import(records, SessionTransfer.JsonLinesFormat);
        SessionNameGeneratorTests.AssertFriendlyName(first.Name);
        SessionNameGeneratorTests.AssertFriendlyName(second.Name);
        Assert.NotEqual(first.Name, second.Name);
        using LogHistoryReader history = fixture.Catalog.Open(first.Id);
        Assert.Equal(first.Name, history.Status.ApplicationName);
    }

    [Fact]
    public async Task RenameAndConfirmedDeleteAffectOnlyChosenSavedSession()
    {
        using Fixture fixture = new();
        fixture.Viewer.Record("current untouched");
        SessionInfo imported = await fixture.Import(Encoding.UTF8.GetBytes(Record()), SessionTransfer.JsonLinesFormat);
        string route = ViewerConstants.SessionsRoute + "?sessionId=" + imported.Id;
        using HttpResponseMessage renamed = await fixture.Action(route, ViewerConstants.RenameAction, "{\"name\":\" Named import \"}");
        renamed.EnsureSuccessStatusCode();
        Assert.Equal("Named import", (await fixture.List()).Single(session => !session.IsCurrent).Name);
        using HttpResponseMessage deleted = await fixture.Action(route, ViewerConstants.DeleteSessionAction);
        deleted.EnsureSuccessStatusCode();
        Assert.False(Directory.Exists(Path.Combine(fixture.Root, imported.Id)));
        Assert.Single(await fixture.List());
        Assert.Equal("current untouched", Assert.Single(fixture.Viewer.GetLogs()).Message);
        using HttpResponseMessage repeat = await fixture.Action(route, ViewerConstants.DeleteSessionAction);
        Assert.Equal(HttpStatusCode.NotFound, repeat.StatusCode);
    }

    [Fact]
    public async Task DeleteRefusesUnexpectedFilesWithoutPartiallyRemovingHistory()
    {
        using Fixture fixture = new();
        SessionInfo imported = await fixture.Import(Encoding.UTF8.GetBytes(Record()), SessionTransfer.JsonLinesFormat);
        string directory = Path.Combine(fixture.Root, imported.Id);
        File.WriteAllText(Path.Combine(directory, UnexpectedFile), "synthetic unexpected file");
        using HttpResponseMessage refused = await fixture.Action(ViewerConstants.SessionsRoute + "?sessionId=" + imported.Id, ViewerConstants.DeleteSessionAction);
        Assert.Equal(HttpStatusCode.InternalServerError, refused.StatusCode);
        Assert.Contains("Could not change", await refused.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        Assert.True(File.Exists(Path.Combine(directory, JournalFile)));
        Assert.Equal(2, (await fixture.List()).Length);
    }

    [Fact]
    public async Task CatalogDeleteInvalidatesAnExistingReader()
    {
        using Fixture fixture = new();
        SessionInfo imported = await fixture.Import(Encoding.UTF8.GetBytes(Record()), SessionTransfer.JsonLinesFormat);
        using LogHistoryReader history = fixture.Catalog.Open(imported.Id);
        fixture.Catalog.Delete(imported.Id);
        Assert.Throws<HistoryClearedException>(() => history.ReadEntries().ToArray());
    }

    [Theory]
    [InlineData("{")]
    [InlineData("[]")]
    [InlineData("{\"name\":5}")]
    [InlineData("{\"name\":\"   \"}")]
    [InlineData("{\"name\":null}")]
    public async Task InvalidRenameRequestsReturnActionableBadRequest(string body)
    {
        using Fixture fixture = new();
        SessionInfo imported = await fixture.Import(Encoding.UTF8.GetBytes(Record()), SessionTransfer.JsonLinesFormat);
        SessionInfo current = (await fixture.List()).Single(session => session.IsCurrent);
        foreach (SessionInfo session in new[] { imported, current })
        {
            using HttpResponseMessage response = await fixture.Action(ViewerConstants.SessionsRoute + "?sessionId=" + session.Id, ViewerConstants.RenameAction, body);
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.Contains("session name", await response.Content.ReadAsStringAsync(), StringComparison.OrdinalIgnoreCase);
            Assert.Equal(session.Name, (await fixture.List()).Single(entry => entry.Id == session.Id).Name);
        }
    }

    [Fact]
    public async Task CurrentRunCannotBeDeletedAndInvalidSessionIdentifiersCannotBeManaged()
    {
        using Fixture fixture = new();
        SessionInfo current = (await fixture.List()).Single();
        foreach (string id in new[] { current.Id, "../other", string.Empty })
        {
            using HttpResponseMessage deleted = await fixture.Action(ViewerConstants.SessionsRoute + "?sessionId=" + Uri.EscapeDataString(id), ViewerConstants.DeleteSessionAction);
            Assert.Equal(HttpStatusCode.BadRequest, deleted.StatusCode);
            if (id != current.Id)
            {
                using HttpResponseMessage renamed = await fixture.Action(ViewerConstants.SessionsRoute + "?sessionId=" + Uri.EscapeDataString(id), ViewerConstants.RenameAction, "{\"name\":\"No\"}");
                Assert.Equal(HttpStatusCode.BadRequest, renamed.StatusCode);
            }
        }
    }

    [Fact]
    public async Task CurrentRenameUpdatesStatusSearchAndExportWithoutChangingLogs()
    {
        using Fixture fixture = new();
        fixture.Viewer.Record("current retained");
        SessionInfo current = (await fixture.List()).Single();
        using HttpResponseMessage response = await fixture.Action(ViewerConstants.SessionsRoute + "?sessionId=" + current.Id,
            ViewerConstants.RenameAction, "{\"name\":\" Current investigation \"}");
        response.EnsureSuccessStatusCode();
        SessionInfo renamed = JsonSerializer.Deserialize<SessionInfo>(await response.Content.ReadAsStringAsync(), ViewerConstants.JsonOptions)!;
        Assert.True(renamed.IsCurrent);
        Assert.Equal(current.Id, renamed.Id);
        Assert.Equal(current.StartedAt, renamed.StartedAt);
        Assert.Equal("Current investigation", renamed.Name);
        Assert.Equal(renamed.Name, (await fixture.List()).Single().Name);
        using JsonDocument page = JsonDocument.Parse(await fixture.Client.GetStringAsync(fixture.Url(ViewerConstants.SearchRoute)));
        Assert.Equal(renamed.Name, page.RootElement.GetProperty("status").GetProperty("applicationName").GetString());
        byte[] bundle = await fixture.Client.GetByteArrayAsync(fixture.Url(ViewerConstants.BundleExportRoute));
        using ZipArchive archive = new(new MemoryStream(bundle), ZipArchiveMode.Read);
        using JsonDocument manifest = JsonDocument.Parse(archive.GetEntry(ManifestFile)!.Open());
        Assert.Equal(renamed.Name, manifest.RootElement.GetProperty("session").GetProperty("name").GetString());
        Assert.Equal("current retained", Assert.Single(fixture.Viewer.GetLogs()).Message);
        Assert.Empty(Directory.GetDirectories(fixture.Root));
    }

    [Fact]
    public async Task OverlongCurrentRenameIsRejectedWithoutChangingItsName()
    {
        using Fixture fixture = new();
        SessionInfo current = (await fixture.List()).Single();
        using HttpResponseMessage response = await fixture.Action(ViewerConstants.SessionsRoute + "?sessionId=" + current.Id,
            ViewerConstants.RenameAction, JsonSerializer.Serialize(new { name = new string('x', ViewerConstants.MaximumApplicationNameLength + 1) }));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(current.Name, (await fixture.List()).Single().Name);
    }

    [Theory]
    [InlineData("api/import?format=jsonl", "import")]
    [InlineData("api/sessions?sessionId=saved", "rename")]
    [InlineData("api/sessions?sessionId=saved", "delete")]
    public async Task MutationsRequireExplicitActionsAndSameOrigin(string route, string action)
    {
        using Fixture fixture = new();
        using HttpResponseMessage missing = await fixture.Action(route, null, Record());
        Assert.Equal(HttpStatusCode.Forbidden, missing.StatusCode);
        using HttpRequestMessage request = new(HttpMethod.Post, fixture.Url(route));
        request.Headers.Add(ViewerConstants.ClearRequestHeader, action);
        request.Headers.Add(ViewerConstants.OriginHeader, "https://untrusted.invalid");
        request.Content = new StringContent(Record());
        using HttpResponseMessage foreign = await fixture.Client.SendAsync(request);
        Assert.Equal(HttpStatusCode.Forbidden, foreign.StatusCode);
    }

    private static string Record(string message = "imported record", string? category = "Transfer.Tests") =>
        JsonSerializer.Serialize(new LogEntry(41, CapturedAt, LogStream.Stdout, LogSeverity.Information, category, message, true), ViewerConstants.JsonOptions);

    private static SessionInfo Information() => new(Guid.NewGuid().ToString("N"), "Portable run", CapturedAt, CapturedAt.AddMinutes(1),
        0, 1, "dotnet", new[] { "run", "--token=" + SyntheticSecret }, "/synthetic/run", false);

    private static byte[] Bundle(string records, SessionInfo information, int version = 1) =>
        CreateZip((ManifestFile, JsonSerializer.Serialize(new SessionBundle(version, information), ViewerConstants.JsonOptions)), (LogsFile, records));

    private static byte[] CreateZip(params (string Name, string Content)[] entries)
    {
        using MemoryStream output = new();
        using (ZipArchive archive = new(output, ZipArchiveMode.Create, true))
        {
            foreach ((string name, string content) in entries)
            {
                using StreamWriter writer = new(archive.CreateEntry(name).Open(), new UTF8Encoding(false));
                writer.Write(content);
            }
        }
        return output.ToArray();
    }

    private sealed class Fixture : IDisposable
    {
        internal Fixture(int capacity = 0)
        {
            this.Root = Directory.CreateTempSubdirectory("logstudio-transfer-test-").FullName;
            ConsoleLogViewerOptions options = new()
            {
                CaptureConsole = false,
                SessionsDirectory = this.Root,
                Capacity = capacity,
                ApplicationName = "Transfer fixture",
                RunCommand = "dotnet",
                RunArguments = new[] { "run", "--token", SyntheticSecret },
                RunWorkingDirectory = "/synthetic/current",
            };
            this.Catalog = new SessionCatalog(options.Validate());
            this.Viewer = ConsoleLogViewer.Start(options);
        }

        internal string Root { get; }
        internal SessionCatalog Catalog { get; }
        internal ConsoleLogViewer Viewer { get; }
        internal HttpClient Client { get; } = new();
        internal Uri Url(string route) => new(this.Viewer.Url, route);

        internal async Task<SessionInfo[]> List() =>
            JsonSerializer.Deserialize<SessionInfo[]>(await this.Client.GetStringAsync(this.Url(ViewerConstants.SessionsRoute)), ViewerConstants.JsonOptions) ??
            throw new InvalidOperationException("No session list returned.");

        internal Task<HttpResponseMessage> Upload(byte[] bytes, string format, string? name = null)
        {
            string route = ViewerConstants.ImportRoute + "?format=" + Uri.EscapeDataString(format) + (name is null ? string.Empty : "&name=" + Uri.EscapeDataString(name));
            HttpRequestMessage request = new(HttpMethod.Post, this.Url(route)) { Content = new ByteArrayContent(bytes) };
            request.Headers.Add(ViewerConstants.ClearRequestHeader, ViewerConstants.ImportAction);
            return this.Send(request);
        }

        internal async Task<SessionInfo> Import(byte[] bytes, string format, string? name = null)
        {
            using HttpResponseMessage response = await this.Upload(bytes, format, name);
            response.EnsureSuccessStatusCode();
            return JsonSerializer.Deserialize<SessionInfo>(await response.Content.ReadAsStringAsync(), ViewerConstants.JsonOptions) ??
                throw new InvalidOperationException("No imported session returned.");
        }

        internal Task<HttpResponseMessage> Action(string route, string? action, string? body = null)
        {
            HttpRequestMessage request = new(HttpMethod.Post, this.Url(route));
            if (action is not null) request.Headers.Add(ViewerConstants.ClearRequestHeader, action);
            if (body is not null) request.Content = new StringContent(body, Encoding.UTF8, "application/json");
            return this.Send(request);
        }

        public void Dispose()
        {
            this.Client.Dispose();
            this.Viewer.Dispose();
            foreach (string directory in Directory.GetDirectories(this.Root))
            {
                foreach (string file in new[] { ManifestFile, JournalFile, IndexFile, "upload.bin", "session.json.pending", UnexpectedFile })
                    File.Delete(Path.Combine(directory, file));
                Directory.Delete(directory);
            }
            Directory.Delete(this.Root);
        }

        private async Task<HttpResponseMessage> Send(HttpRequestMessage request)
        {
            using (request) return await this.Client.SendAsync(request);
        }
    }

    private sealed class GeneratedStream(long length) : Stream
    {
        private long position;
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => length;
        public override long Position { get => this.position; set => throw new NotSupportedException(); }
        public override void Flush() => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override int Read(byte[] buffer, int offset, int count) => this.Read(buffer.AsSpan(offset, count));
        public override int Read(Span<byte> buffer)
        {
            int count = (int)Math.Min(buffer.Length, length - this.position);
            buffer[..count].Clear();
            this.position += count;
            return count;
        }
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return ValueTask.FromResult(this.Read(buffer.Span));
        }
    }
}
