#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Version = "latest",
    [string]$InstallDir = "",
    [switch]$Cli,
    [switch]$Desktop,
    [string]$PublishDir = "",
    [switch]$NoLauncher,
    [switch]$Help
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
if ($Help) {
    Write-Host @"
Download and install a compiled Windows Log Studio release (no SDK or Node.js required).
Usage: ./install-release.ps1 [-Cli | -Desktop] [-Version X.Y.Z] [-InstallDir <directory>]
Installs both CLI and desktop by default, with a per-user Start Menu shortcut.
Supports x64 and ARM64. Defaults: latest release in %LOCALAPPDATA%\LogStudio and LogStudioDesktop.
Use -Cli or -Desktop to install only that app, leaving the other unchanged.
Use -PublishDir <directory> with -Cli or -Desktop to install a local publish without downloading.
Use -NoLauncher to skip the Start Menu shortcut (for project-local source installs).
Desktop requires the system WebView2 runtime; no OS dependencies are installed.
No administrator access or persistent PATH changes. -Help downloads nothing.
"@
    exit 0
}

$TemporaryDir = $null
$Installations = @()
$PendingShortcut = $null
$Installed = $false
$PreviousSecurityProtocol = [Net.ServicePointManager]::SecurityProtocol
try {
    if ($Cli -and $Desktop) { throw "Choose only one of -Cli and -Desktop." }
    if ($PublishDir -and -not ($Cli -or $Desktop)) { throw "-PublishDir requires -Cli or -Desktop." }
    if ($PublishDir) { $PublishDir = (Resolve-Path -LiteralPath $PublishDir).Path }
    if ($Version -ne "latest" -and $Version -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$') {
        throw "Expected a release tag such as 1.0.2 or 1.0.2-rc.1, without a v prefix."
    }
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw "Use install-release.sh on macOS or Linux."
    }
    $Cpu = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $Architecture = switch ($Cpu) {
        "AMD64" { "x64" }
        "ARM64" { "arm64" }
        default { throw "Unsupported CPU architecture; releases support x64 and ARM64." }
    }
    $Repository = "https://github.com/matanelcohen/LogStudio"
    $DownloadUrl = if ($Version -eq "latest") { "$Repository/releases/latest/download" } else { "$Repository/releases/download/$Version" }
    $TemporaryDir = Join-Path ([IO.Path]::GetTempPath()) ("logstudio-download." + [Guid]::NewGuid().ToString("N"))
    [void][IO.Directory]::CreateDirectory($TemporaryDir)
    [Net.ServicePointManager]::SecurityProtocol = $PreviousSecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $Applications = if ($Cli) { @("logstudio") } elseif ($Desktop) { @("logstudio-desktop") } else { @("logstudio", "logstudio-desktop") }
    $RequestedInstallDir = $InstallDir
    foreach ($Application in $Applications) {
        $Desktop = $Application -eq "logstudio-desktop"
        $InstallDir = if ($RequestedInstallDir) { $RequestedInstallDir } else {
            Join-Path $env:LOCALAPPDATA $(if ($Desktop) { "LogStudioDesktop" } else { "LogStudio" })
        }
        $InstallDir = [IO.Path]::GetFullPath($InstallDir)
        if ($InstallDir.Contains("`n") -or $InstallDir.Contains("`r")) { throw "Installation paths must not contain line breaks." }
        $ReleasePrefix = if ($Desktop) { "desktop-release" } else { "release" }
        $Asset = "$Application-win-$Architecture.zip"
        if (-not $PublishDir) {
            Write-Host "Downloading $Asset ($Version)..."
            foreach ($File in @($Asset, "$Asset.sha256")) {
                Invoke-WebRequest -UseBasicParsing -TimeoutSec 600 -Uri "$DownloadUrl/$File" -OutFile (Join-Path $TemporaryDir $File)
            }
            $Archive = Join-Path $TemporaryDir $Asset
            $Checksum = (Get-Content -LiteralPath (Join-Path $TemporaryDir "$Asset.sha256") -Raw).Trim()
            if ($Checksum -cnotmatch ('^([a-f0-9]{64}) [ *]' + [regex]::Escape($Asset) + '$')) {
                throw "Invalid release checksum file; nothing was installed."
            }
            $ExpectedHash = $Matches[1]
            if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedHash) {
                throw "Release checksum verification failed; nothing was installed."
            }
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $Zip = [IO.Compression.ZipFile]::OpenRead($Archive)
            try {
                foreach ($Entry in $Zip.Entries) {
                    if ($Entry.FullName -match '(^[/\\]|(^|[/\\])\.\.([/\\]|$)|:)') {
                        throw "The release archive contains unsafe paths."
                    }
                }
            } finally { $Zip.Dispose() }
        }
        $ReleaseDir = Join-Path $InstallDir ("$ReleasePrefix." + [Guid]::NewGuid().ToString("N"))
        $Installation = [PSCustomObject]@{
            ReleaseDir = $ReleaseDir; BinDir = $null; PendingBin = $null; PreviousBin = $null; BinReplaced = $false
        }
        $Installations += $Installation
        if ($PublishDir) {
            [void][IO.Directory]::CreateDirectory($ReleaseDir)
            Get-ChildItem -LiteralPath $PublishDir -Force | Copy-Item -Destination $ReleaseDir -Recurse
        } else {
            Expand-Archive -LiteralPath $Archive -DestinationPath $ReleaseDir
        }
        $ExecutableName = if ($Desktop) { "LogStudio.Desktop.exe" } else { "logstudio.exe" }
        $Executable = Join-Path $ReleaseDir $ExecutableName
        if (-not (Test-Path -LiteralPath $Executable -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $ReleaseDir "LogStudio.dll") -PathType Leaf)) {
            throw "The archive is missing the executable or LogStudio.dll."
        }
        if ($Desktop -and -not (Test-Path -LiteralPath (Join-Path $ReleaseDir "LogStudio.Desktop.dll") -PathType Leaf)) {
            throw "The desktop archive is missing LogStudio.Desktop.dll."
        }
        if ($Desktop) {
            $NativeLibrary = Join-Path $ReleaseDir "Photino.Native.dll"
            if ($PublishDir -and -not (Test-Path -LiteralPath $NativeLibrary -PathType Leaf)) {
                $NativeLibrary = Join-Path $ReleaseDir "runtimes/win-$Architecture/native/Photino.Native.dll"
            }
            if (-not (Test-Path -LiteralPath $NativeLibrary -PathType Leaf) -or (Get-Item -LiteralPath $NativeLibrary).Length -eq 0) {
                throw "The desktop archive is missing a nonempty Photino.Native.dll."
            }
        }
        $Component = if ($Desktop) { "desktop" } else { "cli" }
        $Launcher = if ($NoLauncher) { "false" } else { "true" }
        [IO.File]::WriteAllLines((Join-Path $ReleaseDir "logstudio-install.txt"),
            @("1", $Component, $InstallDir, "", $Launcher), [Text.UTF8Encoding]::new($false))
        & $Executable --help | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Installed tool verification failed." }
        $BinDir = Join-Path $InstallDir $(if ($Desktop) { "desktop-bin" } else { "bin" })
        $Installation.BinDir = $BinDir
        $ExistingBin = Get-Item -LiteralPath $BinDir -Force -ErrorAction SilentlyContinue
        $CurrentRelease = $null
        if ($ExistingBin) {
            if ($ExistingBin.LinkType -ne "Junction") {
                throw "Refusing to replace an unrelated directory or file: $BinDir"
            }
            $CurrentRelease = [IO.Path]::GetFullPath(@($ExistingBin.Target)[0])
            $TargetParent = Split-Path -Parent $CurrentRelease
            if ($TargetParent.TrimEnd("\") -ne $InstallDir.TrimEnd("\") -or (Split-Path -Leaf $CurrentRelease) -notlike "$ReleasePrefix.*") {
                throw "Refusing to replace an unrelated junction: $BinDir"
            }
        }
        if ($Desktop -and -not $NoLauncher) {
            $ShortcutPath = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Log Studio.lnk"
            $ShortcutTarget = $Executable
            $ShortcutDescription = "Log Studio desktop (installed by install-release.ps1)"
            $Shell = New-Object -ComObject WScript.Shell
            if (Test-Path -LiteralPath $ShortcutPath) {
                $ExistingShortcut = Get-Item -LiteralPath $ShortcutPath -Force
                if ($ExistingShortcut.PSIsContainer -or $ExistingShortcut.LinkType) {
                    throw "Refusing to replace an unrelated shortcut or directory: $ShortcutPath"
                }
                $Shortcut = $Shell.CreateShortcut($ShortcutPath)
                $ManagedShortcutTargets = @((Join-Path $BinDir $ExecutableName))
                if ($CurrentRelease) { $ManagedShortcutTargets += Join-Path $CurrentRelease $ExecutableName }
                if ([string]::IsNullOrWhiteSpace($Shortcut.TargetPath) -or -not ($ManagedShortcutTargets | Where-Object {
                    [string]::Equals([IO.Path]::GetFullPath($Shortcut.TargetPath), [IO.Path]::GetFullPath($_), [StringComparison]::OrdinalIgnoreCase)
                }) -or $Shortcut.Description -ne $ShortcutDescription) {
                    throw "Refusing to replace an unrelated shortcut: $ShortcutPath"
                }
            }
            [void][IO.Directory]::CreateDirectory((Split-Path -Parent $ShortcutPath))
            $PendingShortcut = Join-Path (Split-Path -Parent $ShortcutPath) (".logstudio.pending." + [Guid]::NewGuid().ToString("N") + ".lnk")
            $Shortcut = $Shell.CreateShortcut($PendingShortcut)
            $Shortcut.TargetPath = $ShortcutTarget
            $Shortcut.WorkingDirectory = $ReleaseDir
            $IconPath = Join-Path $ReleaseDir "logstudio.ico"
            if (Test-Path -LiteralPath $IconPath -PathType Leaf) { $Shortcut.IconLocation = "$IconPath,0" }
            $Shortcut.Description = $ShortcutDescription
            $Shortcut.Save()
        }
        $PendingBin = Join-Path $InstallDir (".bin.pending." + [Guid]::NewGuid().ToString("N"))
        $Installation.PendingBin = $PendingBin
        New-Item -ItemType Junction -Path $PendingBin -Target $ReleaseDir | Out-Null
    }
    foreach ($Installation in $Installations) {
        $BinDir = $Installation.BinDir
        $ExistingBin = Get-Item -LiteralPath $BinDir -Force -ErrorAction SilentlyContinue
        if ($ExistingBin) {
            $Installation.PreviousBin = Join-Path (Split-Path -Parent $BinDir) (".bin.previous." + [Guid]::NewGuid().ToString("N"))
            Move-Item -LiteralPath $BinDir -Destination $Installation.PreviousBin
        }
        Move-Item -LiteralPath $Installation.PendingBin -Destination $BinDir
        $Installation.BinReplaced = $true
    }
    if ($PendingShortcut) { Move-Item -LiteralPath $PendingShortcut -Destination $ShortcutPath -Force }
    $Installed = $true
    foreach ($Installation in $Installations) {
        if ($Installation.PreviousBin) { [IO.Directory]::Delete($Installation.PreviousBin) }
        $BinDir = $Installation.BinDir
        if (($env:PATH -split ";") -notcontains $BinDir) { $env:PATH = "$BinDir;$env:PATH" }
        Write-Host "`nInstalled Log Studio at $BinDir"
        Write-Host "Added $BinDir to PATH for this session only; add it to your user PATH for future terminals."
    }
    if ($Applications -contains "logstudio-desktop") {
        if ($NoLauncher) { Write-Host "Run: LogStudio.Desktop" }
        else { Write-Host "Launch Log Studio from the Start Menu or run: LogStudio.Desktop" }
    }
    if ($Applications -contains "logstudio") {
        Write-Host "Run: logstudio --open -- your-command"
    }
} catch {
    Write-Error $_.Exception.Message -ErrorAction Continue
    exit 1
} finally {
    [Net.ServicePointManager]::SecurityProtocol = $PreviousSecurityProtocol
    [array]::Reverse($Installations)
    foreach ($Installation in $Installations) {
        if (-not $Installed) {
            if ($Installation.BinReplaced) { [IO.Directory]::Delete($Installation.BinDir) }
            if ($Installation.PreviousBin -and (Test-Path -LiteralPath $Installation.PreviousBin)) {
                Move-Item -LiteralPath $Installation.PreviousBin -Destination $Installation.BinDir
            }
        }
        if ($Installation.PendingBin -and (Test-Path -LiteralPath $Installation.PendingBin)) { [IO.Directory]::Delete($Installation.PendingBin) }
        if (-not $Installed -and (Test-Path -LiteralPath $Installation.ReleaseDir)) { Remove-Item -LiteralPath $Installation.ReleaseDir -Recurse -Force }
    }
    if ($PendingShortcut -and (Test-Path -LiteralPath $PendingShortcut)) { Remove-Item -LiteralPath $PendingShortcut -Force }
    if ($TemporaryDir -and (Test-Path -LiteralPath $TemporaryDir)) { Remove-Item -LiteralPath $TemporaryDir -Recurse -Force }
}
