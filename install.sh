#!/usr/bin/env bash
set -euo pipefail

readonly ProjectRoot="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly Solution="$ProjectRoot/LogStudio.sln"
readonly LibraryProject="$ProjectRoot/src/LogStudio/LogStudio.csproj"
readonly Frontend="$ProjectRoot/frontend"
readonly Artifacts="$ProjectRoot/artifacts"
readonly PackageId="LogStudio.Tool"
readonly ToolCommand="logstudio"
readonly Configuration="Release"
readonly DotnetHome="${DOTNET_CLI_HOME:-$HOME}"
readonly NuGetFallback="https://www.nuget.org/api/v2/"

Scope="global"
RestoreMode="cache-first"
InstallCache=""
NuGetSource=""

usage() {
  printf '%s\n' \
    "Build, test, pack, and install Log Studio from local source." \
    "" \
    "Usage: ./install.sh [--global | --local] [--offline | --online] [--nuget-source <source>]" \
    "" \
    "  --global   Install for the current user; run logstudio from anywhere (default)." \
    "  --local    Install into artifacts/tool without changing the global tool." \
    "  --offline  Require cached dependencies; never try the network." \
    "  --online   Require the configured online restore and vulnerability lookup." \
    "  --nuget-source <source>  Use an explicit NuGet feed instead of NuGet.Config." \
    "  --help     Show this help." \
    "" \
    "By default, restore tries cached dependencies first and reports offline verification." \
    "If cached restore fails, it tries the configured source, then official NuGet v2." \
    "The v2 fallback is cache-first mode only and does not provide vulnerability auditing." \
    "The install always uses the newly built local NuGet package, not NuGet.org." \
    "Building the frontend needs Node.js 22.12+ and npm; running the installed tool does not." \
    "No sudo, application edits, shell-profile edits, or package publication."
}

