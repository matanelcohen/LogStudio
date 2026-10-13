#requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$Local,
    [switch]$Global,
    [switch]$Offline,
    [switch]$Online,
    [string]$NuGetSource = "",
    [switch]$Help
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
$ProjectRoot = $PSScriptRoot
$Solution = Join-Path $ProjectRoot "LogStudio.sln"
$LibraryProject = Join-Path $ProjectRoot "src/LogStudio/LogStudio.csproj"
$Frontend = Join-Path $ProjectRoot "frontend"
$Artifacts = Join-Path $ProjectRoot "artifacts"
$PackageId = "LogStudio.Tool"
$ToolCommand = "logstudio"
$Configuration = "Release"
$NuGetFallback = "https://www.nuget.org/api/v2/"
$WindowsPlatform = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
$InstallCache = $null

if ($Help) {
    Write-Host @"
Build, test, pack, and install Log Studio from local source.

Usage: ./install.ps1 [-Global | -Local] [-Offline | -Online] [-NuGetSource <source>]

  -Global   Install for the current user (default); no administrator access required.
  -Local    Install into artifacts/tool without changing the global tool.
  -Offline  Require cached dependencies; never try the network.
  -Online   Require the configured online restore and vulnerability lookup.
  -NuGetSource <source>  Use an explicit NuGet feed instead of NuGet.Config.
  -Help     Show this help.

Default restore is cache-first, then configured sources, then official NuGet v2.
The v2 fallback does not provide vulnerability auditing; -Online never uses it.
Prerequisites: .NET 10 SDK and Node.js 22.12+ with npm.
No system software, shell profiles, or unrelated tools are modified.
"@
    exit 0
}

if (($Local -and $Global) -or ($Offline -and $Online)) {
    Write-Error "Choose one installation scope and one restore mode."
    exit 2
}

function Find-Application([string]$Name, [string]$SetupMessage) {
    $application = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $application) { throw $SetupMessage }
    return $application.Source
}

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $Command $($Arguments -join ' ')"
    }
}

