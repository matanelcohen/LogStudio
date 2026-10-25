using System;
using System.IO;
using System.Formats.Tar;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using LogStudio.Desktop;
using LogStudio.Tool;
using Xunit;

namespace LogStudio.Tests;

public sealed class ReleaseUpdaterTests
{
    [Theory]
    [InlineData("1.9.0", "1.8.1", true)]
    [InlineData("1.10.0", "1.9.0", true)]
    [InlineData("2.0.0", "1.99.99", true)]
    [InlineData("1.8.1", "1.8.1", false)]
    [InlineData("1.8.0", "1.8.1", false)]
    [InlineData("1.8.1", "1.8.1-rc.1", true)]
    [InlineData("1.8.1-rc.10", "1.8.1-rc.9", true)]
    [InlineData("1.8.1-rc.1", "1.8.1", false)]
    [InlineData("1.8.1-beta", "1.8.1-alpha.1", true)]
    [InlineData("1.8.1-rc.1", "1.8.1-rc", true)]
    [InlineData("1.8.1-rc.2", "1.8.1-rc.10", false)]
    public void ComparesSemanticVersionsNotStrings(string next, string current, bool expected) =>
        Assert.Equal(expected, ReleaseVersion.IsNewer(next, current));

    [Theory]
    [InlineData("v1.9.0")]
    [InlineData("../1.9.0")]
    [InlineData("1.9.0;touch file")]
    [InlineData("01.9.0")]
    [InlineData("1.9")]
    [InlineData("1.9.0-rc.01")]
    [InlineData("1.9.0+build")]
    public void RejectsInvalidReleaseTags(string value) => Assert.False(ReleaseVersion.TryParse(value, out _));

    [Fact]
    public async Task ChecksPublicMetadataCachesResultsAndDoesNotInstall()
    {
        using Fixture fixture = new();
        using Handler handler = new(Release());
        using HttpClient client = new(handler);
        int installs = 0;
        ReleaseUpdater updater = fixture.Updater(client, (_, _) => { installs++; return Task.CompletedTask; });
        Assert.Null(updater.State.Release);
        Assert.True(updater.State.AutomaticCheck);
        AppUpdateState state = await updater.CheckAsync(CancellationToken.None);
        Assert.True(state.UpdateAvailable);
        Assert.Equal("1.9.0", state.Release!.Version);
        Assert.Equal("## Changes\n\nA useful fix.", state.Release.Notes);
        Assert.Null(state.InstallationUnavailableReason);
        Assert.Equal("https://api.github.com/repos/matanelcohen/LogStudio/releases/latest", handler.Url);
        Assert.Contains("LogStudio/1.8.1", handler.UserAgent, StringComparison.Ordinal);
        Assert.Equal(0, installs);
        Assert.Equal(state, await updater.CheckAsync(CancellationToken.None));
        Assert.Equal(1, handler.Calls);
    }

    [Theory]
    [InlineData("1.8.1")]
    [InlineData("1.7.0")]
    public async Task DoesNotDowngradeOrReinstall(string latest)
    {
        using Fixture fixture = new();
        using HttpClient client = new(new Handler(Release(version: latest)));
        ReleaseUpdater updater = fixture.Updater(client);
        Assert.False((await updater.CheckAsync(CancellationToken.None)).UpdateAvailable);
        await Assert.ThrowsAsync<InvalidOperationException>(() => updater.InstallAsync(latest));
    }

    [Fact]
    public async Task RequiresReviewedVersionSerializesInstallationAndRetainsSuccess()
    {
        using Fixture fixture = new();
        using HttpClient client = new(new Handler(Release()));
        TaskCompletionSource completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
        int installs = 0;
        ReleaseUpdater updater = fixture.Updater(client, (installation, version) =>
        {
            installs++;
            Assert.Equal(fixture.Root, installation.InstallDirectory);
            Assert.Equal("1.9.0", version);
            return completion.Task;
        });
        await Assert.ThrowsAsync<InvalidOperationException>(() => updater.InstallAsync("1.9.0"));
        await updater.CheckAsync(CancellationToken.None);
        await Assert.ThrowsAsync<InvalidOperationException>(() => updater.InstallAsync("1.10.0"));
        Task<AppUpdateState> pending = updater.InstallAsync("1.9.0");
        Assert.Null(updater.State.InstalledVersion);
        await Assert.ThrowsAsync<InvalidOperationException>(() => updater.InstallAsync("1.9.0"));
        Task<AppUpdateState> check = updater.CheckAsync(CancellationToken.None);
        Assert.False(check.IsCompleted);
        completion.SetResult();
        AppUpdateState state = await pending;
        Assert.Equal("1.9.0", state.InstalledVersion);
        Assert.False(state.UpdateAvailable);
        Assert.Equal(state, await check);
        Assert.Equal(state, await updater.CheckAsync(CancellationToken.None));
        await Assert.ThrowsAsync<InvalidOperationException>(() => updater.InstallAsync("1.9.0"));
        Assert.Equal(1, installs);
    }

