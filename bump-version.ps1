#!/usr/bin/env pwsh
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Version,
  [switch]$Tag,
  [switch]$Push,
  [switch]$Help
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

function Show-Usage {
  @"
Align the version across Directory.Build.props, frontend, samples, and documentation.

Usage: .\bump-version.ps1 [-Version] <version> [-Tag] [-Push]

  -Version <version> The new version (e.g. 1.0.2; no v prefix).
  -Tag               Create or update the git tag (e.g. 1.0.2) pointing to HEAD.
  -Push              Commit the version bump, push the branch, then create and push the tag.
  -Help              Show this help.

This script updates:
  - Directory.Build.props (<Version>)
  - frontend/package.json and frontend/package-lock.json
  - samples/PackageConsumer/PackageConsumer.csproj
  - README.md and docs/guide.md installation and package references
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
$GuideFile = Join-Path $ProjectRoot "docs/guide.md"
$LibraryProject = Join-Path $ProjectRoot "src/LogStudio/LogStudio.csproj"

function Invoke-Git([string[]]$Arguments) {
  & git -C $ProjectRoot @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Git failed with exit code ${LASTEXITCODE}: git $($Arguments -join ' ')"
  }
}

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

$VersionFiles = @(
  "Directory.Build.props", "frontend/package.json", "frontend/package-lock.json",
  "samples/PackageConsumer/PackageConsumer.csproj", "README.md", "docs/guide.md"
) | Where-Object { Test-Path (Join-Path $ProjectRoot $_) }

if ($Push) {
  $Branch = Invoke-Git @("symbolic-ref", "--quiet", "--short", "HEAD")
  if (Invoke-Git @("diff", "--cached", "--name-only")) {
    throw "Commit or unstage existing staged changes before using -Push."
  }
  if (Invoke-Git (@("status", "--porcelain", "--") + $VersionFiles)) {
    throw "Commit or stash changes to versioned files before using -Push."
  }
  if (Invoke-Git @("tag", "--list", $Version)) {
    throw "Git tag $Version already exists; -Push will not overwrite it."
  }
  $PushRemote = Invoke-Git @("for-each-ref", "--format=%(upstream:remotename)", "refs/heads/$Branch")
  if (-not $PushRemote) {
    $PushRemote = "origin"
  }
  Invoke-Git @("remote", "get-url", $PushRemote) | Out-Null
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

# 5. Update documentation
foreach ($DocumentationFile in @($ReadmeFile, $GuideFile)) {
  if (Test-Path $DocumentationFile) {
    $documentationContent = [System.IO.File]::ReadAllText($DocumentationFile)
    $documentationContent = $documentationContent.Replace("--version $CurrentVersion", "--version $Version")
    $documentationContent = $documentationContent.Replace("-Version $CurrentVersion", "-Version $Version")
    $oldPattern = '`' + $CurrentVersion + '` (or `' + $CurrentVersion + '-rc.1`'
    $newPattern = '`' + $Version + '` (or `' + $Version + '-rc.1`'
    $documentationContent = $documentationContent.Replace($oldPattern, $newPattern)
    $documentationContent = $documentationContent.Replace("LogStudio.$CurrentVersion.nupkg", "LogStudio.$Version.nupkg")
    [System.IO.File]::WriteAllText($DocumentationFile, $documentationContent)
  }
}

# 6. Optional commit, push, and git tag
if ($Push) {
  Invoke-Git (@("add", "--") + $VersionFiles)
  Invoke-Git @("commit", "-m", "Bump version to $Version")
  Invoke-Git @("push", "--set-upstream", $PushRemote, $Branch)
  Invoke-Git @("tag", $Version)
  Invoke-Git @("push", $PushRemote, "refs/tags/$Version")
} elseif ($Tag) {
  Invoke-Git @("tag", "-f", $Version)
  $shortSha = (Invoke-Git @("rev-parse", "--short", "HEAD")).Trim()
  Write-Host "Updated git tag $Version -> $shortSha"
}

Write-Host "`nSuccessfully bumped version to $Version"
Write-Host "Updated:"
Write-Host "  - Directory.Build.props"
Write-Host "  - frontend/package.json"
Write-Host "  - frontend/package-lock.json"
Write-Host "  - samples/PackageConsumer/PackageConsumer.csproj"
Write-Host "  - README.md"
Write-Host "  - docs/guide.md"
if ($Tag -or $Push) {
  Write-Host "  - git tag $Version"
}
