using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace LogStudio;

internal sealed record SessionBundle(int FormatVersion, SessionInfo Session);

internal sealed class SessionImportException : ArgumentException
{
    internal SessionImportException(string message, Exception? inner = null)
        : base(message, inner)
    {
    }
}

internal static class SessionTransfer
{
    internal const long MaximumUploadBytes = 256L * 1024 * 1024;
    internal const long MaximumExpandedBytes = 1024L * 1024 * 1024;
    internal const int MaximumManifestBytes = 64 * 1024;
    internal const int MaximumJsonLineCharacters = 1024 * 1024;
    internal const string BundleFormat = "bundle";
    internal const string JsonLinesFormat = "jsonl";
    private const int FormatVersion = 1;
    private const int MaximumArguments = 1024;
    private const int MaximumParameterLength = 8192;
    private const string BundleManifestFile = "session.json";
    private const string BundleLogsFile = "logs.jsonl";
    private const string UploadFile = "upload.bin";
    private const string JournalFile = "entries.jsonl";
    private const string IndexFile = "entries.idx";
    private const string PendingMetadataFile = "session.json.pending";
    private const string TimestampProperty = "timestamp";
    private const string SeverityProperty = "severity";
    private const string PartialProperty = "isPartial";
    private const UnixFileMode FilePermissions = UnixFileMode.UserRead | UnixFileMode.UserWrite;
    private static readonly UTF8Encoding Utf8 = new(false, true);

    internal static async Task ExportAsync(Stream output, LogHistoryReader history, SessionInfo information, CancellationToken cancellationToken)
    {
        using ZipArchive archive = new(output, ZipArchiveMode.Create, true);
        ZipArchiveEntry manifest = archive.CreateEntry(BundleManifestFile, CompressionLevel.Fastest);
        using (Stream entry = manifest.Open())
            await JsonSerializer.SerializeAsync(entry, new SessionBundle(FormatVersion, information with { IsCurrent = false }), ViewerConstants.JsonOptions, cancellationToken).ConfigureAwait(false);
        ZipArchiveEntry logs = archive.CreateEntry(BundleLogsFile, CompressionLevel.Fastest);
        using StreamWriter writer = new(logs.Open(), Utf8, ViewerConstants.DiskBufferBytes);
        int written = 0;
        foreach (LogEntry record in history.ReadEntries(cancellationToken: cancellationToken))
        {
            await writer.WriteLineAsync(JsonSerializer.Serialize(record, ViewerConstants.JsonOptions).AsMemory(), cancellationToken).ConfigureAwait(false);
            if (++written % ViewerConstants.StreamBatchSize == 0) await writer.FlushAsync(cancellationToken).ConfigureAwait(false);
        }
        await writer.FlushAsync(cancellationToken).ConfigureAwait(false);
    }

    internal static async Task<SessionInfo> ImportAsync(Stream input, string format, string? name, SessionCatalog catalog, CancellationToken cancellationToken)
    {
        if (format is not (BundleFormat or JsonLinesFormat)) throw new SessionImportException("Choose a Log Studio session bundle or JSONL file.");
        if (name is not null && (string.IsNullOrWhiteSpace(name) || name.Length > ViewerConstants.MaximumApplicationNameLength))
            throw new SessionImportException("Session names must contain 1–128 characters.");
        string staging = catalog.CreateImportStaging();
        bool committed = false;
        try
        {
            string uploadPath = Path.Combine(staging, UploadFile);
            using (FileStream upload = CreatePrivateFile(uploadPath))
                await CopyBoundedAsync(input, upload, MaximumUploadBytes, cancellationToken).ConfigureAwait(false);
            SessionInfo? information = null;
            using FileStream source = new(uploadPath, FileMode.Open, FileAccess.Read, FileShare.Read);
            SavedSession imported;
            if (format == BundleFormat)
            {
                try
                {
                    using ZipArchive archive = new(source, ZipArchiveMode.Read, true);
                    if (archive.Entries.Count != 2 || archive.Entries.Any(entry => entry.FullName is not (BundleManifestFile or BundleLogsFile)) ||
                        archive.Entries.Select(entry => entry.FullName).Distinct(StringComparer.Ordinal).Count() != 2)
                        throw new SessionImportException("The bundle must contain only session.json and logs.jsonl, without folders or duplicate entries.");
                    ZipArchiveEntry manifest = archive.GetEntry(BundleManifestFile) ?? throw new SessionImportException("The bundle manifest is missing.");
                    ZipArchiveEntry logs = archive.GetEntry(BundleLogsFile) ?? throw new SessionImportException("The bundle logs are missing.");
                    if (manifest.Length > MaximumManifestBytes || logs.Length > MaximumExpandedBytes)
                        throw new SessionImportException("The bundle expands beyond the supported size limits.");
                    using MemoryStream metadata = new();
                    using (Stream entry = manifest.Open())
                        await CopyBoundedAsync(entry, metadata, MaximumManifestBytes, cancellationToken).ConfigureAwait(false);
                    SessionBundle bundle = JsonSerializer.Deserialize<SessionBundle>(metadata.ToArray(), ViewerConstants.JsonOptions) ??
                        throw new SessionImportException("The bundle manifest is invalid.");
                    if (bundle.FormatVersion != FormatVersion) throw new SessionImportException("This session bundle version is not supported.");
                    information = ValidateInformation(bundle.Session);
                    using Stream records = logs.Open();
                    imported = RebuildJournal(records, staging, name?.Trim() ?? information.Name, information, cancellationToken);
                }
                catch (InvalidDataException exception)
                {
                    throw new SessionImportException("The session bundle is damaged or not a valid ZIP archive.", exception);
                }
                catch (JsonException exception)
                {
                    throw new SessionImportException("The session bundle manifest contains invalid JSON.", exception);
                }
            }
            else
            {
                imported = RebuildJournal(source, staging, name?.Trim() ?? catalog.GenerateName(), null, cancellationToken);
            }
            source.Dispose();
            File.Delete(uploadPath);
            SessionInfo result = catalog.CommitImport(staging, imported);
            committed = true;
            return result;
        }
        catch (DecoderFallbackException exception)
        {
            throw new SessionImportException("The imported log data contains invalid text encoding.", exception);
        }
        finally
        {
            if (!committed)
            {
                foreach (string file in new[] { UploadFile, JournalFile, IndexFile, BundleManifestFile, PendingMetadataFile })
                    File.Delete(Path.Combine(staging, file));
                Directory.Delete(staging);
            }
        }
    }

