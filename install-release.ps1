#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Version = "latest",
    [string]$InstallDir = "",
    [switch]$Help
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
if ($Help) {
    Write-Host @"
Download and install a compiled Windows Log Studio release (no SDK or Node.js required).
Usage: ./install-release.ps1 [-Version X.Y.Z] [-InstallDir <directory>]
Supports x64 and ARM64. Default: latest release in %LOCALAPPDATA%\LogStudio.
No administrator access or persistent PATH changes. -Help downloads nothing.
"@
    exit 0
}

$TemporaryDir = $null
$ReleaseDir = $null
$PendingBin = $null
$PreviousBin = $null
$Installed = $false
$PreviousSecurityProtocol = [Net.ServicePointManager]::SecurityProtocol
try {
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
    if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA "LogStudio" }
    $InstallDir = [IO.Path]::GetFullPath($InstallDir)
    $Asset = "logstudio-win-$Architecture.zip"
    $Repository = "https://github.com/matanelcohen/LogStudio"
    $DownloadUrl = if ($Version -eq "latest") { "$Repository/releases/latest/download" } else { "$Repository/releases/download/$Version" }
    $TemporaryDir = Join-Path ([IO.Path]::GetTempPath()) ("logstudio-download." + [Guid]::NewGuid().ToString("N"))
    [void][IO.Directory]::CreateDirectory($TemporaryDir)
    [Net.ServicePointManager]::SecurityProtocol = $PreviousSecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Write-Host "Downloading $Asset ($Version)..."
    foreach ($File in @($Asset, "$Asset.sha256")) {
        Invoke-WebRequest -UseBasicParsing -Uri "$DownloadUrl/$File" -OutFile (Join-Path $TemporaryDir $File)
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
    $ReleaseDir = Join-Path $InstallDir ("release." + [Guid]::NewGuid().ToString("N"))
    Expand-Archive -LiteralPath $Archive -DestinationPath $ReleaseDir
    $Executable = Join-Path $ReleaseDir "logstudio.exe"
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $ReleaseDir "LogStudio.dll") -PathType Leaf)) {
        throw "The archive is missing the executable or LogStudio.dll."
    }
    & $Executable --help | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Installed tool verification failed." }
    $BinDir = Join-Path $InstallDir "bin"
    $ExistingBin = Get-Item -LiteralPath $BinDir -Force -ErrorAction SilentlyContinue
    if ($ExistingBin) {
        if ($ExistingBin.LinkType -ne "Junction") {
            throw "Refusing to replace an unrelated directory or file: $BinDir"
        }
        $Target = [IO.Path]::GetFullPath(@($ExistingBin.Target)[0])
        $TargetParent = Split-Path -Parent $Target
        if ($TargetParent.TrimEnd("\") -ne $InstallDir.TrimEnd("\") -or (Split-Path -Leaf $Target) -notlike "release.*") {
            throw "Refusing to replace an unrelated junction: $BinDir"
        }
    }
    $PendingBin = Join-Path $InstallDir (".bin.pending." + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Junction -Path $PendingBin -Target $ReleaseDir | Out-Null
    if ($ExistingBin) {
        $PreviousBin = Join-Path $InstallDir (".bin.previous." + [Guid]::NewGuid().ToString("N"))
        Move-Item -LiteralPath $BinDir -Destination $PreviousBin
    }
    Move-Item -LiteralPath $PendingBin -Destination $BinDir
    $Installed = $true
    if ($PreviousBin) { [IO.Directory]::Delete($PreviousBin) }
    if (($env:PATH -split ";") -notcontains $BinDir) { $env:PATH = "$BinDir;$env:PATH" }
    Write-Host "`nInstalled Log Studio at $Executable"
    Write-Host "Added $BinDir to PATH for this session only; add it to your user PATH for future terminals."
    Write-Host "Run: logstudio --open -- your-command"
} catch {
    Write-Error $_.Exception.Message -ErrorAction Continue
    exit 1
} finally {
    [Net.ServicePointManager]::SecurityProtocol = $PreviousSecurityProtocol
    if (-not $Installed -and $PreviousBin -and (Test-Path -LiteralPath $PreviousBin)) {
        Move-Item -LiteralPath $PreviousBin -Destination $BinDir
    }
    if ($PendingBin -and (Test-Path -LiteralPath $PendingBin)) { [IO.Directory]::Delete($PendingBin) }
    if ($TemporaryDir -and (Test-Path -LiteralPath $TemporaryDir)) { Remove-Item -LiteralPath $TemporaryDir -Recurse -Force }
    if (-not $Installed -and $ReleaseDir -and (Test-Path -LiteralPath $ReleaseDir)) { Remove-Item -LiteralPath $ReleaseDir -Recurse -Force }
}
