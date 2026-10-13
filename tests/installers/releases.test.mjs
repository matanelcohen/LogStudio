import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const bashInstaller = fileURLToPath(new URL("../../install-release.sh", import.meta.url));
const powershellInstaller = fileURLToPath(new URL("../../install-release.ps1", import.meta.url));
const windows = process.platform === "win32";

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: tmpdir(),
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 60000
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "logstudio release-test."));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const downloads = join(directory, "downloads");
  const tools = join(directory, "tools");
  const install = join(directory, "installed app");
  const bin = join(directory, "bin");
  mkdirSync(downloads);
  mkdirSync(tools);
  const env = { MOCK_DOWNLOAD_DIR: downloads, MOCK_LOG: join(directory, "requests"), MOCK_OS: "Linux", MOCK_ARCH: "x86_64" };
  const bash = (...args) => run("bash", [bashInstaller, "--install-dir", install, "--bin-dir", bin, ...args], { ...env, PATH: `${tools}:${process.env.PATH}` });
  const psWrapper = join(directory, "download-mock.ps1");
  writeFileSync(psWrapper, `
param([string]$Version = "latest")
function Invoke-WebRequest {
  param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile)
  if ($Uri -notlike "https://github.com/matanelcohen/LogStudio/releases/*") { throw "Unexpected download URL: $Uri" }
  Add-Content -LiteralPath $env:MOCK_LOG -Value $Uri
  Copy-Item -LiteralPath (Join-Path $env:MOCK_DOWNLOAD_DIR ([Uri]$Uri).Segments[-1]) -Destination $OutFile
}
& $env:MOCK_INSTALLER -InstallDir $env:MOCK_INSTALL_DIR -Version $Version
exit $LASTEXITCODE
`);
  const powershell = (...args) => run("pwsh", ["-NoProfile", "-File", psWrapper, ...args], {
    ...env, MOCK_INSTALLER: powershellInstaller, MOCK_INSTALL_DIR: install
  });
  if (!windows) {
    writeFileSync(join(tools, "uname"), '#!/bin/sh\ncase "$1" in -s) echo "$MOCK_OS";; -m) echo "$MOCK_ARCH";; *) exit 1;; esac\n', { mode: 0o755 });
    writeFileSync(join(tools, "curl"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output="$2"; shift ;;
    https://*) url="$1" ;;
  esac
  shift
done
echo "$url" >> "$MOCK_LOG"
cp "$MOCK_DOWNLOAD_DIR/\${url##*/}" "$output"
`, { mode: 0o755 });
  }
  return { directory, downloads, install, bin, env, bash, powershell };
}

function checksum(f, asset, hash) {
  const digest = hash || createHash("sha256").update(readFileSync(join(f.downloads, asset))).digest("hex");
  writeFileSync(join(f.downloads, `${asset}.sha256`), `${digest}  ${asset}\n`);
}

function unixArchive(f, rid = "linux-x64", executable = true) {
  const payload = join(f.directory, `payload-${rid}`);
  mkdirSync(payload);
  writeFileSync(join(payload, "LogStudio.dll"), "fixture");
  if (executable) writeFileSync(join(payload, "logstudio"), '#!/bin/sh\n[ "$1" = "--help" ]\n', { mode: 0o755 });
  const asset = `logstudio-${rid}.tar.gz`;
  const result = run("tar", ["-czf", join(f.downloads, asset), "-C", payload, "."]);
  assert.equal(result.status, 0, result.stderr);
  checksum(f, asset);
  return asset;
}

test("release installer help needs no SDK, repository checkout, or downloads", () => {
  for (const [command, args] of [
    ["pwsh", ["-NoProfile", "-File", powershellInstaller, "-Help"]],
    ...(!windows ? [["bash", [bashInstaller, "--help"]]] : [])
  ]) {
    const result = run(command, args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /compiled/);
    assert.match(result.stdout, /[Vv]ersion/);
  }
});

test("release installers reject unsafe tags before downloading", (t) => {
  const f = fixture(t);
  for (const tag of ["../main", "v0.1.0;echo unsafe", "v1", "v1.2.3/other"]) {
    const ps = f.powershell("-Version", tag);
    assert.notEqual(ps.status, 0);
    assert.match(ps.stderr, /Expected a release tag/);
    if (!windows) assert.equal(f.bash("--version", tag).status, 2);
  }
  assert.equal(existsSync(f.env.MOCK_LOG), false);
});

test("Bash validates options before downloads", { skip: windows }, (t) => {
  const f = fixture(t);
  for (const args of [["--version"], ["--bin-dir"], ["--install-dir", "--help"], ["--unknown"]]) {
    assert.equal(f.bash(...args).status, 2);
  }
  assert.equal(existsSync(f.env.MOCK_LOG), false);
});

for (const [os, arch, rid] of [
  ["Linux", "x86_64", "linux-x64"], ["Linux", "aarch64", "linux-arm64"],
  ["Darwin", "x86_64", "osx-x64"], ["Darwin", "arm64", "osx-arm64"]
]) {
  test(`Bash installs verified ${rid} archives into paths with spaces`, { skip: windows }, (t) => {
    const f = fixture(t);
    f.env.MOCK_OS = os;
    f.env.MOCK_ARCH = arch;
    const asset = unixArchive(f, rid);
    const result = f.bash("--version", "v0.1.0-rc.1");
    assert.equal(result.status, 0, result.stderr);
    const link = readlinkSync(join(f.bin, "logstudio"));
    assert.equal(existsSync(link), true);
    assert.match(readFileSync(f.env.MOCK_LOG, "utf8"), new RegExp(`/releases/download/v0\\.1\\.0-rc\\.1/${asset}`));
    assert.equal(run(join(f.bin, "logstudio"), ["--help"]).status, 0);
    assert.equal(f.bash().status, 0);
    assert.notEqual(readlinkSync(join(f.bin, "logstudio")), link);
    assert.equal(existsSync(link), true, "updates retain the previous verified release");
    assert.match(readFileSync(f.env.MOCK_LOG, "utf8"), /releases\/latest\/download/);
  });
}

test("Bash checksum failure leaves an existing installation untouched", { skip: windows }, (t) => {
  const f = fixture(t);
  const asset = unixArchive(f);
  assert.equal(f.bash().status, 0);
  const original = readlinkSync(join(f.bin, "logstudio"));
  checksum(f, asset, "0".repeat(64));
  const result = f.bash();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum verification failed/);
  assert.equal(readlinkSync(join(f.bin, "logstudio")), original);
  assert.equal(readdirSync(f.install).length, 1);
});

test("Bash aborts on missing downloads and unsupported platforms", { skip: windows }, (t) => {
  const f = fixture(t);
  assert.notEqual(f.bash().status, 0);
  assert.equal(existsSync(f.install), false);
  for (const [os, arch] of [["FreeBSD", "x86_64"], ["Linux", "i686"]]) {
    f.env.MOCK_OS = os;
    f.env.MOCK_ARCH = arch;
    assert.match(f.bash().stderr, /Unsupported/);
  }
});

test("Bash refuses unrelated executables and incomplete archives", { skip: windows }, (t) => {
  const f = fixture(t);
  unixArchive(f, "linux-x64", false);
  assert.match(f.bash().stderr, /archive is missing/);
  assert.equal(readdirSync(f.install).length, 0);
  mkdirSync(f.bin, { recursive: true });
  writeFileSync(join(f.bin, "logstudio"), "unrelated");
  assert.match(f.bash().stderr, /Refusing to replace/);
  assert.equal(readFileSync(join(f.bin, "logstudio"), "utf8"), "unrelated");
});

test("Windows checksum failure installs nothing", { skip: !windows }, (t) => {
  const f = fixture(t);
  const cpu = process.env.PROCESSOR_ARCHITEW6432 || process.env.PROCESSOR_ARCHITECTURE;
  const asset = `logstudio-win-${cpu === "ARM64" ? "arm64" : "x64"}.zip`;
  writeFileSync(join(f.downloads, asset), "corrupt");
  checksum(f, asset, "0".repeat(64));
  const result = f.powershell();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum verification failed/);
  assert.equal(existsSync(f.install), false);
});

test("Windows rejects traversal entries before extraction", { skip: !windows }, (t) => {
  const f = fixture(t);
  const cpu = process.env.PROCESSOR_ARCHITEW6432 || process.env.PROCESSOR_ARCHITECTURE;
  const asset = `logstudio-win-${cpu === "ARM64" ? "arm64" : "x64"}.zip`;
  const create = run("pwsh", ["-NoProfile", "-Command", `
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::Open($env:MOCK_ARCHIVE, [IO.Compression.ZipArchiveMode]::Create)
    [void]$zip.CreateEntry("../escaped.txt")
    $zip.Dispose()
  `], { MOCK_ARCHIVE: join(f.downloads, asset) });
  assert.equal(create.status, 0, create.stderr);
  checksum(f, asset);
  const result = f.powershell();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe paths/);
  assert.equal(existsSync(f.install), false);
});

test("compiled archive installs and runs without an installed .NET runtime", { skip: !process.env.LOGSTUDIO_TEST_ARCHIVE }, (t) => {
  const f = fixture(t);
  const rid = process.env.LOGSTUDIO_TEST_RID;
  if (!windows) {
    f.env.MOCK_OS = rid.startsWith("osx-") ? "Darwin" : "Linux";
    f.env.MOCK_ARCH = rid.endsWith("-arm64") ? "arm64" : "x86_64";
  }
  const asset = `logstudio-${rid}${windows ? ".zip" : ".tar.gz"}`;
  cpSync(process.env.LOGSTUDIO_TEST_ARCHIVE, join(f.downloads, asset));
  checksum(f, asset);
  const result = windows ? f.powershell() : f.bash();
  assert.equal(result.status, 0, result.stderr);
  const executable = windows
    ? join(f.install, readdirSync(f.install).find((name) => name.startsWith("release.")), "logstudio.exe")
    : join(f.bin, "logstudio");
  const help = run(executable, ["--help"], { DOTNET_ROOT: join(f.directory, "no-dotnet"), DOTNET_MULTILEVEL_LOOKUP: "0" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /logstudio/i);
  const update = windows ? f.powershell("-Version", "v0.1.0") : f.bash("--version", "v0.1.0");
  assert.equal(update.status, 0, update.stderr);
  if (windows) {
    const launcher = join(f.install, "bin", "logstudio.cmd");
    assert.match(readFileSync(launcher, "utf8"), /%~dp0/);
    const launched = run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${launcher}" --help"`]);
    assert.equal(launched.status, 0, launched.stderr);
  }
});
