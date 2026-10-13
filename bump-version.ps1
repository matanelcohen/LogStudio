#!/usr/bin/env pwsh
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Version,
  [switch]$Tag,
  [switch]$Help
)

$ErrorActionPreference = "Stop"

function Show-Usage {
  @"
Align the version across Directory.Build.props, frontend, samples, and documentation.

Usage: .\bump-version.ps1 [-Version] <version> [-Tag]

  -Version <version> The new version (e.g. 1.0.1 or v1.0.1; v prefix optional).
  -Tag               Create or update the git tag (e.g. v1.0.1) pointing to HEAD.
  -Help              Show this help.

This script updates:
  - Directory.Build.props (<Version>)
  - frontend/package.json and frontend/package-lock.json
  - samples/PackageConsumer/PackageConsumer.csproj
  - README.md installation and package references
"@
}

if ($Help) {
  Show-Usage
  exit 0
}

if (-not $Version) {
  [Console]::Error.WriteLine("Version argument is required.")
  Show-Usage
  exit 2
}

$CleanVersion = if ($Version.StartsWith("v", [System.StringComparison]::OrdinalIgnoreCase)) { $Version.Substring(1) } else { $Version }
$TagVersion = "v$CleanVersion"

$SemverPattern = '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$'
if ($CleanVersion -notmatch $SemverPattern) {
  [Console]::Error.WriteLine("Invalid version: '$Version'. Expected semver format such as 1.0.0 or 1.0.0-rc.1")
  exit 1
}

$ProjectRoot = $PSScriptRoot
if (-not $ProjectRoot) { $ProjectRoot = (Get-Location).Path }

$PropsFile = Join-Path $ProjectRoot "Directory.Build.props"
$FrontendPackage = Join-Path $ProjectRoot "frontend/package.json"
$FrontendLock = Join-Path $ProjectRoot "frontend/package-lock.json"
$ConsumerProject = Join-Path $ProjectRoot "samples/PackageConsumer/PackageConsumer.csproj"
$ReadmeFile = Join-Path $ProjectRoot "README.md"
$LibraryProject = Join-Path $ProjectRoot "src/LogStudio/LogStudio.csproj"

if (-not (Test-Path $PropsFile)) {
  [Console]::Error.WriteLine("Directory.Build.props not found at $PropsFile")
  exit 1
}

$propsContent = [System.IO.File]::ReadAllText($PropsFile)
if ($propsContent -match '<Version>([^<]+)</Version>') {
  $CurrentVersion = $Matches[1]
} else {
  [Console]::Error.WriteLine("Could not determine current version from $PropsFile")
  exit 1
}

Write-Host "Updating version from $CurrentVersion to $CleanVersion..."

# 1. Update Directory.Build.props
$propsContent = [System.Text.RegularExpressions.Regex]::Replace($propsContent, "<Version>$([regex]::Escape($CurrentVersion))</Version>", "<Version>$CleanVersion</Version>")
[System.IO.File]::WriteAllText($PropsFile, $propsContent)

# 2. Update frontend/package.json
if (Test-Path $FrontendPackage) {
  $pkgContent = [System.IO.File]::ReadAllText($FrontendPackage)
  $pkgReplacement = '"version": "' + $CleanVersion + '"'
  $pkgContent = [System.Text.RegularExpressions.Regex]::Replace($pkgContent, '"version":\s*"[^"]+"', $pkgReplacement)
  [System.IO.File]::WriteAllText($FrontendPackage, $pkgContent)
}

# 3. Update frontend/package-lock.json
if (Test-Path $FrontendLock) {
  $lockContent = [System.IO.File]::ReadAllText($FrontendLock)
  $lockReplacement = '${1}"' + $CleanVersion + '"'
  $lockContent = [System.Text.RegularExpressions.Regex]::Replace($lockContent, '("name":\s*"logstudio-frontend",\s*"version":\s*)"[^"]+"', $lockReplacement)
  $lockContent = [System.Text.RegularExpressions.Regex]::Replace($lockContent, '("":\s*\{\s*"name":\s*"logstudio-frontend",\s*"version":\s*)"[^"]+"', $lockReplacement)
  [System.IO.File]::WriteAllText($FrontendLock, $lockContent)
}

# 4. Update samples/PackageConsumer/PackageConsumer.csproj
if (Test-Path $ConsumerProject) {
  $consumerContent = [System.IO.File]::ReadAllText($ConsumerProject)
  $consumerReplacement = '${1}"' + $CleanVersion + '"'
  $consumerContent = [System.Text.RegularExpressions.Regex]::Replace($consumerContent, '(<PackageReference Include="LogStudio" Version=)"[^"]+"', $consumerReplacement)
  [System.IO.File]::WriteAllText($ConsumerProject, $consumerContent)
}

# 5. Update README.md
if (Test-Path $ReadmeFile) {
  $readmeContent = [System.IO.File]::ReadAllText($ReadmeFile)
  $readmeContent = $readmeContent.Replace("--version v$CurrentVersion", "--version v$CleanVersion")
  $readmeContent = $readmeContent.Replace("-Version v$CurrentVersion", "-Version v$CleanVersion")
  $oldPattern = '`v' + $CurrentVersion + '` (or `v' + $CurrentVersion + '-rc.1`'
  $newPattern = '`v' + $CleanVersion + '` (or `v' + $CleanVersion + '-rc.1`'
  $readmeContent = $readmeContent.Replace($oldPattern, $newPattern)
  $readmeContent = $readmeContent.Replace("--version $CurrentVersion", "--version $CleanVersion")
  $readmeContent = $readmeContent.Replace("LogStudio.$CurrentVersion.nupkg", "LogStudio.$CleanVersion.nupkg")
  [System.IO.File]::WriteAllText($ReadmeFile, $readmeContent)
}

# 6. Optional git tag
if ($Tag) {
  & git tag -f $TagVersion
  if ($LASTEXITCODE -eq 0) {
    $shortSha = (& git rev-parse --short HEAD).Trim()
    Write-Host "Updated git tag $TagVersion -> $shortSha"
  } else {
    Write-Warning "Could not update git tag $TagVersion"
  }
}

Write-Host "`nSuccessfully bumped version to $CleanVersion ($TagVersion)"
Write-Host "Updated:"
Write-Host "  - Directory.Build.props"
Write-Host "  - frontend/package.json"
Write-Host "  - frontend/package-lock.json"
Write-Host "  - samples/PackageConsumer/PackageConsumer.csproj"
Write-Host "  - README.md"
if ($Tag) {
  Write-Host "  - git tag $TagVersion"
}
