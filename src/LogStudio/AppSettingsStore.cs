using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Threading;

namespace LogStudio;

internal sealed record TypographyPreferences
{
    public string UiFont { get; init; } = "system";
    public int UiFontSize { get; init; } = 14;
    public string LogFont { get; init; } = "default";
    public int LogFontSize { get; init; } = 14;
    public double LogLineHeight { get; init; } = 1.6;

    internal void Validate()
    {
        if (this.UiFont is not ("system" or "arial" or "verdana" or "serif") || this.UiFontSize is < 12 or > 18 ||
            this.LogFont is not ("default" or "system" or "menlo" or "courier") || this.LogFontSize is < 10 or > 24 ||
            this.LogLineHeight is not (1.3 or 1.6 or 2))
            throw new ArgumentException("Choose a supported font, font size and line spacing.");
    }
}

internal sealed record ExplorerPreferences
{
    internal static readonly string[] Columns = ["id", "timestamp", "severity", "stream", "category", "message"];
    public bool Wrap { get; init; } = true;
    public int PageSize { get; init; } = ViewerConstants.PageSize;
    public bool Fields { get; init; }
    public bool Inspector { get; init; }
    public bool Timeline { get; init; }
    public string[] ColumnOrder { get; init; } = [.. Columns];
    public Dictionary<string, bool> ColumnVisibility { get; init; } = new() { ["id"] = false, ["stream"] = false };
    public Dictionary<string, double> ColumnSizing { get; init; } = new();

    internal void Validate()
    {
        if (this.PageSize < 1 || this.ColumnOrder is null || this.ColumnVisibility is null || this.ColumnSizing is null ||
            this.ColumnOrder.Length != Columns.Length || this.ColumnOrder.Distinct(StringComparer.Ordinal).Count() != Columns.Length ||
            this.ColumnOrder.Any(column => !Columns.Contains(column, StringComparer.Ordinal)) ||
            this.ColumnVisibility.Any(pair => !Columns.Contains(pair.Key, StringComparer.Ordinal) || (pair.Key == "message" && !pair.Value)) ||
            this.ColumnSizing.Any(pair => !Columns.Contains(pair.Key, StringComparer.Ordinal) || !double.IsFinite(pair.Value) || pair.Value is < 44 or > 4000))
            throw new ArgumentException("Explorer preferences must contain a positive page size and a valid column layout.");
    }
}

internal sealed record AppPreferences
{
    internal static readonly string[] Appearances = [
        "system", "light", "dark", "light-2026", "dark-2026", "light-modern", "dark-modern", "light-plus", "dark-plus",
        "visual-studio-light", "visual-studio-dark", "light-high-contrast", "dark-high-contrast", "abyss", "kimbie-dark",
        "monokai", "monokai-dimmed", "quiet-light", "red", "solarized-light", "solarized-dark", "tomorrow-night-blue"
    ];
    public string Appearance { get; init; } = "system";
    public TypographyPreferences Typography { get; init; } = new();
    public ExplorerPreferences Explorer { get; init; } = new();

    internal void Validate()
    {
        if (!Appearances.Contains(this.Appearance, StringComparer.Ordinal) || this.Typography is null || this.Explorer is null)
            throw new ArgumentException("Choose a supported appearance and valid preferences.");
        this.Typography.Validate();
        this.Explorer.Validate();
    }
}

internal sealed record DesktopWindowSettings(int Width, int Height, bool Maximized)
{
    internal void Validate()
    {
        if (this.Width is < 1 or > 32768 || this.Height is < 1 or > 32768)
            throw new ArgumentException("Saved window dimensions must be between 1 and 32768 pixels.");
    }
}

internal sealed record AppSettingsDocument
{
    public int Version { get; init; } = 1;
    public AppPreferences? Preferences { get; init; }
    public DesktopWindowSettings? Window { get; init; }
}

internal sealed class AppSettingsStore
{
    internal const int MaximumBytes = 32768;
    private const UnixFileMode FilePermissions = UnixFileMode.UserRead | UnixFileMode.UserWrite;
    private static readonly ConcurrentDictionary<string, object> Gates = new(OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal);
    private static readonly JsonSerializerOptions JsonOptions = new(ViewerConstants.JsonOptions)
    {
        PropertyNameCaseInsensitive = false,
        NumberHandling = JsonNumberHandling.Strict,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        MaxDepth = 8,
    };
    private readonly string path;
    private readonly object gate;