    [Fact]
    public async Task FailedInstallationIsNotReportedAsInstalledAndCanBeRetried()
    {
        using Fixture fixture = new();
        using HttpClient client = new(new Handler(Release()));
        int attempts = 0;
        ReleaseUpdater updater = fixture.Updater(client, (_, _) => ++attempts == 1
            ? Task.FromException(new IOException("Disk full."))
            : Task.CompletedTask);
        await updater.CheckAsync(CancellationToken.None);
        await Assert.ThrowsAsync<IOException>(() => updater.InstallAsync("1.9.0"));
        Assert.Null(updater.State.InstalledVersion);
        Assert.True(updater.State.UpdateAvailable);
        Assert.Equal("1.9.0", (await updater.InstallAsync("1.9.0")).InstalledVersion);
    }

    [Fact]
    public async Task UnmanagedAndEmbeddedCopiesCanReadNotesButCannotSelfInstall()
    {
        using Fixture fixture = new();
        File.Delete(Path.Combine(fixture.Payload, ReleaseUpdater.ReceiptFile));
        using HttpClient client = new(new Handler(Release()));
        foreach (UpdateApplication? application in new UpdateApplication?[] { null, UpdateApplication.Cli })
        {
            ReleaseUpdater updater = new(application, client, fixture.Payload, "1.8.1");
            Assert.Equal(application.HasValue, updater.State.AutomaticCheck);
            AppUpdateState state = await updater.CheckAsync(CancellationToken.None);
            Assert.NotNull(state.Release);
            Assert.NotNull(state.InstallationUnavailableReason);
            await Assert.ThrowsAsync<InvalidOperationException>(() => updater.InstallAsync("1.9.0"));
        }
    }

    [Fact]
    public void MovedOrCorruptReceiptDisablesInstallationWithoutBreakingTheViewer()
    {
        using Fixture fixture = new();
        string receipt = Path.Combine(fixture.Payload, ReleaseUpdater.ReceiptFile);
        File.WriteAllLines(receipt, ["1", "cli", Path.Combine(fixture.Root, "another-root"), fixture.Bin, "true"]);
        Assert.Contains("moved", fixture.Updater().State.InstallationUnavailableReason, StringComparison.Ordinal);
        File.WriteAllText(receipt, "not a receipt");
        Assert.Contains("invalid", fixture.Updater().State.InstallationUnavailableReason, StringComparison.Ordinal);
    }

    [Fact]
    public void ResolvesManagedBinDirectoryLinks()
    {
        using Fixture fixture = new();
        string link = Path.Combine(fixture.Root, "bin-link");
        Directory.CreateSymbolicLink(link, fixture.Payload);
        try
        {
            Assert.Null(new ReleaseUpdater(UpdateApplication.Cli, baseDirectory: link).State.InstallationUnavailableReason);
        }
        finally
        {
            Directory.Delete(link);
        }
    }

    [Fact]
    public void InstallerArgumentsPinVersionAndPreserveCustomPathsWithoutShellInterpolation()
    {
        UpdateInstallation installation = new(UpdateApplication.Desktop, Path.Combine(Path.GetTempPath(), "custom ' app $path"),
            Path.Combine(Path.GetTempPath(), "custom bin"), false, Path.GetTempPath());
        var start = ReleaseUpdater.CreateInstallerStartInfo(installation, "local installer", "1.9.0");
        Assert.False(start.UseShellExecute);
        Assert.Contains(installation.InstallDirectory, start.ArgumentList);
        Assert.Contains("1.9.0", start.ArgumentList);
        Assert.Contains("local installer", start.ArgumentList);
        Assert.DoesNotContain("latest", start.ArgumentList);
        Assert.DoesNotContain("-Command", start.ArgumentList);
        Assert.Contains(OperatingSystem.IsWindows() ? "-Desktop" : "--desktop", start.ArgumentList);
        Assert.Contains(OperatingSystem.IsWindows() ? "-NoLauncher" : "--no-launcher", start.ArgumentList);
        if (!OperatingSystem.IsWindows()) Assert.Contains(installation.BinDirectory, start.ArgumentList);
    }

