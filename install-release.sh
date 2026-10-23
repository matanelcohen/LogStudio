#!/usr/bin/env bash
set -euo pipefail

readonly Repository="https://github.com/matanelcohen/LogStudio"
Version="latest"
InstallDir=""
BinDir="${HOME}/.local/bin"
Desktop=false
TemporaryDir=""
ReleaseDir=""
Installed=false
LauncherPath=""
PreviousLauncher=""
LauncherLinked=false

usage() {
  printf '%s\n' \
    "Download and install a compiled Log Studio release (no SDK or Node.js required)." \
    "Usage: bash install-release.sh [--desktop] [--version X.Y.Z] [--install-dir <directory>] [--bin-dir <directory>]" \
    "Supports Linux (glibc) and macOS, on x64 and ARM64. No sudo or shell-profile edits." \
    "Defaults: latest release, ~/.local/share/logstudio, ~/.local/bin." \
    "  --desktop  Install the standalone desktop app separately in ~/.local/share/logstudio-desktop." \
    "             Adds a per-user application launcher and logstudio-desktop; leaves the CLI unchanged." \
    "             Requires system WebKitGTK on Linux. No OS dependencies are installed." \
    "  --help  Show this help without downloading anything."
}

cleanup() {
  if [[ "$Installed" != true && "$LauncherLinked" == true ]]; then
    rm -f -- "$LauncherPath"
    if [[ -n "$PreviousLauncher" ]]; then ln -s "$PreviousLauncher" "$LauncherPath"; fi
  fi
  if [[ -n "$TemporaryDir" ]]; then rm -rf -- "$TemporaryDir"; fi
  if [[ "$Installed" != true && -n "$ReleaseDir" ]]; then rm -rf -- "$ReleaseDir"; fi
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version|--install-dir|--bin-dir)
      if [[ $# -lt 2 || -z "$2" || "$2" == --* ]]; then
        printf '%s requires a value.\n' "$1" >&2; exit 2
      fi
      case "$1" in
        --version) Version="$2" ;;
        --install-dir) InstallDir="$2" ;;
        --bin-dir) BinDir="$2" ;;
      esac
      shift ;;
    --help|-h) usage; exit 0 ;;
    --desktop) Desktop=true ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [[ "$Version" != latest && ! "$Version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]; then
  printf 'Expected a release tag such as 1.0.2 or 1.0.2-rc.1, without a v prefix.\n' >&2; exit 2
fi
case "$(uname -s)" in
  Linux) Platform="linux" ;;
  Darwin) Platform="osx" ;;
  *) printf 'Unsupported OS. On Windows, use install-release.ps1.\n' >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) Architecture="x64" ;;
  aarch64|arm64) Architecture="arm64" ;;
  *) printf 'Unsupported CPU architecture; releases support x64 and ARM64.\n' >&2; exit 1 ;;
esac
for Tool in curl tar; do
  if ! command -v "$Tool" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$Tool" >&2; exit 1
  fi
done
if command -v sha256sum >/dev/null 2>&1; then
  HashCommand=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
  HashCommand=(shasum -a 256)
else
  printf 'SHA-256 verification requires sha256sum or shasum.\n' >&2; exit 1
fi

Application="logstudio"
ExecutableName="logstudio"
ReleasePrefix="release"
if [[ "$Desktop" == true ]]; then
  Application="logstudio-desktop"
  ExecutableName="LogStudio.Desktop"
  ReleasePrefix="desktop-release"
fi
if [[ -z "$InstallDir" ]]; then InstallDir="${HOME}/.local/share/$Application"; fi
Asset="$Application-$Platform-$Architecture.tar.gz"
if [[ "$Version" == latest ]]; then
  DownloadUrl="$Repository/releases/latest/download"
else
  DownloadUrl="$Repository/releases/download/$Version"
fi
TemporaryDir="$(mktemp -d "${TMPDIR:-/tmp}/logstudio-download.XXXXXX")"
printf 'Downloading %s (%s)...\n' "$Asset" "$Version"
for File in "$Asset" "$Asset.sha256"; do
  curl --proto '=https' --tlsv1.2 --fail --show-error --location --retry 3 \
    "$DownloadUrl/$File" --output "$TemporaryDir/$File"
