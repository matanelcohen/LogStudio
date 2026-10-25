#!/usr/bin/env bash
set -euo pipefail

readonly Repository="https://github.com/matanelcohen/LogStudio"
Version="latest"
InstallDir=""
BinDir="${HOME}/.local/bin"
Applications=(logstudio logstudio-desktop)
PublishDir=""
CreateLauncher=true
TemporaryDir=""
Installed=false
ReleaseDirs=()
Executables=()
LauncherPaths=()
LauncherTargets=()
ChangedPaths=()
PreviousTargets=()
ChangedCount=0

usage() {
  printf '%s\n' \
    "Download and install a compiled Log Studio release (no SDK or Node.js required)." \
    "Usage: bash install-release.sh [--cli | --desktop] [--version X.Y.Z] [--install-dir <directory>] [--bin-dir <directory>]" \
    "Supports Linux (glibc) and macOS, on x64 and ARM64. No sudo or shell-profile edits." \
    "Installs both the CLI and desktop app by default, with per-user application launchers." \
    "Defaults: latest release, ~/.local/share/logstudio and logstudio-desktop, ~/.local/bin." \
    "  --cli      Install only the CLI (suitable for headless machines)." \
    "  --desktop  Install only the desktop app; leave the CLI unchanged." \
    "  --publish-dir <directory>  Install a local publish instead of downloading (requires --cli or --desktop)." \
    "  --no-launcher  Skip the applications-menu launcher (for project-local source installs)." \
    "Desktop requires system WebKitGTK on Linux. No OS dependencies are installed." \
    "  --help  Show this help without downloading anything."
}