    private static SavedSession RebuildJournal(Stream input, string staging, string name, SessionInfo? information, CancellationToken cancellationToken)
    {
        using FileStream journal = CreatePrivateFile(Path.Combine(staging, JournalFile));
        using FileStream index = CreatePrivateFile(Path.Combine(staging, IndexFile));
        using StreamReader reader = new(input, Utf8, true, ViewerConstants.DiskBufferBytes, true);
        StringBuilder line = new();
        long count = 0;
        long errors = 0;
        long warnings = 0;
        long expanded = 0;
        long lineNumber = 0;
        DateTimeOffset? first = null;
        DateTimeOffset? last = null;
        HashSet<string?> categories = new(StringComparer.Ordinal);
        byte[] position = new byte[sizeof(long)];
        int character;
        while ((character = reader.Read()) != -1)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (character != '\n')
            {
                line.Append((char)character);
                if (line.Length > MaximumJsonLineCharacters) throw new SessionImportException($"JSONL line {lineNumber + 1} is too large.");
                continue;
            }
            WriteLine();
        }
        if (line.Length > 0) WriteLine();
        if (information is null && count == 0) throw new SessionImportException("The JSONL file contains no log entries.");
        if (information is not null && count != information.EntryCount)
            throw new SessionImportException("The bundle record count does not match its manifest.");
        journal.Flush();
        index.Flush();
        string id = Guid.NewGuid().ToString("N");
        DateTimeOffset started = information?.StartedAt ?? first ?? DateTimeOffset.UtcNow;
        DateTimeOffset completed = information?.CompletedAt ?? (last > started ? last.Value : started);
        SessionInfo session = new(id, name, started, completed, information?.ExitCode, count, information?.Command,
            SessionCatalog.RedactArguments(information?.Arguments ?? Array.Empty<string>()), information?.WorkingDirectory ?? string.Empty, false);
        ViewerStatus status = new(name, started, 0, count, count == 0 ? 0 : 1, count, 0, true, completed, session.ExitCode,
            count + 1, errors, warnings, journal.Position + index.Position, ViewerConstants.DiskBufferBytes * 2, 0,
            ViewerConstants.DefaultFlushEveryEntries, staging, 0);
        return new SavedSession(session, status, categories.OrderBy(value => value, StringComparer.Ordinal).ToArray());