done
ExpectedHash="$(awk -v asset="$Asset" 'length($1) == 64 && $1 ~ /^[a-f0-9]+$/ && ($2 == asset || $2 == "*" asset) { print $1 }' "$TemporaryDir/$Asset.sha256")"
ActualHash="$("${HashCommand[@]}" "$TemporaryDir/$Asset")"
if [[ -z "$ExpectedHash" || "$ExpectedHash" == *$'\n'* || "${ActualHash%% *}" != "$ExpectedHash" ]]; then
  printf 'Release checksum verification failed; nothing was installed.\n' >&2; exit 1
fi
tar -tzf "$TemporaryDir/$Asset" > "$TemporaryDir/contents"
if grep -Eq '(^/|(^|/)\.\.(/|$))' "$TemporaryDir/contents"; then
  printf 'The release archive contains unsafe paths.\n' >&2; exit 1
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
    LauncherPath="$HOME/Applications/Log Studio.app"
  else
    LauncherPath="${XDG_DATA_HOME:-$HOME/.local/share}/applications/logstudio-desktop.desktop"
  fi
  for Path in "$BinDir/$Application" "$LauncherPath"; do
    if [[ -L "$Path" ]]; then
      Target="$(readlink "$Path")"
      case "$Target" in "$InstallDir"/desktop-release.*/*) ;; *)
        printf 'Refusing to replace an unrelated symlink: %s\n' "$Path" >&2; exit 1 ;;
      esac
    elif [[ -e "$Path" ]]; then
      printf 'Refusing to replace an existing file or directory: %s\n' "$Path" >&2; exit 1
    fi
  done
  case "$InstallDir$BinDir$LauncherPath" in *$'\n'*|*$'\r'*)
    printf 'Desktop installation paths must not contain line breaks.\n' >&2; exit 2 ;;
  esac
fi
ReleaseDir="$(mktemp -d "$InstallDir/$ReleasePrefix.XXXXXX")"
tar -xzf "$TemporaryDir/$Asset" -C "$ReleaseDir"
Executable="$ReleaseDir/$ExecutableName"
PayloadDir="$(dirname "$Executable")"
if [[ ! -f "$Executable" || ! -f "$PayloadDir/LogStudio.dll" ]]; then
  printf 'The archive is missing the executable or LogStudio.dll.\n' >&2; exit 1
fi
if [[ "$Desktop" == true ]]; then
  if [[ ! -f "$PayloadDir/LogStudio.Desktop.dll" || "$Platform" == osx && ! -f "$ReleaseDir/Log Studio.app/Contents/Info.plist" ]]; then
    printf 'The desktop archive is missing LogStudio.Desktop.dll or bundle metadata.\n' >&2; exit 1
  fi
  NativeExtension="so"
  if [[ "$Platform" == osx ]]; then NativeExtension="dylib"; fi
  if [[ ! -f "$PayloadDir/Photino.Native.$NativeExtension" || ! -s "$PayloadDir/Photino.Native.$NativeExtension" ]]; then
    printf 'The desktop archive is missing a nonempty Photino.Native.%s.\n' "$NativeExtension" >&2; exit 1
  fi
fi
chmod +x "$Executable"
"$Executable" --help >/dev/null
if [[ "$Desktop" == true ]]; then
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
    printf '[Desktop Entry]\nType=Application\nName=Log Studio\nExec="%s"\nTerminal=false\nCategories=Development;Utility;\n' "$DesktopExec" > "$LauncherTarget"
  fi
  if [[ -L "$LauncherPath" ]]; then PreviousLauncher="$(readlink "$LauncherPath")"; fi
  ln -s "$LauncherTarget" "$TemporaryDir/desktop-launcher"
  LauncherLinked=true
  if [[ -L "$LauncherPath" ]]; then rm -- "$LauncherPath"; fi
  mv -- "$TemporaryDir/desktop-launcher" "$LauncherPath"
fi
ln -s "$Executable" "$TemporaryDir/$Application"
mv -f -- "$TemporaryDir/$Application" "$BinDir/$Application"
Installed=true
printf '\nInstalled Log Studio at %s/%s\n' "$BinDir" "$Application"
case ":$PATH:" in
  *":$BinDir:"*) ;;
  *) printf 'Add it to PATH for this terminal (and your shell profile for future terminals):\n  export PATH=%q:"$PATH"\n' "$BinDir" ;;
esac
if [[ "$Desktop" == true ]]; then
  printf 'Launch Log Studio from your applications menu or run: logstudio-desktop\n'
else
  printf 'Run: logstudio --open -- your-command\n'
fi
