using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace LogStudio;

internal enum UpdateApplication { Cli, Desktop }

internal sealed record AppRelease(string Version, string Name, string Notes, string Url, DateTimeOffset PublishedAt);
internal sealed record AppUpdateState(string CurrentVersion, bool AutomaticCheck, AppRelease? Release,
    bool UpdateAvailable, string? InstallationUnavailableReason, string? InstalledVersion);

internal sealed class ReleaseUpdater
{
    internal const string Route = "api/app-update";
    internal const string ReceiptFile = "logstudio-install.txt";
    private const string Repository = "https://github.com/matanelcohen/LogStudio";
    private const int MaximumResponseBytes = 1024 * 1024;
    private static readonly HttpClient Client = new(new HttpClientHandler { AutomaticDecompression = DecompressionMethods.All })
    {
        Timeout = TimeSpan.FromSeconds(30),
        MaxResponseContentBufferSize = MaximumResponseBytes,
    };
    private readonly HttpClient client;
    private readonly SemaphoreSlim gate = new(1);
    private readonly UpdateInstallation? installation;
    private readonly Func<UpdateInstallation, string, Task> install;
    private readonly string? rid;
    private AppUpdateState state;
    private DateTimeOffset lastCheck;

    internal ReleaseUpdater(UpdateApplication? application, HttpClient? client = null, string? baseDirectory = null,
        string? currentVersion = null, Func<UpdateInstallation, string, Task>? install = null)
    {
        this.client = client ?? Client;
        this.install = install ?? RunInstallerAsync;
        this.rid = GetRuntimeIdentifier();
        string? reason = "This copy is not managed by the release installer. Rerun install-release for a compiled install, update your dotnet tool, or rebuild from source.";
        if (application.HasValue)
        {
            try
            {
                this.installation = UpdateInstallation.Read(baseDirectory ?? AppContext.BaseDirectory, application.Value, out reason);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or InvalidOperationException or ArgumentException)
            {
                reason = "Could not read this installation's update settings: " + exception.Message;
            }
        }
        if (this.rid is null)
            reason = "Compiled updates support Windows, macOS and glibc Linux on x64 and ARM64 only.";
        this.state = new AppUpdateState(currentVersion ?? typeof(ReleaseUpdater).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()!.InformationalVersion.Split('+')[0],
            application.HasValue, null, false, reason, null);
    }

    internal AppUpdateState State => Volatile.Read(ref this.state);

