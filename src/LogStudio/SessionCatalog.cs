using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace LogStudio;

internal sealed record SessionInfo(
    string Id, string Name, DateTimeOffset StartedAt, DateTimeOffset? CompletedAt,
    int? ExitCode, long EntryCount, string? Command, string[] Arguments, string WorkingDirectory, bool IsCurrent);

internal sealed record SavedSession(SessionInfo Session, ViewerStatus Status, string?[] Categories);

internal sealed class SessionCatalog
{
    private const string MetadataFile = "session.json";
    private const string PendingMetadataFile = "session.json.pending";
    private const string JournalFile = "entries.jsonl";
    private const string IndexFile = "entries.idx";
    private const string RedactedValue = "[redacted]";
    private const UnixFileMode DirectoryPermissions = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;
    private const UnixFileMode FilePermissions = UnixFileMode.UserRead | UnixFileMode.UserWrite;
    private static readonly string[] SensitiveTerms = { "password", "passwd", "secret", "token", "api-key", "apikey", "authorization", "credential" };
    private static readonly string[] SessionFiles = { JournalFile, IndexFile, MetadataFile, PendingMetadataFile };
    private readonly object gate = new();
    private readonly ViewerSettings settings;
    private readonly Dictionary<string, long> generations = new(StringComparer.Ordinal);
    private readonly string[] arguments;

    internal SessionCatalog(ViewerSettings settings)
    {
        this.settings = settings;
        this.Id = Guid.NewGuid().ToString("N");
        this.arguments = RedactArguments(settings.RunArguments);
    }

    internal string Id { get; }

    internal static string GenerateName() => $"session-{Guid.NewGuid():N}";