    internal static string DefaultDirectory
    {
        get
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData, Environment.SpecialFolderOption.DoNotVerify);
            if (string.IsNullOrEmpty(local)) throw new InvalidOperationException("The local application data directory is unavailable.");
            return Path.Combine(local, "LogStudio");
        }
    }

    internal AppSettingsStore(string? path = null)
    {
        this.path = Path.GetFullPath(path ?? Path.Combine(DefaultDirectory, "settings.json"));
        this.gate = Gates.GetOrAdd(this.path, _ => new object());
    }

    internal AppSettingsDocument Read()
    {
        lock (this.gate) return this.ReadFile();
    }

    internal AppPreferences SavePreferences(JsonElement patch)
    {
        if (patch.ValueKind != JsonValueKind.Object) throw new ArgumentException("A settings object is required.");
        HashSet<string> seen = new(StringComparer.Ordinal);
        foreach (JsonProperty property in patch.EnumerateObject())
        {
            if (property.Name is not ("appearance" or "typography" or "explorer") ||
                property.Value.ValueKind == JsonValueKind.Null || !seen.Add(property.Name))
                throw new ArgumentException("Settings must contain appearance, typography or explorer preferences without duplicates.");
        }
        if (seen.Count == 0) throw new ArgumentException("Choose at least one setting to save.");
        return this.Update(current =>
        {
            JsonObject merged = JsonSerializer.SerializeToNode(current.Preferences ?? new AppPreferences(), JsonOptions)!.AsObject();
            foreach (JsonProperty property in patch.EnumerateObject())
            {
                if (property.Name is "typography" or "explorer" && property.Value.ValueKind == JsonValueKind.Object)
                {
                    HashSet<string> fields = new(StringComparer.Ordinal);
                    foreach (JsonProperty field in property.Value.EnumerateObject())
                    {
                        if (!fields.Add(field.Name)) throw new ArgumentException("Settings must not contain duplicate properties.");
                        merged[property.Name]![field.Name] = JsonNode.Parse(field.Value.GetRawText());
                    }
                }
                else merged[property.Name] = JsonNode.Parse(property.Value.GetRawText());
            }
            AppPreferences preferences;
            try
            {
                preferences = merged.Deserialize<AppPreferences>(JsonOptions)!;
            }
            catch (JsonException exception)
            {
                throw new ArgumentException("Settings must contain supported properties and valid types.", exception);
            }
            preferences.Validate();
            return current with { Preferences = preferences };
        }).Preferences!;
    }

    internal void SaveWindow(DesktopWindowSettings window)
    {
        window.Validate();
        this.Update(current => current with { Window = window });
    }

    private AppSettingsDocument ReadFile()
    {
        try
        {
            using FileStream file = new(this.path, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
            if (file.Length > MaximumBytes) throw new InvalidDataException("The settings file is too large.");
            AppSettingsDocument document = JsonSerializer.Deserialize<AppSettingsDocument>(file, JsonOptions) ??
                throw new InvalidDataException("The settings file is empty.");
            if (document.Version != 1) throw new InvalidDataException("The settings file version is unsupported.");
            document.Preferences?.Validate();
            document.Window?.Validate();
            return document;
        }
        catch (Exception exception) when (exception is FileNotFoundException or DirectoryNotFoundException)
        {
            return new();
        }
        catch (Exception exception) when (exception is JsonException or ArgumentException)
        {
            throw new InvalidDataException("The settings file is invalid. Repair or remove it to save preferences again.", exception);
        }
    }

    private AppSettingsDocument Update(Func<AppSettingsDocument, AppSettingsDocument> change)
    {
        lock (this.gate)
        {
            string directory = Path.GetDirectoryName(this.path)!;
            if (OperatingSystem.IsWindows()) Directory.CreateDirectory(directory);
            else Directory.CreateDirectory(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            using FileStream fileLock = this.AcquireFileLock();
            AppSettingsDocument updated = change(this.ReadFile());
            string pending = this.path + "." + Guid.NewGuid().ToString("N") + ".pending";
            try
            {
                FileStreamOptions options = new() { Mode = FileMode.CreateNew, Access = FileAccess.Write };
                if (!OperatingSystem.IsWindows()) options.UnixCreateMode = FilePermissions;
                using (FileStream file = new(pending, options))
                {
                    JsonSerializer.Serialize(file, updated, JsonOptions);
                    file.Flush(flushToDisk: true);
                }
                File.Move(pending, this.path, overwrite: true);
            }
            finally
            {
                File.Delete(pending);
            }
            return updated;
        }
    }

    private FileStream AcquireFileLock()
    {
        Stopwatch elapsed = Stopwatch.StartNew();
        while (true)
        {
            try
            {
                FileStreamOptions options = new() { Mode = FileMode.OpenOrCreate, Access = FileAccess.ReadWrite, Share = FileShare.None };
                if (!OperatingSystem.IsWindows()) options.UnixCreateMode = FilePermissions;
                return new FileStream(this.path + ".lock", options);
            }
            catch (IOException) when (elapsed.Elapsed < TimeSpan.FromSeconds(2))
            {
                // Other Log Studio processes share the same per-user settings file.
                Thread.Sleep(20);
            }
        }
    }
}