    [Fact]
    public async Task EmbeddedInstallerPersistsAValidatedUpdateAndPreservesTheRunningPayload()
    {
        if (OperatingSystem.IsWindows()) return;
        using Fixture fixture = new();
        string downloads = Path.Combine(fixture.Root, "downloads");
        string tools = Path.Combine(fixture.Root, "tools");
        string publish = Path.Combine(fixture.Root, "new-payload");
        Directory.CreateDirectory(downloads);
        Directory.CreateDirectory(tools);
        Directory.CreateDirectory(publish);
        File.WriteAllText(Path.Combine(publish, "LogStudio.dll"), "new assembly");
        string executable = Path.Combine(publish, "logstudio");
        File.WriteAllText(executable, "#!/bin/sh\n[ \"$1\" = \"--help\" ]\n");
        File.SetUnixFileMode(executable, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        string os = OperatingSystem.IsMacOS() ? "osx" : "linux";
        string cpu = RuntimeInformation.OSArchitecture == Architecture.Arm64 ? "arm64" : "x64";
        string asset = $"logstudio-{os}-{cpu}.tar.gz";
        using (FileStream archive = File.Create(Path.Combine(downloads, asset)))
        using (GZipStream gzip = new(archive, CompressionMode.Compress))
            TarFile.CreateFromDirectory(publish, gzip, includeBaseDirectory: false);
        string hash = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(Path.Combine(downloads, asset))));
        string checksum = Path.Combine(downloads, asset + ".sha256");
        File.WriteAllText(checksum, hash + "  " + asset + "\n");
        File.WriteAllText(Path.Combine(fixture.Payload, "logstudio"), "original executable");
        File.CreateSymbolicLink(Path.Combine(fixture.Bin, "logstudio"), Path.Combine(fixture.Payload, "logstudio"));
        string curl = Path.Combine(tools, "curl");
        File.WriteAllText(curl, """
            #!/bin/sh
            while [ "$#" -gt 0 ]; do
              case "$1" in
                --output) output="$2"; shift ;;
                https://*) url="$1" ;;
              esac
              shift
            done
            case "$url" in
              https://github.com/matanelcohen/LogStudio/releases/download/1.9.0/*) ;;
              *) echo "Unexpected release URL" >&2; exit 1 ;;
            esac
            cp "$LOGSTUDIO_UPDATE_TEST_DOWNLOADS/${url##*/}" "$output"
            """);
        File.SetUnixFileMode(curl, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        string? previousPath = Environment.GetEnvironmentVariable("PATH");
        string? previousDownloads = Environment.GetEnvironmentVariable("LOGSTUDIO_UPDATE_TEST_DOWNLOADS");
        try
        {
            Environment.SetEnvironmentVariable("PATH", tools + Path.PathSeparator + previousPath);
            Environment.SetEnvironmentVariable("LOGSTUDIO_UPDATE_TEST_DOWNLOADS", downloads);
            using HttpClient client = new(new Handler(Release()));
            ReleaseUpdater updater = fixture.Updater(client);
            await updater.CheckAsync(CancellationToken.None);
            File.WriteAllText(checksum, new string('0', 64) + "  " + asset + "\n");
            await Assert.ThrowsAsync<InvalidOperationException>(() => updater.InstallAsync("1.9.0"));
            Assert.Null(updater.State.InstalledVersion);
            Assert.Equal(fixture.Payload, Path.GetDirectoryName(new FileInfo(Path.Combine(fixture.Bin, "logstudio")).ResolveLinkTarget(true)!.FullName));
            Assert.Contains("checksum verification failed", File.ReadAllText(Path.Combine(fixture.Root, "update.log")), StringComparison.Ordinal);
            File.WriteAllText(checksum, hash + "  " + asset + "\n");
            Assert.Equal("1.9.0", (await updater.InstallAsync("1.9.0")).InstalledVersion);
            string updated = Path.GetDirectoryName(new FileInfo(Path.Combine(fixture.Bin, "logstudio")).ResolveLinkTarget(true)!.FullName)!;
            Assert.NotEqual(fixture.Payload, updated);
            Assert.Equal("new assembly", File.ReadAllText(Path.Combine(updated, "LogStudio.dll")));
            Assert.Equal("original executable", File.ReadAllText(Path.Combine(fixture.Payload, "logstudio")));
            Assert.Equal(new[] { "1", "cli", fixture.Root, fixture.Bin, "false" }, File.ReadAllLines(Path.Combine(updated, ReleaseUpdater.ReceiptFile)));
            await Assert.ThrowsAsync<InvalidOperationException>(() => updater.InstallAsync("1.9.0"));
            ReleaseUpdater stale = fixture.Updater(client);
            await stale.CheckAsync(CancellationToken.None);
            InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() => stale.InstallAsync("1.9.0"));
            Assert.Contains("launcher no longer", error.Message, StringComparison.Ordinal);
        }
        finally
        {
            Environment.SetEnvironmentVariable("PATH", previousPath);
            Environment.SetEnvironmentVariable("LOGSTUDIO_UPDATE_TEST_DOWNLOADS", previousDownloads);
        }
    }

    [Fact]
    public async Task RejectsUnpublishedIncompleteOrUntrustedReleaseMetadata()
    {
        using Fixture fixture = new();
        foreach (string json in new[]
        {
            Release(draft: true), Release(prerelease: true), Release(version: "1.9.0-rc.1"),
            Release(url: "https://example.invalid"), Release(missingAsset: true),
            Release(version: "v1.9.0"), "{}", "not JSON", Release(notes: new string('x', 65537))
        })
        {
            using HttpClient client = new(new Handler(json));
            ReleaseUpdater updater = fixture.Updater(client);
            await Assert.ThrowsAsync<InvalidOperationException>(() => updater.CheckAsync(CancellationToken.None));
            Assert.Null(updater.State.Release);
            Assert.False(updater.State.UpdateAvailable);
        }
    }

    [Theory]
    [InlineData(HttpStatusCode.Forbidden)]
    [InlineData(HttpStatusCode.NotFound)]
    [InlineData(HttpStatusCode.ServiceUnavailable)]
    public async Task SurfacesGitHubFailures(HttpStatusCode status)
    {
        using Fixture fixture = new();
        using HttpClient client = new(new Handler("{}", status));
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.Updater(client).CheckAsync(CancellationToken.None));
    }

    [Fact]
    public async Task RejectsOversizedResponsesEvenWithoutAContentLength()
    {
        using Fixture fixture = new();
        using HttpClient client = new(new Handler(new string(' ', 1024 * 1024 + 1)));
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.Updater(client).CheckAsync(CancellationToken.None));
        Assert.Contains("too large", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task UpdateApiRequiresSameOriginAndExplicitActionsAndKeepsCaptureRunning()
    {
        using Fixture fixture = new();
        using Handler handler = new(Release());
        using HttpClient github = new(handler);
        int installs = 0;
        ReleaseUpdater updater = fixture.Updater(github, (_, _) => { installs++; return Task.CompletedTask; });
        await using ConsoleLogViewer viewer = ConsoleLogViewer.Start(new ConsoleLogViewerOptions { CaptureConsole = false, Updater = updater });
        using HttpClient client = new() { BaseAddress = viewer.Url };
        using HttpResponseMessage initial = await client.GetAsync(ReleaseUpdater.Route);
        Assert.Equal(HttpStatusCode.OK, initial.StatusCode);
        Assert.Equal(0, handler.Calls);
        foreach ((HttpMethod method, string? action, string? origin, string? site, HttpStatusCode expected) in new[]
        {
            (HttpMethod.Post, (string?)null, (string?)null, (string?)null, HttpStatusCode.Forbidden),
            (HttpMethod.Post, "check-update", "https://example.invalid", null, HttpStatusCode.Forbidden),
            (HttpMethod.Post, "install-update", null, "cross-site", HttpStatusCode.Forbidden),
            (HttpMethod.Delete, null, null, null, HttpStatusCode.MethodNotAllowed),
            (HttpMethod.Post, "install-update", null, null, HttpStatusCode.Conflict)
        })
        {
            using HttpRequestMessage request = new(method, ReleaseUpdater.Route + "?version=1.9.0");
            if (action is not null) request.Headers.Add(ViewerConstants.ClearRequestHeader, action);
            if (origin is not null) request.Headers.Add("Origin", origin);
            if (site is not null) request.Headers.Add("Sec-Fetch-Site", site);
            using HttpResponseMessage response = await client.SendAsync(request);
            Assert.Equal(expected, response.StatusCode);
        }
        Assert.Equal(0, handler.Calls);
        Assert.Equal(0, installs);
        using HttpRequestMessage check = new(HttpMethod.Post, ReleaseUpdater.Route);
        check.Headers.Add(ViewerConstants.ClearRequestHeader, "check-update");
        using HttpResponseMessage checkedResponse = await client.SendAsync(check);
        Assert.Equal(HttpStatusCode.OK, checkedResponse.StatusCode);
        using HttpRequestMessage install = new(HttpMethod.Post, ReleaseUpdater.Route + "?version=1.9.0");
        install.Headers.Add(ViewerConstants.ClearRequestHeader, "install-update");
        using HttpResponseMessage installed = await client.SendAsync(install);
        Assert.Equal(HttpStatusCode.OK, installed.StatusCode);
        using JsonDocument result = JsonDocument.Parse(await installed.Content.ReadAsStringAsync());
        Assert.Equal("1.9.0", result.RootElement.GetProperty("installedVersion").GetString());
        Assert.Equal(1, installs);
        viewer.Record("capture still works");
        Assert.Equal("capture still works", Assert.Single(viewer.GetLogs()).Message);
    }

    [Theory]
    [InlineData("--check-updates", false)]
    [InlineData("--update", true)]
    public void UpdateCommandsNeedNoChildOrGraphicalSession(string flag, bool install)
    {
        foreach (ToolOptions options in new[] { ToolOptions.Parse([flag]), DesktopOptions.Parse([flag]) })
        {
            Assert.True(options.CheckUpdates);
            Assert.Equal(install, options.Update);
            Assert.Empty(options.Command);
        }
        Assert.Throws<ArgumentException>(() => ToolOptions.Parse([flag, "--", "dotnet"]));
    }

    private static string Release(string version = "1.9.0", bool draft = false, bool prerelease = false,
        string? url = null, bool missingAsset = false, string notes = "## Changes\n\nA useful fix.")
    {
        string os = OperatingSystem.IsWindows() ? "win" : OperatingSystem.IsMacOS() ? "osx" : "linux";
        string cpu = RuntimeInformation.OSArchitecture == Architecture.Arm64 ? "arm64" : "x64";
        string asset = $"logstudio-{os}-{cpu}.{(OperatingSystem.IsWindows() ? "zip" : "tar.gz")}";
        return JsonSerializer.Serialize(new
        {
            tag_name = version, name = "Log Studio " + version, body = notes, draft, prerelease,
            html_url = url ?? "https://github.com/matanelcohen/LogStudio/releases/tag/" + version,
            published_at = DateTimeOffset.Parse("2026-10-24T10:00:00Z", System.Globalization.CultureInfo.InvariantCulture),
            assets = (missingAsset ? new[] { asset } : new[] { asset, asset + ".sha256" }).Select(name => new
            {
                name, browser_download_url = "https://github.com/matanelcohen/LogStudio/releases/download/" + version + "/" + name
            })
        });
    }

    private sealed class Handler(string json, HttpStatusCode status = HttpStatusCode.OK) : HttpMessageHandler
    {
        internal int Calls { get; private set; }
        internal string? Url { get; private set; }
        internal string UserAgent { get; private set; } = string.Empty;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            this.Calls++;
            this.Url = request.RequestUri!.AbsoluteUri;
            this.UserAgent = request.Headers.UserAgent.ToString();
            return Task.FromResult(new HttpResponseMessage(status) { Content = new StreamContent(new MemoryStream(Encoding.UTF8.GetBytes(json))) });
        }
    }

    private sealed class Fixture : IDisposable
    {
        internal string Root { get; } = Path.Combine(Path.GetTempPath(), "logstudio update-test " + Guid.NewGuid().ToString("N"));
        internal string Payload => Path.Combine(this.Root, "release.original");
        internal string Bin => Path.Combine(this.Root, "custom bin");

        internal Fixture()
        {
            Directory.CreateDirectory(this.Payload);
            Directory.CreateDirectory(this.Bin);
            File.WriteAllLines(Path.Combine(this.Payload, ReleaseUpdater.ReceiptFile), ["1", "cli", this.Root, this.Bin, "false"]);
        }

        internal ReleaseUpdater Updater(HttpClient? client = null, Func<UpdateInstallation, string, Task>? install = null) =>
            new(UpdateApplication.Cli, client, this.Payload, "1.8.1", install);

        public void Dispose() => Directory.Delete(this.Root, recursive: true);
    }
}
