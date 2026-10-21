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
const releaseWorkflow = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
const releaseRids = ["linux-x64", "linux-arm64", "osx-x64", "osx-arm64", "win-x64", "win-arm64"];
const windows = process.platform === "win32";

function run(command, args, env = {}, options = {}) {
  const result = spawnSync(command, args, {
    cwd: tmpdir(),
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 60000,
    ...options
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

test("release installers reject unsafe and prefixed tags before downloading", (t) => {
  const f = fixture(t);
  for (const tag of ["../main", "1.0.2;echo unsafe", "1", "1.2.3/other", "v1.0.2", "V1.0.2", "v1.0.3-rc.1"]) {
    const ps = f.powershell("-Version", tag);
    assert.notEqual(ps.status, 0);
    assert.match(ps.stderr, /Expected a release tag/);
    if (!windows) assert.equal(f.bash("--version", tag).status, 2);
  }
  assert.equal(existsSync(f.env.MOCK_LOG), false);
});

test("PowerShell accepts unprefixed versions before checking the Windows platform", { skip: windows }, (t) => {
  const f = fixture(t);
  for (const version of ["1.0.2", "1.0.3", "1.0.3-rc.1"]) {
    const result = f.powershell("-Version", version);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Use install-release\.sh on macOS or Linux/);
  }
  assert.equal(existsSync(f.env.MOCK_LOG), false);
});

test("release workflow uses unprefixed tags without normalizing manual input", () => {
  assert.match(releaseWorkflow, /tags: \["\[0-9\]\*\.\[0-9\]\*\.\[0-9\]\*"\]/);
  assert.match(releaseWorkflow, /ref: refs\/tags\/\$\{\{ inputs\.tag \|\| github\.ref_name \}\}/);
  assert.match(releaseWorkflow, /RELEASE_TAG: \$\{\{ inputs\.tag \|\| github\.ref_name \}\}/);
  assert.doesNotMatch(releaseWorkflow, /startsWith\(inputs\.tag, 'v'\)|format\('v\{0\}'/);
});

test("release matrix builds every installer target without macOS runners", () => {
  const targets = new Map([...releaseWorkflow.matchAll(/^\s+- os: (\S+)\n\s+rid: (\S+)/gm)]
    .map(([, os, rid]) => [rid, os]));
  assert.deepEqual([...targets.keys()].sort(), [...releaseRids].sort());
  for (const rid of releaseRids) {
    assert.equal(targets.get(rid), rid.startsWith("win-") ? "windows-latest" : "ubuntu-latest", rid);
  }
});

test("release publication requires every archive and checksum", { skip: windows }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "logstudio-release-assets."));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const match = releaseWorkflow.match(/      - name: Verify release assets\n        shell: bash\n        run: \|\n((?:          .*\n)+)/);
  assert.ok(match, "Release assets must be verified before publication");
  assert.ok(releaseWorkflow.indexOf("- name: Verify release assets") < releaseWorkflow.indexOf("- name: Publish GitHub Release"));
  const script = match[1].replace(/^          /gm, "");
  const assets = releaseRids.flatMap((rid) => {
    const archive = `logstudio-${rid}.${rid.startsWith("win-") ? "zip" : "tar.gz"}`;
    return [archive, `${archive}.sha256`];
  });
  const downloads = join(directory, "artifacts", "release");
  mkdirSync(downloads, { recursive: true });
  for (const asset of assets) writeFileSync(join(downloads, asset), "fixture");
  const verify = () => run("bash", ["-euo", "pipefail", "-c", script], {}, { cwd: directory });
  assert.equal(verify().status, 0);
  for (const asset of assets) {
    const path = join(downloads, asset);
    rmSync(path);
    const missing = verify();
    assert.notEqual(missing.status, 0, asset);
    assert.ok(missing.stderr.includes(`Missing release asset: ${asset}`));
    writeFileSync(path, "");
    assert.notEqual(verify().status, 0, `Empty asset: ${asset}`);
    writeFileSync(path, "fixture");
  }
});