cleanup() {
  if [[ "$Installed" != true ]]; then
    for ((Index = ChangedCount - 1; Index >= 0; Index--)); do
      rm -f -- "${ChangedPaths[Index]}"
      if [[ -n "${PreviousTargets[Index]}" ]]; then ln -s "${PreviousTargets[Index]}" "${ChangedPaths[Index]}"; fi
    done
    for Directory in ${ReleaseDirs[@]+"${ReleaseDirs[@]}"}; do rm -rf -- "$Directory"; done
  fi
  if [[ -n "$TemporaryDir" ]]; then rm -rf -- "$TemporaryDir"; fi
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version | --install-dir | --bin-dir | --publish-dir)
      if [[ $# -lt 2 || -z "$2" || "$2" == --* ]]; then
        printf '%s requires a value.\n' "$1" >&2
        exit 2
      fi
      case "$1" in
        --version) Version="$2" ;;
        --install-dir) InstallDir="$2" ;;
        --bin-dir) BinDir="$2" ;;
        --publish-dir) PublishDir="$2" ;;
      esac
      shift
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    --cli | --desktop)
      if [[ ${#Applications[@]} -eq 1 ]]; then
        printf 'Choose only one of --cli and --desktop.\n' >&2
        exit 2
      fi
      if [[ "$1" == --cli ]]; then Applications=(logstudio); else Applications=(logstudio-desktop); fi
      ;;
    --no-launcher) CreateLauncher=false ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done
if [[ -n "$PublishDir" && ${#Applications[@]} -ne 1 ]]; then
  printf '%s\n' '--publish-dir requires --cli or --desktop.' >&2
  exit 2
fi
if [[ -n "$PublishDir" ]]; then PublishDir="$(cd "$PublishDir" && pwd)"; fi

if [[ "$Version" != latest && ! "$Version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]; then
  printf 'Expected a release tag such as 1.0.2 or 1.0.2-rc.1, without a v prefix.\n' >&2
  exit 2
fi
case "$(uname -s)" in
  Linux) Platform="linux" ;;
  Darwin) Platform="osx" ;;
  *)
    printf 'Unsupported OS. On Windows, use install-release.ps1.\n' >&2
    exit 1
    ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) Architecture="x64" ;;
  aarch64 | arm64) Architecture="arm64" ;;
  *)
    printf 'Unsupported CPU architecture; releases support x64 and ARM64.\n' >&2
    exit 1
    ;;
esac
RequiredTools=()
if [[ -z "$PublishDir" ]]; then RequiredTools=(curl tar); fi
for Tool in ${RequiredTools[@]+"${RequiredTools[@]}"}; do
  if ! command -v "$Tool" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$Tool" >&2
    exit 1
  fi
done
if [[ -n "$PublishDir" ]]; then
  HashCommand=()
elif command -v sha256sum >/dev/null 2>&1; then
  HashCommand=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
  HashCommand=(shasum -a 256)
else
  printf 'SHA-256 verification requires sha256sum or shasum.\n' >&2
  exit 1
fi

if [[ "$Version" == latest ]]; then
  DownloadUrl="$Repository/releases/latest/download"
else
  DownloadUrl="$Repository/releases/download/$Version"
fi
TemporaryDir="$(mktemp -d "${TMPDIR:-/tmp}/logstudio-download.XXXXXX")"
RequestedInstallDir="$InstallDir"
for Application in "${Applications[@]}"; do
  Desktop=false
  ExecutableName="logstudio"
  ReleasePrefix="release"
  LauncherPath=""
  LauncherTarget=""
  if [[ "$Application" == logstudio-desktop ]]; then
    Desktop=true
    ExecutableName="LogStudio.Desktop"
    ReleasePrefix="desktop-release"
  fi
  InstallDir="${RequestedInstallDir:-${HOME}/.local/share/$Application}"
  Asset="$Application-$Platform-$Architecture.tar.gz"
  if [[ -z "$PublishDir" ]]; then
    printf 'Downloading %s (%s)...\n' "$Asset" "$Version"
    for File in "$Asset" "$Asset.sha256"; do
      curl --proto '=https' --tlsv1.2 --fail --show-error --location --retry 3 \
        "$DownloadUrl/$File" --output "$TemporaryDir/$File"
    done
    ExpectedHash="$(awk -v asset="$Asset" 'length($1) == 64 && $1 ~ /^[a-f0-9]+$/ && ($2 == asset || $2 == "*" asset) { print $1 }' "$TemporaryDir/$Asset.sha256")"
    ActualHash="$("${HashCommand[@]}" "$TemporaryDir/$Asset")"
    if [[ -z "$ExpectedHash" || "$ExpectedHash" == *$'\n'* || "${ActualHash%% *}" != "$ExpectedHash" ]]; then
      printf 'Release checksum verification failed; nothing was installed.\n' >&2
      exit 1
    fi
    tar -tzf "$TemporaryDir/$Asset" >"$TemporaryDir/contents"
    if grep -Eq '(^/|(^|/)\.\.(/|$))' "$TemporaryDir/contents"; then
      printf 'The release archive contains unsafe paths.\n' >&2
      exit 1
    fi
  fi

  mkdir -p -- "$InstallDir" "$BinDir"
  InstallDir="$(cd "$InstallDir" && pwd)"
  BinDir="$(cd "$BinDir" && pwd)"
  if [[ -e "$BinDir/$Application" && ! -L "$BinDir/$Application" || -d "$BinDir/$Application" ]]; then
    printf 'Refusing to replace an existing file or directory: %s/%s\nChoose another --bin-dir.\n' "$BinDir" "$Application" >&2
    exit 1
  fi
  if [[ "$Desktop" == true ]]; then
    if [[ "$Platform" == osx ]]; then
      ExecutableName="Log Studio.app/Contents/MacOS/LogStudio.Desktop"
      if [[ "$CreateLauncher" == true ]]; then LauncherPath="$HOME/Applications/Log Studio.app"; fi
    elif [[ "$CreateLauncher" == true ]]; then
      LauncherPath="${XDG_DATA_HOME:-$HOME/.local/share}/applications/logstudio-desktop.desktop"
    fi
    for Path in "$BinDir/$Application" "$LauncherPath"; do
      if [[ -z "$Path" ]]; then continue; fi
      if [[ -L "$Path" ]]; then
        Target="$(readlink "$Path")"
        case "$Target" in "$InstallDir"/desktop-release.*/*) ;; *)
          printf 'Refusing to replace an unrelated symlink: %s\n' "$Path" >&2
          exit 1
          ;;
        esac
      elif [[ -e "$Path" ]]; then
        printf 'Refusing to replace an existing file or directory: %s\n' "$Path" >&2
        exit 1
      fi
    done
    case "$InstallDir$BinDir$LauncherPath" in *$'\n'* | *$'\r'*)
      printf 'Desktop installation paths must not contain line breaks.\n' >&2
      exit 2
      ;;
    esac
  fi
  ReleaseDir="$(mktemp -d "$InstallDir/$ReleasePrefix.XXXXXX")"
  ReleaseDirs+=("$ReleaseDir")
  if [[ -n "$PublishDir" ]]; then
    cp -R "$PublishDir/." "$ReleaseDir/"
  else
    tar -xzf "$TemporaryDir/$Asset" -C "$ReleaseDir"
  fi
  Executable="$ReleaseDir/$ExecutableName"
  PayloadDir="$(dirname "$Executable")"
  if [[ ! -f "$Executable" || ! -f "$PayloadDir/LogStudio.dll" ]]; then
    printf 'The archive is missing the executable or LogStudio.dll.\n' >&2
    exit 1
  fi
  if [[ "$Desktop" == true ]]; then
    if [[ ! -f "$PayloadDir/LogStudio.Desktop.dll" || "$Platform" == osx && ! -f "$ReleaseDir/Log Studio.app/Contents/Info.plist" ]]; then
      printf 'The desktop archive is missing LogStudio.Desktop.dll or bundle metadata.\n' >&2
      exit 1
    fi
    NativeExtension="so"
    if [[ "$Platform" == osx ]]; then NativeExtension="dylib"; fi
    NativeLibrary="$PayloadDir/Photino.Native.$NativeExtension"
    if [[ -n "$PublishDir" && ! -f "$NativeLibrary" ]]; then NativeLibrary="$PayloadDir/runtimes/$Platform-$Architecture/native/Photino.Native.$NativeExtension"; fi
    if [[ ! -f "$NativeLibrary" || ! -s "$NativeLibrary" ]]; then
      printf 'The desktop archive is missing a nonempty Photino.Native.%s.\n' "$NativeExtension" >&2
      exit 1
    fi
    if [[ "$Platform" == osx && -s "$PayloadDir/logstudio.icns" ]]; then
      Resources="$ReleaseDir/Log Studio.app/Contents/Resources"
      mkdir -p -- "$Resources"
      cp "$PayloadDir/logstudio.icns" "$Resources/logstudio.icns"
    fi
  fi
  chmod +x "$Executable"
  "$Executable" --help >/dev/null
  if [[ -n "$LauncherPath" ]]; then
    mkdir -p -- "$(dirname "$LauncherPath")"
    if [[ "$Platform" == osx ]]; then
      LauncherTarget="$ReleaseDir/Log Studio.app"
    else
      LauncherTarget="$ReleaseDir/logstudio-desktop.desktop"
      DesktopExec="${Executable//\\/\\\\}"
      DesktopExec="${DesktopExec//\"/\\\"}"
      DesktopExec="${DesktopExec//\$/\\\$}"
      DesktopExec="${DesktopExec//\`/\\\`}"
      DesktopExec="${DesktopExec//\\/\\\\}"
      DesktopExec="${DesktopExec//%/%%}"
      DesktopIcon="${PayloadDir//\\/\\\\}/logstudio.png"
      printf '[Desktop Entry]\nType=Application\nName=Log Studio\nExec="%s"\nTerminal=false\nCategories=Development;Utility;\n' "$DesktopExec" >"$LauncherTarget"
      if [[ -s "$PayloadDir/logstudio.png" ]]; then printf 'Icon=%s\n' "$DesktopIcon" >>"$LauncherTarget"; fi
    fi
  fi
  Executables+=("$Executable")
  LauncherPaths+=("$LauncherPath")
  LauncherTargets+=("$LauncherTarget")
done

replace_link() {
  local Path="$1" Target="$2" Previous=""
  if [[ -L "$Path" ]]; then Previous="$(readlink "$Path")"; fi
  ln -s "$Target" "$TemporaryDir/link"
  ChangedPaths+=("$Path")
  PreviousTargets+=("$Previous")
  ChangedCount=$((ChangedCount + 1))
  if [[ -L "$Path" ]]; then rm -- "$Path"; fi
  mv -f -- "$TemporaryDir/link" "$Path"
}
for ((Index = 0; Index < ${#Applications[@]}; Index++)); do
  replace_link "$BinDir/${Applications[Index]}" "${Executables[Index]}"
  if [[ -n "${LauncherPaths[Index]}" ]]; then
    replace_link "${LauncherPaths[Index]}" "${LauncherTargets[Index]}"
  fi
done
Installed=true
for Application in "${Applications[@]}"; do printf '\nInstalled Log Studio at %s/%s\n' "$BinDir" "$Application"; done
case ":$PATH:" in
  *":$BinDir:"*) ;;
  *) printf 'Add it to PATH for this terminal (and your shell profile for future terminals):\n  export PATH=%q:"$PATH"\n' "$BinDir" ;;
esac
for Application in "${Applications[@]}"; do
  if [[ "$Application" == logstudio-desktop ]]; then
    printf 'Launch Log Studio%s or run: logstudio-desktop\n' "$(if [[ "$CreateLauncher" == true ]]; then printf ' from your applications menu'; fi)"
  else
    printf 'Run: logstudio --open -- your-command\n'
  fi
done
