# Log Studio

Turn your C# / .NET app or console command into a live, searchable log workspace.
Choose a running app in a native desktop window, or keep using the command-line browser viewer.

## Install

### Desktop app (Photino.NET)

Install the standalone app, then launch **Log Studio** from your applications menu—no terminal required.
It starts in `--listen-all` mode: choose **Running app** to capture new `ILogger` events.
Closing the window disconnects capture without stopping your application.

**macOS / Linux:**

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/matanelcohen/LogStudio/releases/latest/download/install-release.sh | bash -s -- --desktop
```

**Windows PowerShell:**

```powershell
$installer = Join-Path $env:TEMP "logstudio-install-release.ps1"
Invoke-WebRequest -UseBasicParsing https://github.com/matanelcohen/LogStudio/releases/latest/download/install-release.ps1 -OutFile $installer
& $installer -Desktop
```

Self-contained releases support x64 and ARM64. Windows needs the **Microsoft Edge WebView2 Runtime**;
Linux needs **GTK 3, WebKitGTK 4.1, and libnotify** (on Ubuntu/Debian:
`sudo apt install libgtk-3-0 libwebkit2gtk-4.1-0 libnotify4`). macOS uses the system WebKit.
These prerequisites are not installed automatically. The app and its embedded viewer work offline.
See [desktop installation](docs/guide.md#install-the-desktop-app) for launchers, updates, and uninstalling.

### CLI: macOS / Linux

Install the latest compiled release without cloning, building, or installing .NET or Node.js:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://github.com/matanelcohen/LogStudio/releases/latest/download/install-release.sh | bash
```

Supports x64 and ARM64. Linux requires glibc (not Alpine/musl) and the
[native dependencies required by .NET](https://learn.microsoft.com/dotnet/core/install/linux).
The installer verifies the release's SHA-256 checksum and links `logstudio` into
`~/.local/bin`. If that directory is not in PATH, use the command printed by the installer.
No sudo or shell-profile changes are needed.

### CLI: Windows

Run in PowerShell without an administrator shell:

```powershell
$installer = Join-Path $env:TEMP "logstudio-install-release.ps1"
Invoke-WebRequest -UseBasicParsing https://github.com/matanelcohen/LogStudio/releases/latest/download/install-release.ps1 -OutFile $installer
& $installer
```

Supports x64 and ARM64, verifies the release's SHA-256 checksum, and installs to
`%LOCALAPPDATA%\LogStudio`. PATH is updated for the current PowerShell session only.
For execution-policy guidance, pinned versions, custom directories, or uninstall steps,
see the [installation guide](docs/guide.md#install-a-compiled-release-fastest).
Checksums detect corrupt downloads; they are not independent signatures. Download and
inspect the installer first if you do not want to pipe a remote script into Bash.

### Run your command

The CLI is still available separately: omit `--desktop` / `-Desktop` when installing.
Desktop installation does not replace an existing CLI installation.

```bash
logstudio --open -- dotnet run --project ./path/to/App.csproj
```

Keep using your existing command after `--`. The wrapped command still needs its own
dependencies; for example, `dotnet run` requires your application's .NET SDK.
The viewer opens locally in your browser. Without `--open`, open the URL printed in the terminal.
The CLI uses port `5177` on each run so browser settings carry over. If that port is busy,
choose **Already running** to exit without launching a duplicate, or **New port** to start
separately. Use `--port 0` for automatic port selection, especially in scripts.

When the wrapped program asks for input, use **Terminal input** below the logs and press
Enter or **Send input**. Each submission sends one line to the program, just like typing
in the original terminal. See [interactive input](docs/guide.md#interactive-input) for limitations.

To choose an already-running .NET app instead of wrapping a command:

```bash
logstudio --listen-all --open
```

Choose an app from **Running app** in the viewer. Nothing is attached automatically.
Search by name, path, or PID. Related `dotnet run` / `dotnet watch` processes appear
as one app, with their paths and PIDs; selecting it captures the group together.
This mode captures new `ILogger` events from apps with the .NET logging EventSource
provider enabled; it cannot recover existing stdout/stderr. See the
[running-app guide](docs/guide.md#choose-a-running-net-app).

### Install from source

Requires the **.NET 10 SDK** selected by `global.json` and **Node.js 22.12+** with npm.

```bash
git clone https://github.com/matanelcohen/LogStudio.git
cd LogStudio
```

On macOS / Linux, run `./install.sh`. On Windows PowerShell, run `.\install.ps1`.
The installer builds, verifies, and installs the tool for your user.
See the [source installation guide](docs/guide.md#build-test-and-install-from-source) for details.

## Logs

![Log Studio's log explorer in dark mode with search results, a visible-page timeline, and a selected log's inspector](docs/design/discover-dark.png)

Search and filter your logs, then select an entry to inspect its details alongside the results.
The screenshot uses synthetic local demo logs. The optional timeline covers the visible page only.

See the [user guide](docs/guide.md) for search, saved sessions, imports and exports, optional
Copilot log chat, configuration, and development instructions.