test("release validation requires the exact unprefixed package version", { skip: windows }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "logstudio-version-test."));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const match = releaseWorkflow.match(/      - name: Validate release tag and package version\n[\s\S]*?        run: \|\n((?:          .*\n)+)/);
  assert.ok(match, "Release tag validation step must exist");
  const script = match[1].replace(/^          /gm, "");
  const cases = [
    { tag: "1.0.2", version: "1.0.2", valid: true },
    { tag: "1.0.3", version: "1.0.3", valid: true },
    { tag: "1.0.3-rc.1", version: "1.0.3-rc.1", valid: true },
    { tag: "v1.0.2", version: "1.0.2", error: /Expected an unprefixed/ },
    { tag: "V1.0.2", version: "1.0.2", error: /Expected an unprefixed/ },
    { tag: "v1.0.3-rc.1", version: "1.0.3-rc.1", error: /Expected an unprefixed/ },
    { tag: "1.0.3", version: "1.0.2", error: /Tag must match/ },
    { tag: "1.0.2", version: "1.0.2", existingTag: "1.0.1" },
    { tag: "1.0", version: "1.0", error: /Expected an unprefixed/ }
  ];
  for (const [index, { tag, version, valid, error, existingTag = tag }] of cases.entries()) {
    const output = join(directory, `output-${index}`);
    const result = run("bash", ["-euo", "pipefail", "-c", `
git() { [[ "$*" == "show-ref --verify refs/tags/$EXISTING_TAG" ]]; }
dotnet() { printf '%s\\n' "$PACKAGE_VERSION"; }
${script}
`], { RELEASE_TAG: tag, PACKAGE_VERSION: version, EXISTING_TAG: existingTag, GITHUB_OUTPUT: output });
    if (valid) {
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(readFileSync(output, "utf8"), `tag=${tag}\n`);
    } else {
      assert.notEqual(result.status, 0, tag);
      if (error) assert.match(result.stdout + result.stderr, error);
      assert.equal(existsSync(output), false);
    }
  }
});

test("Bash validates options before downloads", { skip: windows }, (t) => {
  const f = fixture(t);
  for (const args of [["--version"], ["--bin-dir"], ["--install-dir", "--help"], ["--unknown"]]) {
    assert.equal(f.bash(...args).status, 2);
  }
  assert.equal(existsSync(f.env.MOCK_LOG), false);
});

test("Bash installer also works when piped to bash -s", { skip: windows }, (t) => {
  const f = fixture(t);
  unixArchive(f);
  const result = run("bash", ["-s", "--", "--install-dir", f.install, "--bin-dir", f.bin], {
    ...f.env, PATH: `${join(f.directory, "tools")}:${process.env.PATH}`
  }, { input: readFileSync(bashInstaller, "utf8") });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(run(join(f.bin, "logstudio"), ["--help"]).status, 0);
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
    const result = f.bash("--version", "1.0.3-rc.1");
    assert.equal(result.status, 0, result.stderr);
    const link = readlinkSync(join(f.bin, "logstudio"));
    assert.equal(existsSync(link), true);
    assert.ok(readFileSync(f.env.MOCK_LOG, "utf8").includes(`/releases/download/1.0.3-rc.1/${asset}`));
    assert.equal(run(join(f.bin, "logstudio"), ["--help"]).status, 0);
    assert.equal(f.bash().status, 0);
    assert.notEqual(readlinkSync(join(f.bin, "logstudio")), link);
    assert.equal(existsSync(link), true, "updates retain the previous verified release");
    assert.match(readFileSync(f.env.MOCK_LOG, "utf8"), /releases\/latest\/download/);
  });
}

test("Bash downloads stable releases using the exact unprefixed version", { skip: windows }, (t) => {
  const f = fixture(t);
  const asset = unixArchive(f);
  for (const version of ["1.0.2", "1.0.3"]) {
    const result = f.bash("--version", version);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(readFileSync(f.env.MOCK_LOG, "utf8").includes(`/releases/download/${version}/${asset}`));
  }
});

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

test("Bash rejects absolute archive paths before extraction", { skip: windows }, (t) => {
  const f = fixture(t);
  const outside = join(f.directory, "outside.txt");
  writeFileSync(outside, "unchanged");
  const asset = "logstudio-linux-x64.tar.gz";
  const archive = run("tar", ["-czPf", join(f.downloads, asset), outside]);
  assert.equal(archive.status, 0, archive.stderr);
  checksum(f, asset);
  const result = f.bash();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe paths/);
  assert.equal(existsSync(f.install), false);
  assert.equal(readFileSync(outside, "utf8"), "unchanged");
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
  const update = windows ? f.powershell("-Version", "1.0.2") : f.bash("--version", "1.0.2");
  assert.equal(update.status, 0, update.stderr);
  if (windows) {
    const bin = join(f.install, "bin");
    assert.equal(run(join(bin, "logstudio.exe"), ["--help"]).status, 0);
    const launched = run("pwsh", ["-NoProfile", "-Command", `
      $env:PATH = "$env:MOCK_BIN;$env:PATH"
      logstudio --no-wait -- $env:MOCK_NODE -e 'process.exit(process.argv[1] === ''literal"quote'' && process.argv[2] === '''' ? 0 : 17)' 'literal"quote' ''
      exit $LASTEXITCODE
    `], { MOCK_BIN: bin, MOCK_NODE: process.execPath });
    assert.equal(launched.status, 0, launched.stderr);
  }
});
