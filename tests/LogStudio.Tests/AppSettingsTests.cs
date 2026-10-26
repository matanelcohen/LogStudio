using System;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using LogStudio.Desktop;
using Xunit;

namespace LogStudio.Tests;

public sealed class AppSettingsTests : IDisposable
{
    private readonly string directory = Path.Combine(Path.GetTempPath(), "logstudio-settings-test-" + Guid.NewGuid().ToString("N"));
    private string SettingsPath => Path.Combine(this.directory, "settings.json");
    private AppSettingsStore Store => new(this.SettingsPath);

    [Fact]
    public void DefaultSettingsDirectoryIsAbsoluteEvenBeforeItExists()
    {
        Assert.True(Path.IsPathFullyQualified(AppSettingsStore.DefaultDirectory));
        Assert.EndsWith(Path.DirectorySeparatorChar + "LogStudio", AppSettingsStore.DefaultDirectory, StringComparison.Ordinal);
    }

    [Fact]
    public void MissingSettingsDoNotCreateFilesUntilSomethingChanges()
    {
        Assert.Null(this.Store.Read().Preferences);
        Assert.Null(this.Store.Read().Window);
        Assert.False(Directory.Exists(this.directory));
    }

    [Fact]
    public void SettingsPersistAcrossStoreInstancesAndUpdatesPreserveUnchangedFields()
    {
        this.Save("""{"appearance":"monokai","typography":{"uiFont":"verdana","logFontSize":24},"explorer":{"wrap":false,"pageSize":500}}""");
        this.Store.SaveWindow(new(1200, 700, true));
        this.Save("""{"typography":{"uiFontSize":18}}""");
        AppSettingsDocument saved = this.Store.Read();
        Assert.Equal("monokai", saved.Preferences!.Appearance);
        Assert.Equal("verdana", saved.Preferences.Typography.UiFont);
        Assert.Equal(18, saved.Preferences.Typography.UiFontSize);
        Assert.Equal(24, saved.Preferences.Typography.LogFontSize);
        Assert.False(saved.Preferences.Explorer.Wrap);
        Assert.Equal(500, saved.Preferences.Explorer.PageSize);
        Assert.Equal(new DesktopWindowSettings(1200, 700, true), saved.Window);
        Assert.Empty(Directory.GetFiles(this.directory, "*.pending"));
        if (!OperatingSystem.IsWindows())
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(this.SettingsPath));
    }

    [Fact]
    public async Task ConcurrentStoresMergePreferencesAndWindowWithoutLostUpdates()
    {
        await Task.WhenAll(
            Task.Run(() => this.Save("""{"appearance":"dark-modern"}""")),
            Task.Run(() => this.Save("""{"typography":{"logFontSize":22}}""")),
            Task.Run(() => this.Save("""{"explorer":{"timeline":true}}""")),
            Task.Run(() => this.Store.SaveWindow(new(1000, 650, false))));
        AppSettingsDocument saved = this.Store.Read();
        Assert.Equal("dark-modern", saved.Preferences!.Appearance);
        Assert.Equal(22, saved.Preferences.Typography.LogFontSize);
        Assert.True(saved.Preferences.Explorer.Timeline);
        Assert.Equal(new DesktopWindowSettings(1000, 650, false), saved.Window);
    }

    [Fact]
    public void OnboardingDismissalDefaultsOffAndPersistsWithoutChangingOtherPreferences()
    {
        this.Save("""{"appearance":"monokai","explorer":{"pageSize":500}}""");
        Assert.False(this.Store.Read().Preferences!.OnboardingDismissed);
        this.Save("""{"onboardingDismissed":true}""");
        this.Save("""{"typography":{"uiFontSize":18}}""");
        AppPreferences saved = this.Store.Read().Preferences!;
        Assert.True(saved.OnboardingDismissed);
        Assert.Equal("monokai", saved.Appearance);
        Assert.Equal(500, saved.Explorer.PageSize);
    }

    [Fact]
    public void NamedSearchesPersistAcrossRestartsAndPreserveOtherPreferences()
    {
        SessionFilters filters = SessionFiltersTests.Filters() with { TimeWindow = 0, Until = "2026-10-11T18:00:00Z" };
        this.Save(JsonSerializer.Serialize(new { savedSearches = new[] { new SavedSearch("Errors", filters) } }, ViewerConstants.JsonOptions));
        this.Save("""{"appearance":"dark-modern"}""");
        SavedSearch search = Assert.Single(this.Store.Read().Preferences!.SavedSearches);
        Assert.Equal("Errors", search.Name);
        SessionFiltersTests.AssertFilters(filters, search.Filters);
        this.Save("""{"savedSearches":[]}""");
        Assert.Empty(this.Store.Read().Preferences!.SavedSearches);
        Assert.Equal("dark-modern", this.Store.Read().Preferences!.Appearance);
    }

    [Fact]
    public void SavedSearchValidationAndStorageLimitsNeverReplaceValidSettings()
    {
        this.Save("""{"appearance":"dark"}""");
        string before = File.ReadAllText(this.SettingsPath);
        SavedSearch valid = new("Errors", SessionFiltersTests.Filters());
        foreach (SavedSearch[] searches in new[]
        {
            new[] { valid, valid with { Name = "errors" } },
            new[] { valid with { Name = " " } },
            new[] { valid with { Name = new string('x', 65) } },
            new[] { valid with { Name = "name\n" } },
            new[] { valid with { Filters = valid.Filters with { Search = "\"unfinished" } } },
            Enumerable.Range(0, 11).Select(index => valid with { Name = "Search " + index }).ToArray(),
        })
        {
            Assert.Throws<ArgumentException>(() => this.Save(JsonSerializer.Serialize(new { savedSearches = searches }, ViewerConstants.JsonOptions)));
            Assert.Equal(before, File.ReadAllText(this.SettingsPath));
        }
        SessionFilters large = valid.Filters with
        {
            Search = new string('x', 1024),
            Conditions = Enumerable.Range(0, 10).Select(_ => new LogCondition("include", "message", "contains", new string('x', 256))).ToArray(),
        };
        SavedSearch[] oversized = Enumerable.Range(0, 10).Select(index => new SavedSearch("Search " + index, large)).ToArray();
        Assert.Throws<ArgumentException>(() => this.Save(JsonSerializer.Serialize(new { savedSearches = oversized }, ViewerConstants.JsonOptions)));
        Assert.Equal(before, File.ReadAllText(this.SettingsPath));
        Assert.Empty(Directory.GetFiles(this.directory, "*.pending"));
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("null")]
    [InlineData("""{"appearance":"invalid"}""")]
    [InlineData("""{"onboardingDismissed":"true"}""")]
    [InlineData("""{"onboardingDismissed":null}""")]
    [InlineData("""{"appearance":"light","appearance":"dark"}""")]
    [InlineData("""{"typography":null}""")]
    [InlineData("""{"typography":{"logFontSize":25}}""")]
    [InlineData("""{"typography":{"logFontSize":14.5}}""")]
    [InlineData("""{"typography":{"uiFont":"url(https://example.com/font)"}}""")]
    [InlineData("""{"typography":{"logLineHeight":1.5}}""")]
    [InlineData("""{"typography":{"unknown":true}}""")]
    [InlineData("""{"explorer":{"pageSize":0}}""")]
    [InlineData("""{"explorer":{"wrap":"true"}}""")]
    [InlineData("""{"explorer":{"wrap":false,"wrap":true}}""")]
    [InlineData("""{"explorer":{"columnOrder":["message"]}}""")]
    [InlineData("""{"explorer":{"columnVisibility":{"message":false}}}""")]
    [InlineData("""{"explorer":{"columnSizing":{"unknown":100}}}""")]
    [InlineData("""{"explorer":{"columnSizing":{"category":4001}}}""")]
    [InlineData("""{"window":{"width":1000,"height":700}}""")]
    public void InvalidPreferencesNeverReplaceSavedSettings(string json)
    {
        this.Save("""{"appearance":"dark"}""");
        string previous = File.ReadAllText(this.SettingsPath);
        Assert.Throws<ArgumentException>(() => this.Save(json));
        Assert.Equal(previous, File.ReadAllText(this.SettingsPath));
    }

    [Theory]
    [InlineData("{broken")]
    [InlineData("""{"version":99}""")]
    [InlineData("""{"version":1,"preferences":{"typography":{"logFontSize":999}}}""")]
    public void CorruptOrUnsupportedFilesAreReportedAndPreserved(string json)
    {
        Directory.CreateDirectory(this.directory);
        File.WriteAllText(this.SettingsPath, json);
        Assert.Throws<InvalidDataException>(() => this.Store.Read());
        Assert.Throws<InvalidDataException>(() => this.Save("""{"appearance":"light"}"""));
        Assert.Equal(json, File.ReadAllText(this.SettingsPath));
    }

    [Fact]
    public void WindowPreferencesKeepNormalSizeWhileMaximizedOrMinimizedAndFlushOnClose()
    {
        this.Save("""{"appearance":"monokai"}""");
        using (DesktopWindowPreferences preferences = new(this.Store, TextWriter.Null))
        {
            preferences.Initialize(new Size(1280, 800));
            preferences.Update(new Size(1100, 650), maximized: false, minimized: false);
            preferences.Update(new Size(1920, 1080), maximized: true, minimized: false);
            preferences.Update(new Size(1, 1), maximized: false, minimized: true);
        }
        Assert.Equal(new DesktopWindowSettings(1100, 650, true), this.Store.Read().Window);
        Assert.Equal("monokai", this.Store.Read().Preferences!.Appearance);
        using DesktopWindowPreferences restored = new(this.Store, TextWriter.Null);
        Assert.Equal(new DesktopWindowSettings(1100, 650, true), restored.Saved);
        restored.Initialize(new Size(1100, 650));
        restored.Update(new Size(1000, 600), maximized: false, minimized: false);
        restored.Flush();
        Assert.Equal(new DesktopWindowSettings(1000, 600, false), this.Store.Read().Window);
    }

    [Fact]
    public async Task WindowResizingAutosavesWithoutWaitingForClose()
    {
        using DesktopWindowPreferences preferences = new(this.Store, TextWriter.Null);
        preferences.Initialize(new Size(1280, 800));
        preferences.Update(new Size(1050, 620), maximized: false, minimized: false);
        for (int attempt = 0; attempt < 100 && this.Store.Read().Window is null; attempt++)
            await Task.Delay(20);
        Assert.Equal(new DesktopWindowSettings(1050, 620, false), this.Store.Read().Window);
    }

    [Fact]
    public void WindowStorageFailuresAreDiagnosedWithoutBreakingShutdown()
    {
        Directory.CreateDirectory(this.directory);
        File.WriteAllText(this.SettingsPath, "{broken");
        using StringWriter diagnostics = new();
        using (DesktopWindowPreferences preferences = new(this.Store, diagnostics))
        {
            preferences.Initialize(new Size(1000, 650));
            preferences.Flush();
        }
        Assert.Contains("Could not restore", diagnostics.ToString(), StringComparison.Ordinal);
        Assert.Contains("Could not autosave", diagnostics.ToString(), StringComparison.Ordinal);
        Assert.Equal("{broken", File.ReadAllText(this.SettingsPath));
    }

    [Fact]
    public async Task PreferencesSurviveRestartAndAreSharedAcrossDifferentPorts()
    {
        await using ConsoleLogViewer first = this.StartViewer();
        await using ConsoleLogViewer second = this.StartViewer();
        Assert.NotEqual(first.Url.Port, second.Url.Port);
        using HttpClient client = new();
        using HttpResponseMessage saved = await client.SendAsync(Request(first.Url, """{"appearance":"monokai","typography":{"logFontSize":20},"explorer":{"pageSize":1000}}"""));
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
        await first.DisposeAsync();
        using JsonDocument settings = JsonDocument.Parse(await client.GetStringAsync(new Uri(second.Url, "api/settings")));
        Assert.True(settings.RootElement.GetProperty("hasPreferences").GetBoolean());
        JsonElement preferences = settings.RootElement.GetProperty("preferences");
        Assert.Equal("monokai", preferences.GetProperty("appearance").GetString());
        Assert.Equal(20, preferences.GetProperty("typography").GetProperty("logFontSize").GetInt32());
        Assert.Equal(1000, preferences.GetProperty("explorer").GetProperty("pageSize").GetInt32());
        await using ConsoleLogViewer restarted = this.StartViewer();
        Assert.Equal(settings.RootElement.GetRawText(), await client.GetStringAsync(new Uri(restarted.Url, "api/settings")));
    }

    [Fact]
    public async Task SettingsApiProtectsMutationsAndRejectsInvalidRequests()
    {
        await using ConsoleLogViewer viewer = this.StartViewer();
        using HttpClient client = new();
        using HttpRequestMessage missingAction = Request(viewer.Url, """{"appearance":"dark"}""");
        missingAction.Headers.Remove(ViewerConstants.ClearRequestHeader);
        using HttpResponseMessage forbidden = await client.SendAsync(missingAction);
        Assert.Equal(HttpStatusCode.Forbidden, forbidden.StatusCode);
        using HttpRequestMessage crossOrigin = Request(viewer.Url, """{"appearance":"dark"}""");
        crossOrigin.Headers.Add("Origin", "https://example.invalid");
        using HttpResponseMessage denied = await client.SendAsync(crossOrigin);
        Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        using HttpResponseMessage method = await client.PutAsync(new Uri(viewer.Url, "api/settings"), null);
        Assert.Equal(HttpStatusCode.MethodNotAllowed, method.StatusCode);
        using HttpResponseMessage invalid = await client.SendAsync(Request(viewer.Url, """{"typography":{"logFontSize":999}}"""));
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        using HttpResponseMessage oversized = await client.SendAsync(Request(viewer.Url, new string(' ', AppSettingsStore.MaximumBytes + 1)));
        Assert.Equal(HttpStatusCode.BadRequest, oversized.StatusCode);
        using HttpRequestMessage wrongType = Request(viewer.Url, "{}");
        wrongType.Content = new StringContent("{}");
        using HttpResponseMessage unsupported = await client.SendAsync(wrongType);
        Assert.Equal(HttpStatusCode.UnsupportedMediaType, unsupported.StatusCode);
        Assert.False(File.Exists(this.SettingsPath));
    }

    [Fact]
    public async Task SettingsApiReportsUnreadableSettingsExplicitly()
    {
        Directory.CreateDirectory(this.directory);
        File.WriteAllText(this.SettingsPath, "{broken");
        await using ConsoleLogViewer viewer = this.StartViewer();
        using HttpClient client = new();
        using HttpResponseMessage response = await client.GetAsync(new Uri(viewer.Url, "api/settings"));
        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        Assert.Contains("settings.json", await response.Content.ReadAsStringAsync(), StringComparison.Ordinal);
    }

    private AppPreferences Save(string json)
    {
        using JsonDocument body = JsonDocument.Parse(json);
        return this.Store.SavePreferences(body.RootElement);
    }

    private ConsoleLogViewer StartViewer() => ConsoleLogViewer.Start(new()
    {
        Port = 0,
        CaptureConsole = false,
        ApplicationName = "settings-test",
        AppSettings = this.Store,
    });

    private static HttpRequestMessage Request(Uri url, string json)
    {
        HttpRequestMessage request = new(HttpMethod.Post, new Uri(url, "api/settings"))
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        };
        request.Headers.Add(ViewerConstants.ClearRequestHeader, "save-settings");
        return request;
    }

    public void Dispose()
    {
        if (Directory.Exists(this.directory)) Directory.Delete(this.directory, recursive: true);
    }
}