$LocationPushed = $false
$PreviousPackageCache = $env:NUGET_PACKAGES
try {
    $Dotnet = Find-Application "dotnet" "Install the .NET 10 SDK for your operating system and CPU: https://dotnet.microsoft.com/download/dotnet/10.0"
    $Node = Find-Application "node" "Install Node.js 22.12+ with npm: https://nodejs.org/en/download"
    $NpmName = if ($WindowsPlatform) { "npm.cmd" } else { "npm" }
    $Npm = Find-Application $NpmName "Install Node.js 22.12+ with npm: https://nodejs.org/en/download"
    $NodeVersion = (& $Node --version | Out-String).Trim().TrimStart("v")
    if ($LASTEXITCODE -ne 0 -or [version]$NodeVersion -lt [version]"22.12.0") {
        throw "Node.js 22.12 or newer is required: https://nodejs.org/en/download"
    }
    Push-Location $ProjectRoot
    $LocationPushed = $true
    Invoke-Checked $Dotnet @("--version")

    Write-Host "`nRestoring frontend libraries..."
    Set-Location $Frontend
    $FrontendRestored = $false
    if (-not $Online) {
        & $Npm ci --offline
        if ($LASTEXITCODE -eq 0) {
            $FrontendRestored = $true
            Write-Host "Frontend restored from cache. No online npm vulnerability check was performed."
        } elseif ($Offline) {
            throw "Offline frontend restore failed. Populate the npm cache before using -Offline."
        } else {
            Write-Host "Frontend cache is incomplete; retrying configured package sources."
        }
    }
    if (-not $FrontendRestored) {
        Invoke-Checked $Npm @("ci", "--prefer-online")
        Invoke-Checked $Npm @("audit", "--audit-level=high")
    }
    Write-Host "`nBuilding and testing React frontend..."
    Invoke-Checked $Npm @("run", "build")
    Invoke-Checked $Npm @("test")

    Set-Location $ProjectRoot
    $Version = (& $Dotnet msbuild $LibraryProject -nologo -getProperty:PackageVersion | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $Version -or $Version -match "[`r`n]") {
        throw "Could not determine a single NuGet package version from $LibraryProject."
    }
    Write-Host "`nRestoring Log Studio $Version..."
    $Restored = $false
    $PackageCache = ""
    if (-not $Online) {
        $CacheLocation = (& $Dotnet nuget locals global-packages --list | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw "Could not locate the existing NuGet package cache." }
        $separator = $CacheLocation.IndexOf(": ")
        if ($separator -ge 0) { $PackageCache = $CacheLocation.Substring($separator + 2) }
        if (-not $PackageCache -or -not (Test-Path -LiteralPath $PackageCache -PathType Container)) {
            if ($Offline) { throw "No existing NuGet package cache was found. Offline restore cannot continue." }
            Write-Host "No usable package cache was found; trying configured sources."
        } else {
            Write-Host "Trying cached dependencies first (no network access)..."
            & $Dotnet restore $Solution --source $PackageCache
            if ($LASTEXITCODE -eq 0) {
                $Restored = $true
                Write-Host "Cache-only restore succeeded. Online vulnerability checks were NOT performed."
            } elseif ($Offline) {
                throw "Offline restore failed. Offline mode cannot download missing dependencies."
            } else {
                Write-Host "Cached restore failed; retrying configured online sources."
            }
        }
    }
    if (-not $Restored) {
        $RestoreArguments = if ($NuGetSource) { @("--source", $NuGetSource) } else { @("--configfile", (Join-Path $ProjectRoot "NuGet.Config")) }
        & $Dotnet restore $Solution @RestoreArguments
        if ($LASTEXITCODE -eq 0) {
            $Restored = $true
        } elseif (-not $Online -and -not $NuGetSource) {
            Write-Host "`nConfigured restore failed. Trying the official NuGet v2 feed over verified TLS."
            $FallbackArguments = @("--source", $NuGetFallback)
            if ($PackageCache -and (Test-Path -LiteralPath $PackageCache -PathType Container)) {
                $FallbackArguments += @("--source", $PackageCache)
            }
            & $Dotnet restore $Solution @FallbackArguments
            if ($LASTEXITCODE -eq 0) {
                $Restored = $true
                Write-Host "NuGet v2 restore succeeded. Online vulnerability checks were NOT performed; -Online never uses this fallback."
            }
        }
        if (-not $Restored) {
            throw "Restore failed. Check network/proxy/certificate settings or use -NuGetSource. Offline cannot download missing dependencies."
        }
    }

    Write-Host "`nBuilding and testing..."
    Invoke-Checked $Dotnet @("build", $Solution, "--configuration", $Configuration, "--no-restore")
    Invoke-Checked $Dotnet @("test", $Solution, "--configuration", $Configuration, "--no-build", "--no-restore")
    Write-Host "`nPacking local NuGet packages..."
    Invoke-Checked $Dotnet @("pack", $Solution, "--configuration", $Configuration, "--no-build", "--no-restore", "--output", $Artifacts)
    $PackagePath = Join-Path $Artifacts "$PackageId.$Version.nupkg"
    if (-not (Test-Path -LiteralPath $PackagePath -PathType Leaf)) { throw "The expected package was not produced: $PackagePath" }

    if ($Local) {
        $ToolDirectory = Join-Path $Artifacts "tool"
        $ToolScope = @("--tool-path", $ToolDirectory)
    } else {
        $DotnetHome = if ($env:DOTNET_CLI_HOME) { $env:DOTNET_CLI_HOME } else { [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile) }
        $ToolDirectory = Join-Path $DotnetHome ".dotnet/tools"
        $ToolScope = @("--global")
    }
    $InstallCache = Join-Path $Artifacts (".install-cache." + [Guid]::NewGuid().ToString("N"))
    [void][IO.Directory]::CreateDirectory($InstallCache)
    $InstalledTools = & $Dotnet tool list @ToolScope
    if ($LASTEXITCODE -ne 0) { throw "Could not read the selected tool installation scope." }
    if ($InstalledTools | Where-Object { ($_ -split "\s+")[0] -ieq $PackageId }) {
        Write-Host "`nReplacing the existing Log Studio installation..."
        Invoke-Checked $Dotnet (@("tool", "uninstall", $PackageId) + $ToolScope)
    }
    Write-Host "`nInstalling $PackageId..."
    $env:NUGET_PACKAGES = $InstallCache
    Invoke-Checked $Dotnet (@("tool", "install", $PackageId) + $ToolScope + @("--version", $Version, "--configfile", (Join-Path $ProjectRoot "NuGet.Local.Config")))
    $env:NUGET_PACKAGES = $PreviousPackageCache
    $ExecutableName = if ($WindowsPlatform) { "$ToolCommand.exe" } else { $ToolCommand }
    $Executable = Join-Path $ToolDirectory $ExecutableName
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw "Installation returned without the expected executable: $Executable" }
    & $Executable --help | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Installed tool verification failed." }
    Write-Host "`nInstalled Log Studio $Version at $Executable"
    if ($Local) {
        Write-Host "Run: & `"$Executable`" --open -- dotnet run --project ./path/to/App.csproj"
    } else {
        $PathEntries = $env:PATH -split [IO.Path]::PathSeparator
        if ($PathEntries -notcontains $ToolDirectory) { Write-Host "Add $ToolDirectory to your user PATH to run logstudio from any directory." }
        Write-Host "Run: logstudio --open -- dotnet run --project ./path/to/App.csproj"
    }
} catch {
    Write-Error $_.Exception.Message -ErrorAction Continue
    exit 1
} finally {
    $env:NUGET_PACKAGES = $PreviousPackageCache
    if ($InstallCache -and (Test-Path -LiteralPath $InstallCache -PathType Container)) {
        $CacheParent = [IO.Path]::GetFullPath((Split-Path -Parent $InstallCache))
        if ($CacheParent -ne [IO.Path]::GetFullPath($Artifacts) -or (Split-Path -Leaf $InstallCache) -notlike ".install-cache.*") {
            throw "Refusing to remove an unexpected installation cache: $InstallCache"
        }
        Remove-Item -LiteralPath $InstallCache -Recurse -Force
    }
    if ($LocationPushed) { Pop-Location }
}
