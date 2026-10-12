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

Scope="global"
RestoreMode="cache-first"
InstallCache=""

usage() {
  printf '%s\n' \
    "Build, test, pack, and install Log Studio from local source." \
    "" \
    "Usage: ./install.sh [--global | --local] [--offline | --online]" \
    "" \
    "  --global   Install for the current user; run logstudio from anywhere (default)." \
    "  --local    Install into artifacts/tool without changing the global tool." \
    "  --offline  Require cached dependencies; never try the network." \
    "  --online   Require the configured online restore and vulnerability lookup." \
    "  --help     Show this help." \
    "" \
    "By default, restore tries cached dependencies first and reports offline verification." \
    "If cached restore fails, it retries the configured online source without suppressing errors." \
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
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if ! command -v dotnet >/dev/null 2>&1; then
  printf 'The .NET 10 SDK is required to build Log Studio. Install it, then rerun this script.\n' >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf 'Node.js 22.12+ and npm are required to build the React frontend. The installed tool remains .NET-only.\n' >&2
  exit 1
fi
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<22||(major===22&&minor<12)){console.error("Node.js 22.12 or newer is required.");process.exit(1);}'

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
  npm audit --audit-level=high
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
  if ! dotnet restore "$Solution" --configfile "$ProjectRoot/NuGet.Config"; then
    printf '\nRestore failed. If all dependencies are cached, retry with --offline.\n' >&2
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