    internal static string ValidateName(string name)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Length > ViewerConstants.MaximumApplicationNameLength)
            throw new ArgumentException("Session names must contain 1–128 characters.", nameof(name));
        return name.Trim();
    }

    internal SessionInfo Information(string? id, ViewerStatus current)
    {
        lock (this.gate) return string.IsNullOrEmpty(id) || id == this.Id ? this.Describe(current) : this.Read(id).Session;
    }

    internal string CreateImportStaging()
    {
        lock (this.gate)
        {
            MakePrivateDirectory(this.settings.SessionsDirectory);
            string path = Path.Combine(this.settings.SessionsDirectory, ".import-" + Guid.NewGuid().ToString("N"));
            MakePrivateDirectory(path);
            return path;
        }
    }

    internal SessionInfo CommitImport(string staging, SavedSession session)
    {
        lock (this.gate)
        {
            string destination = this.DirectoryFor(session.Session.Id);
            if (Directory.Exists(destination)) throw new IOException("The imported session identifier already exists.");
            SavedSession saved = session with
            {
                Session = session.Session with { IsCurrent = false },
                Status = session.Status with { HistoryDirectory = destination },
            };
            this.Write(staging, saved);
            Directory.Move(staging, destination);
            return saved.Session;
        }
    }

    internal SessionInfo Rename(string id, string name)
    {
        name = ValidateName(name);
        lock (this.gate)
        {
            if (id == this.Id) throw new ArgumentException("Rename the current session through its viewer.");
            return this.RenameSaved(id, name);
        }
    }

    internal void UpdateCurrentName(string name)
    {
        if (!this.settings.SaveSession) return;
        lock (this.gate)
        {
            if (File.Exists(Path.Combine(this.DirectoryFor(this.Id), MetadataFile)))
                this.RenameSaved(this.Id, name);
        }
    }

    internal void Delete(string id)
    {
        lock (this.gate)
        {
            if (id == this.Id) throw new ArgumentException("The active run cannot be deleted. Clear its logs instead.");
            this.Read(id);
            string directory = this.DirectoryFor(id);
            if (Directory.EnumerateDirectories(directory).Any() ||
                Directory.EnumerateFiles(directory).Any(file => !SessionFiles.Contains(Path.GetFileName(file), StringComparer.Ordinal)))
                throw new IOException("The session contains unexpected files. Move those files before deleting the session.");
            this.generations[id] = this.generations.GetValueOrDefault(id) + 1;
            foreach (string file in SessionFiles) File.Delete(Path.Combine(directory, file));
            Directory.Delete(directory);
        }
    }

    internal SessionInfo Describe(ViewerStatus status, bool current = true) => new(
        this.Id, status.ApplicationName, status.StartedAt, status.CompletedAt, status.ExitCode, status.RetainedCount,
        this.settings.RunCommand, this.arguments, this.settings.RunWorkingDirectory, current);

    internal SessionInfo[] List(ViewerStatus current)
    {
        lock (this.gate)
        {
            List<SessionInfo> entries = new() { this.Describe(current) };
            if (!Directory.Exists(this.settings.SessionsDirectory)) return entries.ToArray();
            foreach (string directory in Directory.EnumerateDirectories(this.settings.SessionsDirectory))
            {
                string id = Path.GetFileName(directory);
                if (id == this.Id || !Guid.TryParseExact(id, "N", out _)) continue;
                string metadata = Path.Combine(directory, MetadataFile);
                if (!File.Exists(metadata)) continue;
                entries.Add(this.Read(id).Session with { IsCurrent = false });
            }

            return entries.OrderByDescending(entry => entry.StartedAt).ToArray();
        }
    }

    internal void Save(LogBuffer logs, bool closing = false)
    {
        if (!this.settings.SaveSession) return;
        lock (this.gate)
        {
            MakePrivateDirectory(this.settings.SessionsDirectory);
            string destination = this.DirectoryFor(this.Id);
            MakePrivateDirectory(destination);
            using LogHistoryReader history = logs.OpenHistory();
            logs.CopyJournal(destination);
            foreach (string file in new[] { JournalFile, IndexFile })
                if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(Path.Combine(destination, file), FilePermissions);
            ViewerStatus status = history.Status with { HistoryDirectory = destination };
            if (closing && !status.IsCompleted) status = status with { IsCompleted = true, CompletedAt = DateTimeOffset.UtcNow };
            this.Write(destination, new SavedSession(this.Describe(status, false), status, history.Categories));
        }
    }

    internal LogHistoryReader Open(string id)
    {
        lock (this.gate)
        {
            SavedSession saved = this.Read(id);
            long generation = this.generations.GetValueOrDefault(id);
            string directory = this.DirectoryFor(id);
            return new LogHistoryReader(Path.Combine(directory, JournalFile), Path.Combine(directory, IndexFile),
                saved.Status, saved.Categories, () => this.Generation(id) == generation);
        }
    }

    internal LogClearResult Clear(string id)
    {
        lock (this.gate)
        {
            SavedSession saved = this.Read(id);
            this.generations[id] = this.generations.GetValueOrDefault(id) + 1;
            string directory = this.DirectoryFor(id);
            foreach (string file in new[] { JournalFile, IndexFile })
            {
                using FileStream stream = new(Path.Combine(directory, file), FileMode.Open, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
                stream.SetLength(0);
            }

            long deleted = saved.Status.LastId - saved.Status.ClearedThroughId;
            ViewerStatus status = saved.Status with
            {
                ClearedThroughId = saved.Status.LastId,
                RetainedCount = 0,
                FirstId = 0,
                ErrorCount = 0,
                WarningCount = 0,
                EvictedCount = 0,
                JournalBytes = 0,
                PendingEntries = 0,
                Revision = saved.Status.Revision + 1,
            };
            this.Write(directory, new SavedSession(saved.Session with { EntryCount = 0 }, status, Array.Empty<string?>()));
            return new LogClearResult(deleted, status);
        }
    }

    internal static string[] RedactArguments(string[] source)
    {
        string[] result = new string[source.Length];
        bool redactNext = false;
        for (int index = 0; index < source.Length; index++)
        {
            string value = source[index];
            if (redactNext)
            {
                result[index] = RedactedValue;
                redactNext = false;
                continue;
            }

            int separator = value.IndexOf('=');
            string key = separator >= 0 ? value[..separator] : value;
            bool sensitive = key.StartsWith('-') && SensitiveTerms.Any(term => key.Contains(term, StringComparison.OrdinalIgnoreCase));
            result[index] = sensitive && separator >= 0 ? key + "=" + RedactedValue : value;
            redactNext = sensitive && separator < 0;
        }

        return result;
    }

    private long Generation(string id)
    {
        lock (this.gate) return this.generations.GetValueOrDefault(id);
    }

    private string DirectoryFor(string id)
    {
        if (!Guid.TryParseExact(id, "N", out _)) throw new ArgumentException("sessionId must be a valid session identifier.");
        return Path.Combine(this.settings.SessionsDirectory, id);
    }

    private SavedSession Read(string id)
    {
        string path = Path.Combine(this.DirectoryFor(id), MetadataFile);
        using FileStream file = new(path, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
        SavedSession saved = JsonSerializer.Deserialize<SavedSession>(file, ViewerConstants.JsonOptions) ??
            throw new InvalidDataException("The saved session metadata is invalid.");
        if (saved.Session.Id != id) throw new InvalidDataException("The saved session ID does not match its directory.");
        return saved;
    }

    private SessionInfo RenameSaved(string id, string name)
    {
        SavedSession saved = this.Read(id);
        SavedSession renamed = saved with
        {
            Session = saved.Session with { Name = name },
            Status = saved.Status with { ApplicationName = name, Revision = saved.Status.Revision + 1 },
        };
        this.Write(this.DirectoryFor(id), renamed);
        return renamed.Session;
    }

    private void Write(string directory, SavedSession saved)
    {
        string pending = Path.Combine(directory, PendingMetadataFile);
        FileStreamOptions options = new() { Mode = FileMode.Create, Access = FileAccess.Write };
        if (!OperatingSystem.IsWindows()) options.UnixCreateMode = FilePermissions;
        using (FileStream file = new(pending, options)) JsonSerializer.Serialize(file, saved, ViewerConstants.JsonOptions);
        File.Move(pending, Path.Combine(directory, MetadataFile), true);
    }

    private static void MakePrivateDirectory(string path)
    {
        Directory.CreateDirectory(path);
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, DirectoryPermissions);
    }
}