        void WriteLine()
        {
            lineNumber++;
            string text = line.ToString().TrimEnd('\r');
            line.Clear();
            expanded += Utf8.GetByteCount(text) + 1;
            if (expanded > MaximumExpandedBytes) throw new SessionImportException("Expanded logs exceed 1 GiB.");
            if (string.IsNullOrWhiteSpace(text)) return;
            LogEntry record = ParseEntry(text, count + 1, lineNumber);
            byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(record, ViewerConstants.JsonOptions);
            BinaryPrimitives.WriteInt64LittleEndian(position, journal.Position);
            journal.Write(bytes);
            journal.WriteByte((byte)'\n');
            index.Write(position);
            count++;
            if (record.Severity >= LogSeverity.Error) errors++;
            if (record.Severity == LogSeverity.Warning) warnings++;
            if (categories.Count < ViewerConstants.MaximumCategorySuggestions) categories.Add(record.Category);
            first = first is null || record.Timestamp < first.Value ? record.Timestamp : first;
            last = last is null || record.Timestamp > last.Value ? record.Timestamp : last;
        }
    }

    private static LogEntry ParseEntry(string line, long id, long lineNumber)
    {
        try
        {
            using JsonDocument json = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 16 });
            JsonElement root = json.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty(ViewerConstants.IdField, out JsonElement originalId) || !originalId.TryGetInt64(out long value) || value < 1 ||
                !root.TryGetProperty(TimestampProperty, out JsonElement timestamp) || !timestamp.TryGetDateTimeOffset(out DateTimeOffset time) ||
                !root.TryGetProperty(ViewerConstants.MessageField, out JsonElement message) || message.ValueKind != JsonValueKind.String ||
                !root.TryGetProperty(ViewerConstants.CategoryField, out JsonElement category) || category.ValueKind is not (JsonValueKind.Null or JsonValueKind.String) ||
                !root.TryGetProperty(PartialProperty, out JsonElement partial) || partial.ValueKind is not (JsonValueKind.True or JsonValueKind.False) ||
                !root.TryGetProperty(SeverityProperty, out JsonElement severity) || severity.ValueKind != JsonValueKind.String ||
                !Enum.TryParse(severity.GetString(), true, out LogSeverity level) || !Enum.IsDefined(level) ||
                !string.Equals(severity.GetString(), level.ToString(), StringComparison.OrdinalIgnoreCase) ||
                !root.TryGetProperty(ViewerConstants.StreamField, out JsonElement stream) || stream.ValueKind != JsonValueKind.String ||
                !Enum.TryParse(stream.GetString(), true, out LogStream origin) || !Enum.IsDefined(origin) ||
                !string.Equals(stream.GetString(), origin.ToString(), StringComparison.OrdinalIgnoreCase))
                throw new SessionImportException($"Line {lineNumber} is not a valid Log Studio JSONL entry.");
            string text = message.GetString() ?? throw new SessionImportException($"Line {lineNumber} has no message.");
            string? label = category.ValueKind == JsonValueKind.Null ? null : category.GetString();
            if (text.Length > ViewerConstants.MaximumMaxLineLength || label?.Length > ViewerConstants.MaximumCategoryLength)
                throw new SessionImportException($"Line {lineNumber} exceeds message/category limits.");
            return new LogEntry(id, time, origin, level, label, text, partial.GetBoolean());
        }
        catch (JsonException exception)
        {
            throw new SessionImportException($"Line {lineNumber} contains invalid JSON.", exception);
        }
        catch (InvalidOperationException exception)
        {
            throw new SessionImportException($"Line {lineNumber} has an invalid field type.", exception);
        }
    }

    private static SessionInfo ValidateInformation(SessionInfo? session)
    {
        if (session is null || string.IsNullOrWhiteSpace(session.Name) || session.Name.Length > ViewerConstants.MaximumApplicationNameLength ||
            session.StartedAt == default || session.EntryCount < 0 || session.Arguments is null || session.Arguments.Length > MaximumArguments ||
            session.Arguments.Any(argument => argument is null || argument.Length > MaximumParameterLength) ||
            session.WorkingDirectory is null || session.WorkingDirectory.Length > MaximumParameterLength ||
            session.Command?.Length > MaximumParameterLength || session.CompletedAt < session.StartedAt)
            throw new SessionImportException("The bundle session details are invalid or exceed supported limits.");
        return session;
    }

    private static FileStream CreatePrivateFile(string path)
    {
        FileStreamOptions options = new() { Mode = FileMode.CreateNew, Access = FileAccess.Write, BufferSize = ViewerConstants.DiskBufferBytes };
        if (!OperatingSystem.IsWindows()) options.UnixCreateMode = FilePermissions;
        return new FileStream(path, options);
    }

    private static async Task CopyBoundedAsync(Stream input, Stream output, long maximumBytes, CancellationToken cancellationToken)
    {
        byte[] buffer = new byte[ViewerConstants.DiskBufferBytes];
        long total = 0;
        int count;
        while ((count = await input.ReadAsync(buffer.AsMemory(), cancellationToken).ConfigureAwait(false)) > 0)
        {
            total += count;
            if (total > maximumBytes) throw new SessionImportException($"The transfer exceeds the {maximumBytes:N0}-byte limit.");
            await output.WriteAsync(buffer.AsMemory(0, count), cancellationToken).ConfigureAwait(false);
        }
    }
}
