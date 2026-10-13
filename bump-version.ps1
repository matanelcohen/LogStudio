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

  -Version <version> The new version (e.g. 1.0.2; no v prefix).
  -Tag               Create or update the git tag (e.g. 1.0.2) pointing to HEAD.
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

$SemverPattern = '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$'
if ($Version -notmatch $SemverPattern) {
  [Console]::Error.WriteLine("Invalid version: '$Version'. Expected unprefixed semver such as 1.0.2 or 1.0.2-rc.1")
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

Write-Host "Updating version from $CurrentVersion to $Version..."

# 1. Update Directory.Build.props
$propsContent = [System.Text.RegularExpressions.Regex]::Replace($propsContent, "<Version>$([regex]::Escape($CurrentVersion))</Version>", "<Version>$Version</Version>")
[System.IO.File]::WriteAllText($PropsFile, $propsContent)

# 2. Update frontend/package.json
if (Test-Path $FrontendPackage) {
  $pkgContent = [System.IO.File]::ReadAllText($FrontendPackage)
  $pkgReplacement = '"version": "' + $Version + '"'
  $pkgContent = [System.Text.RegularExpressions.Regex]::Replace($pkgContent, '"version":\s*"[^"]+"', $pkgReplacement)
  [System.IO.File]::WriteAllText($FrontendPackage, $pkgContent)
}

# 3. Update frontend/package-lock.json
if (Test-Path $FrontendLock) {
  $lockContent = [System.IO.File]::ReadAllText($FrontendLock)
  $lockReplacement = '${1}"' + $Version + '"'
  $lockContent = [System.Text.RegularExpressions.Regex]::Replace($lockContent, '("name":\s*"logstudio-frontend",\s*"version":\s*)"[^"]+"', $lockReplacement)
  $lockContent = [System.Text.RegularExpressions.Regex]::Replace($lockContent, '("":\s*\{\s*"name":\s*"logstudio-frontend",\s*"version":\s*)"[^"]+"', $lockReplacement)
  [System.IO.File]::WriteAllText($FrontendLock, $lockContent)
}

# 4. Update samples/PackageConsumer/PackageConsumer.csproj
if (Test-Path $ConsumerProject) {
  $consumerContent = [System.IO.File]::ReadAllText($ConsumerProject)
  $consumerReplacement = '${1}"' + $Version + '"'
  $consumerContent = [System.Text.RegularExpressions.Regex]::Replace($consumerContent, '(<PackageReference Include="LogStudio" Version=)"[^"]+"', $consumerReplacement)
  [System.IO.File]::WriteAllText($ConsumerProject, $consumerContent)
}

# 5. Update README.md
if (Test-Path $ReadmeFile) {
  $readmeContent = [System.IO.File]::ReadAllText($ReadmeFile)
  $readmeContent = $readmeContent.Replace("--version $CurrentVersion", "--version $Version")
  $readmeContent = $readmeContent.Replace("-Version $CurrentVersion", "-Version $Version")
  $oldPattern = '`' + $CurrentVersion + '` (or `' + $CurrentVersion + '-rc.1`'
  $newPattern = '`' + $Version + '` (or `' + $Version + '-rc.1`'
  $readmeContent = $readmeContent.Replace($oldPattern, $newPattern)
  $readmeContent = $readmeContent.Replace("LogStudio.$CurrentVersion.nupkg", "LogStudio.$Version.nupkg")
  [System.IO.File]::WriteAllText($ReadmeFile, $readmeContent)
}

# 6. Optional git tag
if ($Tag) {
  & git tag -f $Version
  if ($LASTEXITCODE -eq 0) {
    $shortSha = (& git rev-parse --short HEAD).Trim()
    Write-Host "Updated git tag $Version -> $shortSha"
  } else {
    Write-Warning "Could not update git tag $Version"
  }
}

Write-Host "`nSuccessfully bumped version to $Version"
Write-Host "Updated:"
Write-Host "  - Directory.Build.props"
Write-Host "  - frontend/package.json"
Write-Host "  - frontend/package-lock.json"
Write-Host "  - samples/PackageConsumer/PackageConsumer.csproj"
Write-Host "  - README.md"
if ($Tag) {
  Write-Host "  - git tag $Version"
}