    internal async Task<AppUpdateState> CheckAsync(CancellationToken cancellationToken)
    {
        await this.gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (this.state.InstalledVersion is not null) return this.state;
            if (this.state.Release is not null && DateTimeOffset.UtcNow - this.lastCheck < TimeSpan.FromMinutes(1))
                return this.state;
            using HttpRequestMessage request = new(HttpMethod.Get, "https://api.github.com/repos/matanelcohen/LogStudio/releases/latest");
            request.Headers.UserAgent.ParseAdd("LogStudio/" + this.state.CurrentVersion);
            request.Headers.Accept.ParseAdd("application/vnd.github+json");
            using CancellationTokenSource timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(30));
            using HttpResponseMessage response = await this.client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token).ConfigureAwait(false);
            if (response.StatusCode == HttpStatusCode.NotFound)
                throw new InvalidOperationException("No published stable release is available yet.");
            if (!response.IsSuccessStatusCode)
                throw new InvalidOperationException($"GitHub returned HTTP {(int)response.StatusCode}. Check your connection or API rate limit and retry.");
            if (response.Content.Headers.ContentLength > MaximumResponseBytes)
                throw new InvalidOperationException("The release response is too large.");
            using Stream stream = await response.Content.ReadAsStreamAsync(timeout.Token).ConfigureAwait(false);
            using MemoryStream bytes = new();
            byte[] buffer = new byte[8192];
            int count;
            while ((count = await stream.ReadAsync(buffer, timeout.Token).ConfigureAwait(false)) != 0)
            {
                if (bytes.Length + count > MaximumResponseBytes)
                    throw new InvalidOperationException("The release response is too large.");
                bytes.Write(buffer, 0, count);
            }
            using JsonDocument document = JsonDocument.Parse(bytes.ToArray(), new JsonDocumentOptions { MaxDepth = 16 });
            JsonElement data = document.RootElement;
            string version = data.GetProperty("tag_name").GetString() ?? string.Empty;
            if (!ReleaseVersion.TryParse(version, out ReleaseVersion parsed) || parsed.Prerelease.Length != 0 ||
                data.GetProperty("draft").GetBoolean() || data.GetProperty("prerelease").GetBoolean())
                throw new InvalidOperationException("GitHub did not return a valid stable release.");
            string url = Repository + "/releases/tag/" + version;
            if (data.GetProperty("html_url").GetString() != url)
                throw new InvalidOperationException("The release URL does not belong to Log Studio.");
            string notes = data.GetProperty("body").ValueKind == JsonValueKind.Null ? string.Empty : data.GetProperty("body").GetString() ?? string.Empty;
            if (notes.Length > 65536) throw new InvalidOperationException("The release notes are too large.");
            AppRelease release = new(version, data.GetProperty("name").GetString() ?? version, notes, url,
                data.GetProperty("published_at").GetDateTimeOffset());
            string? reason = this.state.InstallationUnavailableReason;
            if (reason is null)
            {
                string asset = $"logstudio{(this.installation!.Application == UpdateApplication.Desktop ? "-desktop" : "")}-{this.rid}.{(OperatingSystem.IsWindows() ? "zip" : "tar.gz")}";
                foreach (string name in new[] { asset, asset + ".sha256" })
                {
                    if (!data.GetProperty("assets").EnumerateArray().Any(item =>
                        item.GetProperty("name").GetString() == name &&
                        item.GetProperty("browser_download_url").GetString() == Repository + "/releases/download/" + version + "/" + name))
                        throw new InvalidOperationException("This release does not yet contain the archive and checksum for this installation. Retry after publishing finishes.");
                }
            }
            this.state = this.state with { Release = release, UpdateAvailable = ReleaseVersion.IsNewer(version, this.state.CurrentVersion) };
            this.lastCheck = DateTimeOffset.UtcNow;
            return this.state;
        }
        catch (OperationCanceledException exception) when (!cancellationToken.IsCancellationRequested)
        {
            throw new InvalidOperationException("The update check timed out. Check your connection and retry.", exception);
        }
        catch (Exception exception) when (exception is JsonException or KeyNotFoundException or FormatException)
        {
            throw new InvalidOperationException("GitHub returned invalid release metadata.", exception);
        }
        finally
        {
            this.gate.Release();
        }
    }

    internal async Task<AppUpdateState> InstallAsync(string version)
    {
        if (!this.gate.Wait(0)) throw new InvalidOperationException("An update operation is already running.");
        try
        {
            if (this.state.InstallationUnavailableReason is not null)
                throw new InvalidOperationException(this.state.InstallationUnavailableReason);
            if (this.state.InstalledVersion is not null)
                throw new InvalidOperationException("An update is already installed. Close and relaunch Log Studio.");
            if (!this.state.UpdateAvailable || this.state.Release?.Version != version)
                throw new InvalidOperationException("Check for updates and review the selected release before installing it.");
            // The installer switches launchers, never the running payload. Finish even if the viewer closes.
            await this.install(this.installation!, version).ConfigureAwait(false);
            this.state = this.state with { InstalledVersion = version, UpdateAvailable = false };
            return this.state;
        }
        finally
        {
            this.gate.Release();
        }
    }

    private static string? GetRuntimeIdentifier()
    {
        string? os = OperatingSystem.IsWindows() ? "win" : OperatingSystem.IsMacOS() ? "osx" :
            OperatingSystem.IsLinux() && !RuntimeInformation.RuntimeIdentifier.Contains("musl", StringComparison.Ordinal) ? "linux" : null;
        string? cpu = RuntimeInformation.OSArchitecture switch { Architecture.X64 => "x64", Architecture.Arm64 => "arm64", _ => null };
        return os is not null && cpu is not null ? os + "-" + cpu : null;
    }

    internal static ProcessStartInfo CreateInstallerStartInfo(UpdateInstallation installation, string script, string version)
    {
        bool windows = OperatingSystem.IsWindows();
        ProcessStartInfo start = new(windows
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe")
            : "/bin/bash")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        if (windows)
            foreach (string argument in new[] { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File" })
                start.ArgumentList.Add(argument);
        start.ArgumentList.Add(script);
        start.ArgumentList.Add(windows
            ? installation.Application == UpdateApplication.Desktop ? "-Desktop" : "-Cli"
            : installation.Application == UpdateApplication.Desktop ? "--desktop" : "--cli");
        start.ArgumentList.Add(windows ? "-Version" : "--version");
        start.ArgumentList.Add(version);
        start.ArgumentList.Add(windows ? "-InstallDir" : "--install-dir");
        start.ArgumentList.Add(installation.InstallDirectory);
        if (!windows)
        {
            start.ArgumentList.Add("--bin-dir");
            start.ArgumentList.Add(installation.BinDirectory);
        }
        if (!installation.CreateLauncher) start.ArgumentList.Add(windows ? "-NoLauncher" : "--no-launcher");
        return start;
    }

    private static async Task RunInstallerAsync(UpdateInstallation installation, string version)
    {
        using FileStream operation = new(Path.Combine(installation.InstallDirectory, "update.lock"), FileMode.OpenOrCreate,
            FileAccess.ReadWrite, FileShare.None);
        installation.EnsureCurrentLauncher();
        string directory = Path.Combine(Path.GetTempPath(), "logstudio-update-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        string script = Path.Combine(directory, OperatingSystem.IsWindows() ? "install-release.ps1" : "install-release.sh");
        try
        {
            using (Stream source = typeof(ReleaseUpdater).Assembly.GetManifestResourceStream("LogStudio.Update." + Path.GetFileName(script))!)
            using (FileStream target = File.Create(script))
                await source.CopyToAsync(target).ConfigureAwait(false);
            using Process process = new() { StartInfo = CreateInstallerStartInfo(installation, script, version) };
            string log = Path.Combine(installation.InstallDirectory, "update.log");
            try
            {
                if (!process.Start()) throw new InvalidOperationException("The release installer did not start.");
            }
            catch (Win32Exception exception)
            {
                throw new InvalidOperationException("Could not start the release installer. Check that Bash or Windows PowerShell is available.", exception);
            }
            Task<string> stdout = ReadInstallerOutputAsync(process.StandardOutput);
            Task<string> stderr = ReadInstallerOutputAsync(process.StandardError);
            await process.WaitForExitAsync().ConfigureAwait(false);
            await Task.WhenAll(stdout, stderr).ConfigureAwait(false);
            await File.WriteAllTextAsync(log, stdout.Result + Environment.NewLine + stderr.Result).ConfigureAwait(false);
            if (process.ExitCode != 0)
                throw new InvalidOperationException($"The release installer failed (exit {process.ExitCode}). See {log}. Your running version is unchanged.");
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static async Task<string> ReadInstallerOutputAsync(StreamReader reader)
    {
        const int maximumCharacters = 65536;
        StringBuilder tail = new();
        char[] buffer = new char[4096];
        int count;
        while ((count = await reader.ReadAsync(buffer).ConfigureAwait(false)) != 0)
        {
            tail.Append(buffer, 0, count);
            if (tail.Length > maximumCharacters) tail.Remove(0, tail.Length - maximumCharacters);
        }
        return tail.ToString();
    }
}

internal sealed record UpdateInstallation(UpdateApplication Application, string InstallDirectory, string BinDirectory, bool CreateLauncher, string PayloadDirectory)
{
    internal void EnsureCurrentLauncher()
    {
        bool desktop = this.Application == UpdateApplication.Desktop;
        FileSystemInfo? link = OperatingSystem.IsWindows()
            ? new DirectoryInfo(Path.Combine(this.InstallDirectory, desktop ? "desktop-bin" : "bin")).ResolveLinkTarget(returnFinalTarget: true)
            : new FileInfo(Path.Combine(this.BinDirectory, desktop ? "logstudio-desktop" : "logstudio")).ResolveLinkTarget(returnFinalTarget: true);
        string? target = link is null ? null : OperatingSystem.IsWindows() ? link.FullName : Path.GetDirectoryName(link.FullName);
        if (!string.Equals(target, this.PayloadDirectory, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
            throw new InvalidOperationException("The launcher no longer points to this running copy. Close and relaunch Log Studio, or rerun the release installer, before updating.");
    }

    internal static UpdateInstallation? Read(string baseDirectory, UpdateApplication application, out string? reason)
    {
        reason = "This copy is not managed by the release installer. Rerun install-release for a compiled install, update your dotnet tool, or rebuild from source.";
        string receipt = Path.Combine(baseDirectory, ReleaseUpdater.ReceiptFile);
        if (!File.Exists(receipt)) return null;
        string[] lines = File.ReadAllLines(receipt);
        if (lines.Length != 5 || lines[0] != "1" || lines[1] != (application == UpdateApplication.Desktop ? "desktop" : "cli") ||
            !Path.IsPathFullyQualified(lines[2]) || (lines[3].Length != 0 && !Path.IsPathFullyQualified(lines[3])) ||
            lines[4] is not ("true" or "false") || (!OperatingSystem.IsWindows() && lines[3].Length == 0))
            throw new InvalidOperationException("The installation receipt is invalid. Rerun the release installer.");
        string root = Path.GetFullPath(lines[2]);
        string location = Path.TrimEndingDirectorySeparator(Path.GetFullPath(baseDirectory));
        location = new DirectoryInfo(location).ResolveLinkTarget(returnFinalTarget: true)?.FullName ?? location;
        if (OperatingSystem.IsMacOS() && application == UpdateApplication.Desktop)
        {
            string bundle = Path.GetFullPath(Path.Combine(location, "..", ".."));
            string? target = new DirectoryInfo(bundle).ResolveLinkTarget(returnFinalTarget: true)?.FullName;
            if (target is not null) location = Path.Combine(target, "Contents", "MacOS");
        }
        string relative = Path.GetRelativePath(root, location);
        string[] parts = relative.Split(Path.DirectorySeparatorChar);
        string prefix = application == UpdateApplication.Desktop ? "desktop-release." : "release.";
        bool macBundle = OperatingSystem.IsMacOS() && application == UpdateApplication.Desktop;
        if (!parts[0].StartsWith(prefix, StringComparison.Ordinal) || parts[0].Length <= prefix.Length ||
            (macBundle ? parts.Length != 4 || parts[1] != "Log Studio.app" || parts[2] != "Contents" || parts[3] != "MacOS" : parts.Length != 1))
            throw new InvalidOperationException("The installation was moved. Rerun the release installer before updating.");
        reason = null;
        return new UpdateInstallation(application, root, lines[3], lines[4] == "true", location);
    }
}

internal sealed record ReleaseVersion(Version Core, string[] Prerelease)
{
    internal static bool TryParse(string value, out ReleaseVersion result)
    {
        result = new ReleaseVersion(new Version(0, 0, 0), []);
        Match match = Regex.Match(value, @"\A(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?\z", RegexOptions.CultureInvariant);
        if (!match.Success || !Version.TryParse(string.Join(".", match.Groups[1].Value, match.Groups[2].Value, match.Groups[3].Value), out Version? core))
            return false;
        string[] prerelease = match.Groups[4].Success ? match.Groups[4].Value.Split('.') : [];
        if (prerelease.Any(part => part.Length > 1 && part[0] == '0' && part.All(char.IsAsciiDigit))) return false;
        result = new ReleaseVersion(core, prerelease);
        return true;
    }

    internal static bool IsNewer(string candidate, string current)
    {
        if (!TryParse(candidate, out ReleaseVersion next) || !TryParse(current, out ReleaseVersion previous))
            throw new InvalidOperationException("Cannot compare invalid release versions.");
        int comparison = next.Core.CompareTo(previous.Core);
        if (comparison != 0) return comparison > 0;
        if (next.Prerelease.Length == 0 || previous.Prerelease.Length == 0)
            return next.Prerelease.Length == 0 && previous.Prerelease.Length != 0;
        for (int index = 0; index < Math.Min(next.Prerelease.Length, previous.Prerelease.Length); index++)
        {
            string left = next.Prerelease[index], right = previous.Prerelease[index];
            bool leftNumber = left.All(char.IsAsciiDigit), rightNumber = right.All(char.IsAsciiDigit);
            comparison = leftNumber && rightNumber ? left.Length.CompareTo(right.Length) : leftNumber != rightNumber ? leftNumber ? -1 : 1 : 0;
            if (comparison == 0) comparison = string.CompareOrdinal(left, right);
            if (comparison != 0) return comparison > 0;
        }
        return next.Prerelease.Length > previous.Prerelease.Length;
    }
}