cleanup() {
  if [[ -n "$InstallCache" && -d "$InstallCache" ]]; then
    case "$InstallCache" in
      "$Artifacts"/.install-cache.*) rm -rf -- "$InstallCache" ;;
      *) printf 'Refusing to remove an unexpected installation cache: %s\n' "$InstallCache" >&2 ;;
    esac
  fi
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --global) Scope="global" ;;
    --local) Scope="local" ;;
    --offline) RestoreMode="offline" ;;
    --online) RestoreMode="online" ;;
    --nuget-source)
      if [[ $# -lt 2 || -z "$2" ]]; then printf '%s\n' '--nuget-source requires a feed URL or directory.' >&2; exit 2; fi
      NuGetSource="$2"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if ! command -v dotnet >/dev/null 2>&1; then
  printf 'The .NET 10 SDK is required: https://dotnet.microsoft.com/download/dotnet/10.0\nChoose the installer matching your operating system and CPU, then rerun this script.\n' >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf 'Node.js 22.12+ and npm are required: https://nodejs.org/en/download\nThe installed tool remains .NET-only; this installer does not modify system software.\n' >&2
  exit 1
fi
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<22||(major===22&&minor<12)){console.error("Node.js 22.12 or newer is required.");process.exit(1);}'
cd "$ProjectRoot"
if ! dotnet --version; then
  printf 'The SDK selected by global.json is unavailable. Install .NET 10 SDK 10.0.301 or a compatible later 10.0 feature band.\n' >&2
  exit 1
fi

printf '\nRestoring frontend libraries...\n'
cd "$Frontend"
FrontendRestored=false
if [[ "$RestoreMode" != "online" ]]; then
  if npm ci --offline; then
    FrontendRestored=true
    printf 'Frontend restored from cache. No online npm vulnerability check was performed.\n'
  elif [[ "$RestoreMode" == "offline" ]]; then
    printf 'Offline frontend restore failed. Populate the npm cache before using --offline.\n' >&2
    exit 1
  else
    printf 'Frontend cache is incomplete; retrying the configured package sources.\n'
  fi
fi
if [[ "$FrontendRestored" != true ]]; then
  npm ci --prefer-online
  for AuditAttempt in 1 2 3; do
    if npm audit --audit-level=high; then
      break
    fi
    if [[ "$AuditAttempt" == 3 ]]; then
      printf 'npm audit failed after 3 attempts; refusing to continue without a successful vulnerability check.\n' >&2
      exit 1
    fi
    printf 'npm audit failed (attempt %s/3); retrying in 5 seconds...\n' "$AuditAttempt" >&2
    sleep 5
  done
fi
printf '\nBuilding and testing React frontend...\n'
npm run build
npm test

cd "$ProjectRoot"
Version="$(dotnet msbuild "$LibraryProject" -nologo -getProperty:PackageVersion)"
if [[ -z "$Version" || "$Version" == *$'\n'* ]]; then
  printf 'Could not determine a single NuGet package version from %s.\n' "$LibraryProject" >&2
  exit 1
fi

printf '\nRestoring Log Studio %s...\n' "$Version"
Restored=false
PackageCache=""
if [[ "$RestoreMode" != "online" ]]; then
  CacheLocation="$(dotnet nuget locals global-packages --list)"
  PackageCache="${CacheLocation#*: }"
  if [[ "$PackageCache" == "$CacheLocation" || ! -d "$PackageCache" ]]; then
    if [[ "$RestoreMode" == "offline" ]]; then
      printf 'The existing NuGet package cache could not be located. Offline restore cannot continue.\n' >&2
      exit 1
    fi
    printf 'No usable package cache was found; trying the configured online source.\n'
  else
    printf 'Trying cached dependencies first (no network access)...\n'
    if dotnet restore "$Solution" --source "$PackageCache"; then
      Restored=true
      printf 'Cache-only restore succeeded. Online vulnerability checks were NOT performed; use --online to require them.\n'
    elif [[ "$RestoreMode" == "offline" ]]; then
      printf 'Cached restore failed. Offline mode cannot download missing dependencies.\n' >&2
      exit 1
    else
      printf 'Cached restore failed; retrying the configured online source without suppressing restore errors.\n'
    fi
  fi
fi
if [[ "$Restored" != true ]]; then
  if [[ -n "$NuGetSource" ]]; then
    RestoreArguments=(--source "$NuGetSource")
  else
    RestoreArguments=(--configfile "$ProjectRoot/NuGet.Config")
  fi
  if dotnet restore "$Solution" "${RestoreArguments[@]}"; then
    Restored=true
  elif [[ "$RestoreMode" == "cache-first" && -z "$NuGetSource" ]]; then
    printf '\nConfigured restore failed. Trying the official NuGet v2 feed over verified TLS.\n'
    FallbackArguments=(--source "$NuGetFallback")
    if [[ -n "$PackageCache" && -d "$PackageCache" ]]; then FallbackArguments+=(--source "$PackageCache"); fi
    if dotnet restore "$Solution" "${FallbackArguments[@]}"; then
      Restored=true
      printf 'NuGet v2 restore succeeded. Online vulnerability checks were NOT performed; --online never uses this fallback.\n'
    fi
  fi
  if [[ "$Restored" != true ]]; then
    printf '\nRestore failed. Check network/proxy/certificate settings or supply --nuget-source <feed>.\nOffline mode cannot download dependencies missing from the cache.\n' >&2
    exit 1
  fi
fi

printf '\nBuilding and testing...\n'
dotnet build "$Solution" --configuration "$Configuration" --no-restore
dotnet test "$Solution" --configuration "$Configuration" --no-build --no-restore

printf '\nPacking local NuGet packages...\n'
dotnet pack "$Solution" --configuration "$Configuration" --no-build --no-restore --output "$Artifacts"
if [[ ! -f "$Artifacts/$PackageId.$Version.nupkg" ]]; then
  printf 'The expected tool package was not produced: %s\n' "$Artifacts/$PackageId.$Version.nupkg" >&2
  exit 1
fi

if [[ "$Scope" == "global" ]]; then
  ToolScope=(--global)
  ToolDirectory="$DotnetHome/.dotnet/tools"
else
  ToolDirectory="$Artifacts/tool"
  ToolScope=(--tool-path "$ToolDirectory")
fi

mkdir -p -- "$ToolDirectory"
InstallCache="$(mktemp -d "$Artifacts/.install-cache.XXXXXX")"
InstalledTools="$(dotnet tool list "${ToolScope[@]}")"
if printf '%s\n' "$InstalledTools" | awk -v package="$PackageId" 'tolower($1) == tolower(package) { found = 1 } END { exit !found }'; then
  printf '\nReplacing the existing %s installation with the freshly built package...\n' "$Scope"
  dotnet tool uninstall "$PackageId" "${ToolScope[@]}"
fi

printf '\nInstalling %s (%s)...\n' "$PackageId" "$Scope"
NUGET_PACKAGES="$InstallCache" dotnet tool install "$PackageId" \
  "${ToolScope[@]}" --version "$Version" --configfile "$ProjectRoot/NuGet.Local.Config"

if [[ ! -x "$ToolDirectory/$ToolCommand" ]]; then
  printf 'Installation returned without the expected executable: %s\n' "$ToolDirectory/$ToolCommand" >&2
  exit 1
fi
"$ToolDirectory/$ToolCommand" --help >/dev/null

printf '\nInstalled Log Studio %s at %s/%s\n' "$Version" "$ToolDirectory" "$ToolCommand"
if [[ "$Scope" == "global" ]]; then
  case ":$PATH:" in
    *":$ToolDirectory:"*) ;;
    *)
      printf 'Add the .NET tools directory to PATH (and to ~/.zshrc for future terminals):\n'
      printf '  export PATH="%s:$PATH"\n' "$ToolDirectory"
      ;;
  esac
  printf '\nRun from any directory:\n  logstudio --open -- dotnet run --project ./path/to/App.csproj\n'
else
  printf '\nRun:\n  "%s/%s" --open -- dotnet run --project ./path/to/App.csproj\n' "$ToolDirectory" "$ToolCommand"
fi
