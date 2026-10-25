import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const bashInstaller = fileURLToPath(new URL("../../install-release.sh", import.meta.url));
const powershellInstaller = fileURLToPath(new URL("../../install-release.ps1", import.meta.url));
const releaseWorkflow = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
const releaseRids = ["linux-x64", "linux-arm64", "osx-x64", "osx-arm64", "win-x64", "win-arm64"];
const windows = process.platform === "win32";

function releaseStep(name, workflow = releaseWorkflow) {
  const match = workflow.replace(/\r\n/g, "\n").match(new RegExp(`      - name: ${name}\\n[\\s\\S]*?        run: \\|\\n((?:          .*\\n)+)`));
  assert.ok(match, name);
  return match[1].replace(/^          /gm, "");
}

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
  const home = join(directory, "user home");
  const data = join(directory, "application data");
  mkdirSync(downloads);
  mkdirSync(tools);
  mkdirSync(home);
  const env = {
    MOCK_DOWNLOAD_DIR: downloads, MOCK_LOG: join(directory, "requests"), MOCK_OS: "Linux", MOCK_ARCH: "x86_64",
    HOME: home, XDG_DATA_HOME: data, APPDATA: data, LOCALAPPDATA: data,
    TMPDIR: directory, TMP: directory, TEMP: directory
  };
  const bash = (...args) => run("bash", [bashInstaller, "--install-dir", install, "--bin-dir", bin, ...args], { ...env, PATH: `${tools}:${process.env.PATH}` });
  const psWrapper = join(directory, "download-mock.ps1");
  writeFileSync(psWrapper, `
param([string]$Version = "latest", [switch]$Desktop)
function Invoke-WebRequest {
  param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile)
  if ($Uri -notlike "https://github.com/matanelcohen/LogStudio/releases/*") { throw "Unexpected download URL: $Uri" }
  Add-Content -LiteralPath $env:MOCK_LOG -Value $Uri
  Copy-Item -LiteralPath (Join-Path $env:MOCK_DOWNLOAD_DIR ([Uri]$Uri).Segments[-1]) -Destination $OutFile
}
& $env:MOCK_INSTALLER -InstallDir $env:MOCK_INSTALL_DIR -Version $Version -Desktop:$Desktop
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
  return { directory, downloads, install, bin, home, data, env, bash, powershell };
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

function desktopArchive(f, rid = "linux-x64", missing = "") {
  const payload = join(f.directory, `desktop-payload-${rid}`);
  const mac = rid.startsWith("osx-");
  const win = rid.startsWith("win-");
  const contents = join(payload, "Log Studio.app", "Contents");
  const binaries = mac ? join(contents, "MacOS") : payload;
  mkdirSync(binaries, { recursive: true });
  for (const name of ["LogStudio.dll", "LogStudio.Desktop.dll"]) {
    if (missing !== name) writeFileSync(join(binaries, name), "fixture");
  }
  const native = `Photino.Native${win ? ".dll" : mac ? ".dylib" : ".so"}`;
  if (missing !== native) writeFileSync(join(binaries, native), missing === "empty-native" ? "" : "native fixture");
  if (missing !== "executable") {
    if (win) {
      const executable = readFileSync(process.execPath);
      const pe = executable.readUInt32LE(0x3c);
      assert.equal(executable.toString("ascii", pe, pe + 4), "PE\0\0");
      // Exercise WinExe process-wait behavior without requiring a compiler or SDK.
      executable.writeUInt16LE(2, pe + 24 + 68);
      writeFileSync(join(binaries, "LogStudio.Desktop.exe"), executable);
    }
    else writeFileSync(join(binaries, "LogStudio.Desktop"), '#!/bin/sh\n[ "$1" = "--help" ]\n', { mode: 0o755 });
  }
  if (mac && missing !== "Info.plist") {
    writeFileSync(join(contents, "Info.plist"), readFileSync(new URL("../../packaging/Info.plist", import.meta.url), "utf8").replaceAll("@VERSION@", "1.0.3"));
  }
  const asset = `logstudio-desktop-${rid}.${win ? "zip" : "tar.gz"}`;
  const result = win
    ? run("pwsh", ["-NoProfile", "-Command", "Compress-Archive -Path \"$env:MOCK_PAYLOAD/*\" -DestinationPath $env:MOCK_ARCHIVE"], { MOCK_PAYLOAD: payload, MOCK_ARCHIVE: join(f.downloads, asset) })
    : run("tar", ["-czf", join(f.downloads, asset), "-C", payload, "."]);
  assert.equal(result.status, 0, result.stderr);
  checksum(f, asset);
  return asset;
}

function windowsRid() {
  const cpu = process.env.PROCESSOR_ARCHITEW6432 || process.env.PROCESSOR_ARCHITECTURE;
  return `win-${cpu === "ARM64" ? "arm64" : "x64"}`;
}

function shortcutPath(f) {
  return join(f.data, "Microsoft", "Windows", "Start Menu", "Programs", "Log Studio.lnk");
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
    assert.match(result.stdout, /[Dd]esktop/);
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

for (const [name, lineEnding] of [["LF", "\n"], ["CRLF", "\r\n"]]) {
  test(`release matrix builds every installer target without macOS runners (${name})`, () => {
    const workflow = releaseWorkflow.replace(/\r?\n/g, lineEnding);
    const targets = new Map([...workflow.matchAll(/^\s+- os: (\S+)\r?\n\s+rid: (\S+)/gm)]
      .map(([, os, rid]) => [rid, os]));
    assert.deepEqual([...targets.keys()].sort(), [...releaseRids].sort());
    for (const rid of releaseRids) {
      assert.equal(targets.get(rid), rid.startsWith("win-") ? "windows-latest" : "ubuntu-latest", rid);
    }
  });

  test(`release packaging scripts can be extracted with ${name} line endings`, () => {
    const workflow = releaseWorkflow.replace(/\r?\n/g, lineEnding);
    for (const step of ["Publish self-contained desktop application", "Archive application and checksum", "Verify desktop archive contents"]) {
      const script = releaseStep(step, workflow);
      assert.ok(script.length > 0);
      assert.equal(script, releaseStep(step, releaseWorkflow.replace(/\r?\n/g, "\n")));
      assert.doesNotMatch(script, /\r/);
    }
  });
}

test("desktop releases preserve full self-contained publishes independently of the CLI", () => {
  assert.match(releaseWorkflow, /dotnet publish src\/LogStudio\.Desktop\/LogStudio\.Desktop\.csproj[^\n]*--self-contained true[^\n]*-p:PackAsTool=false[^\n]*-p:PublishSingleFile=false[^\n]*-p:PublishTrimmed=false/);
  assert.match(releaseWorkflow, /dotnet publish src\/LogStudio\.Tool\/LogStudio\.Tool\.csproj[^\n]*-p:PublishTrimmed=false/);
  assert.match(releaseWorkflow, /Move-Item "artifacts\/publish\/LogStudio\.Tool\$extension" "artifacts\/publish\/logstudio\$extension"/);
  assert.doesNotMatch(releaseWorkflow, /(?:Remove-Item|rm)[^\n]*LogStudio\.dll/);
  assert.match(releaseWorkflow, /LOGSTUDIO_TEST_DESKTOP_ARCHIVE/);
  const plist = readFileSync(new URL("../../packaging/Info.plist", import.meta.url), "utf8");
  assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>io\.github\.matanelcohen\.logstudio<\/string>/);
  assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>LogStudio\.Desktop<\/string>/);
  assert.match(plist, /<key>CFBundlePackageType<\/key>\s*<string>APPL<\/string>/);
  assert.match(plist, /<key>NSHighResolutionCapable<\/key>\s*<true\/>/);
  assert.match(plist, /<key>NSAppTransportSecurity<\/key>\s*<dict>\s*<key>NSAllowsLocalNetworking<\/key>\s*<true\/>/);
  assert.doesNotMatch(plist, /NSAllowsArbitraryLoads/);
  assert.match(readFileSync(powershellInstaller, "utf8"), /& \$Executable --help \| Out-Null/);
  assert.match(releaseWorkflow, /& "\.\/artifacts\/desktop-publish\/LogStudio\.Desktop\$extension" --help \| Out-Host/);
});

for (const rid of releaseRids.filter((rid) => rid.startsWith("win-") === windows)) {
  test(`release packaging retains every desktop dependency and metadata for ${rid}`, (t) => {
    const f = fixture(t);
    const sources = [
      "README.md", "src/LogStudio/dependency-notices.txt", "src/LogStudio.Desktop/dependency-notices.txt",
      "frontend/dist/third-party-notices.txt", "artifacts/publish/LogStudio.dll"
    ];
    for (const source of sources) {
      const path = join(f.directory, source);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, source);
    }
    const cli = join(f.directory, "artifacts", "publish", windows ? "logstudio.exe" : "logstudio");
    writeFileSync(cli, "CLI apphost", { mode: 0o755 });
    mkdirSync(join(f.directory, "packaging"));
    cpSync(new URL("../../packaging/Info.plist", import.meta.url), join(f.directory, "packaging", "Info.plist"));
    const publish = releaseStep("Publish self-contained desktop application");
    const archive = releaseStep("Archive application and checksum");
    const verify = releaseStep("Verify desktop archive contents");
    const result = run("pwsh", ["-NoProfile", "-Command", `
$ErrorActionPreference = "Stop"
function dotnet {
  $output = $args[[Array]::IndexOf($args, "-o") + 1]
  New-Item -ItemType Directory -Path $output -Force | Out-Null
  $extension = if ($IsWindows) { ".exe" } else { "" }
  if ($IsWindows) { Copy-Item $env:MOCK_NODE "$output/LogStudio.Desktop.exe" }
  else { [IO.File]::WriteAllText("$output/LogStudio.Desktop", "#!/bin/sh" + [char]10 + '[ "$1" = "--help" ]' + [char]10); chmod +x "$output/LogStudio.Desktop" }
  $nativeExtension = if ($env:RELEASE_RID.StartsWith("win-")) { ".dll" } elseif ($env:RELEASE_RID.StartsWith("osx-")) { ".dylib" } else { ".so" }
  foreach ($name in @("LogStudio.dll", "LogStudio.Desktop.dll", "LogStudio.Desktop.deps.json", "LogStudio.Desktop.runtimeconfig.json", "Photino.NET.dll", "Photino.Native$nativeExtension")) {
    [IO.File]::WriteAllText("$output/$name", "published dependency")
  }
  Copy-Item src/LogStudio.Desktop/dependency-notices.txt "$output/dependency-notices.txt"
  $global:LASTEXITCODE = 0
}
${publish}
${archive}
${verify}
`], { RELEASE_RID: rid, RELEASE_TAG: "1.0.3-rc.1", MOCK_NODE: process.execPath }, { cwd: f.directory });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const extension = windows ? "zip" : "tar.gz";
    for (const application of ["logstudio", "logstudio-desktop"]) {
      const name = `${application}-${rid}.${extension}`;
      const path = join(f.directory, "artifacts", "release", name);
      assert.equal(existsSync(path), true);
      const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
      assert.equal(readFileSync(`${path}.sha256`, "utf8"), `${hash}  ${name}\n`);
    }
    const extracted = join(f.directory, "extracted");
    mkdirSync(extracted);
    const path = join(f.directory, "artifacts", "release", `logstudio-desktop-${rid}.${extension}`);
    const unpack = windows
      ? run("pwsh", ["-NoProfile", "-Command", "Expand-Archive -LiteralPath $env:MOCK_ARCHIVE -DestinationPath $env:MOCK_EXTRACTED"], { MOCK_ARCHIVE: path, MOCK_EXTRACTED: extracted })
      : run("tar", ["-xzf", path, "-C", extracted]);
    assert.equal(unpack.status, 0, unpack.stderr);
    const binaries = rid.startsWith("osx-") ? join(extracted, "Log Studio.app", "Contents", "MacOS") : extracted;
    const native = `Photino.Native${rid.startsWith("win-") ? ".dll" : rid.startsWith("osx-") ? ".dylib" : ".so"}`;
    for (const file of ["LogStudio.dll", "LogStudio.Desktop.dll", "LogStudio.Desktop.deps.json", "LogStudio.Desktop.runtimeconfig.json", "Photino.NET.dll", native, "desktop-dependency-notices.txt", "dependency-notices.txt", "third-party-notices.txt"]) {
      assert.equal(existsSync(join(binaries, file)), true, file);
    }
    assert.equal(readFileSync(join(binaries, "desktop-dependency-notices.txt"), "utf8"), "src/LogStudio.Desktop/dependency-notices.txt");
    assert.equal(readFileSync(join(binaries, "dependency-notices.txt"), "utf8"), "src/LogStudio/dependency-notices.txt");
    assert.equal(existsSync(join(binaries, windows ? "LogStudio.Desktop.exe" : "LogStudio.Desktop")), true);
    if (rid.startsWith("osx-")) {
      const plist = readFileSync(join(extracted, "Log Studio.app", "Contents", "Info.plist"), "utf8");
      assert.doesNotMatch(plist, /@VERSION@/);
      assert.match(plist, /<string>1\.0\.3<\/string>/);
    }
    rmSync(join(binaries, native));
    const incomplete = windows
      ? run("pwsh", ["-NoProfile", "-Command", "Compress-Archive -Path \"$env:MOCK_EXTRACTED/*\" -DestinationPath $env:MOCK_ARCHIVE -Force"], { MOCK_EXTRACTED: extracted, MOCK_ARCHIVE: path })
      : run("tar", ["-czf", path, "-C", extracted, "."]);
    assert.equal(incomplete.status, 0, incomplete.stderr);
    const rejected = run("pwsh", ["-NoProfile", "-Command", verify], { RELEASE_RID: rid }, { cwd: f.directory });
    assert.notEqual(rejected.status, 0);
    assert.ok(rejected.stderr.includes(`Desktop archive is missing ${native}`), rejected.stderr);
  });
}

test("release publication requires every archive and checksum", { skip: windows }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "logstudio-release-assets."));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const match = releaseWorkflow.match(/      - name: Verify release assets\n        shell: bash\n        run: \|\n((?:          .*\n)+)/);
  assert.ok(match, "Release assets must be verified before publication");
  assert.ok(releaseWorkflow.indexOf("- name: Verify release assets") < releaseWorkflow.indexOf("- name: Publish GitHub Release"));
  const script = match[1].replace(/^          /gm, "");
  const assets = releaseRids.flatMap((rid) => ["logstudio", "logstudio-desktop"].flatMap((application) => {
    const archive = `${application}-${rid}.${rid.startsWith("win-") ? "zip" : "tar.gz"}`;
    return [archive, `${archive}.sha256`];
  }));
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

for (const [os, arch, rid] of [
  ["Linux", "x86_64", "linux-x64"], ["Linux", "aarch64", "linux-arm64"],
  ["Darwin", "x86_64", "osx-x64"], ["Darwin", "arm64", "osx-arm64"]
]) {
  test(`Bash desktop installation adds a per-user launcher for ${rid} and preserves CLI`, { skip: windows }, (t) => {
    const f = fixture(t);
    f.env.MOCK_OS = os;
    f.env.MOCK_ARCH = arch;
    unixArchive(f, rid);
    assert.equal(f.bash().status, 0);
    const cli = readlinkSync(join(f.bin, "logstudio"));
    const asset = desktopArchive(f, rid);
    const installed = f.bash("--desktop", "--version", "1.0.3-rc.1");
    assert.equal(installed.status, 0, installed.stderr);
    const executable = readlinkSync(join(f.bin, "logstudio-desktop"));
    assert.equal(run(executable, ["--help"]).status, 0);
    const launcher = os === "Darwin"
      ? join(f.home, "Applications", "Log Studio.app")
      : join(f.data, "applications", "logstudio-desktop.desktop");
    const target = readlinkSync(launcher);
    assert.equal(existsSync(target), true);
    if (os === "Darwin") {
      assert.equal(executable, join(target, "Contents", "MacOS", "LogStudio.Desktop"));
    } else {
      const contents = readFileSync(launcher, "utf8");
      assert.match(contents, /^\[Desktop Entry\]/);
      assert.ok(contents.includes(`Exec="${executable}"`), contents);
      assert.match(contents, /Terminal=false/);
    }
    const requests = readFileSync(f.env.MOCK_LOG, "utf8");
    assert.ok(requests.includes(`/releases/download/1.0.3-rc.1/${asset}`));
    assert.equal(requests.trim().split(/\r?\n/).length, 4, "Only the CLI and desktop archives and checksums are downloaded");
    const update = f.bash("--desktop");
    assert.equal(update.status, 0, update.stderr);
    assert.notEqual(readlinkSync(launcher), target);
    assert.notEqual(readlinkSync(join(f.bin, "logstudio-desktop")), executable);
    assert.equal(existsSync(target), true);
    assert.equal(readlinkSync(join(f.bin, "logstudio")), cli);
    assert.equal(run(join(f.bin, "logstudio"), ["--help"]).status, 0);
  });
}

test("Bash desktop defaults keep CLI releases separate and honor the default Linux application directory", { skip: windows }, (t) => {
  const f = fixture(t);
  desktopArchive(f);
  const result = run("bash", [bashInstaller, "--desktop", "--bin-dir", f.bin], {
    ...f.env, XDG_DATA_HOME: "", PATH: `${join(f.directory, "tools")}:${process.env.PATH}`
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(readlinkSync(join(f.bin, "logstudio-desktop")).startsWith(join(f.home, ".local", "share", "logstudio-desktop")));
  assert.equal(existsSync(join(f.home, ".local", "share", "applications", "logstudio-desktop.desktop")), true);
  assert.equal(existsSync(join(f.home, ".local", "share", "logstudio")), false);
});

test("Bash desktop checksum failures preserve the desktop launcher and CLI", { skip: windows }, (t) => {
  const f = fixture(t);
  unixArchive(f);
  assert.equal(f.bash().status, 0);
  const cli = readlinkSync(join(f.bin, "logstudio"));
  const asset = desktopArchive(f);
  assert.equal(f.bash("--desktop").status, 0);
  const executable = readlinkSync(join(f.bin, "logstudio-desktop"));
  const launcher = join(f.data, "applications", "logstudio-desktop.desktop");
  const previous = readlinkSync(launcher);
  checksum(f, asset, "0".repeat(64));
  const failed = f.bash("--desktop");
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /checksum verification failed/);
  assert.equal(readlinkSync(join(f.bin, "logstudio")), cli);
  assert.equal(readlinkSync(join(f.bin, "logstudio-desktop")), executable);
  assert.equal(readlinkSync(launcher), previous);
  assert.equal(readdirSync(f.install).length, 2);
});

for (const [rid, missing] of [
  ["linux-x64", "executable"], ["linux-x64", "LogStudio.dll"], ["linux-x64", "LogStudio.Desktop.dll"],
  ["osx-arm64", "Info.plist"], ["osx-x64", "LogStudio.dll"],
  ["linux-x64", "Photino.Native.so"], ["osx-x64", "Photino.Native.dylib"], ["linux-x64", "empty-native"]
]) {
  test(`Bash desktop refuses ${rid} archives without ${missing}`, { skip: windows }, (t) => {
    const f = fixture(t);
    f.env.MOCK_OS = rid.startsWith("osx-") ? "Darwin" : "Linux";
    f.env.MOCK_ARCH = rid.endsWith("arm64") ? "arm64" : "x86_64";
    desktopArchive(f, rid, missing);
    const result = f.bash("--desktop");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /archive is missing/);
    assert.equal(readdirSync(f.install).length, 0);
    assert.equal(existsSync(join(f.bin, "logstudio-desktop")), false);
  });
}

for (const [os, entry] of [["Linux", "file"], ["Linux", "directory"], ["Linux", "symlink"], ["Darwin", "file"], ["Darwin", "directory"], ["Darwin", "symlink"]]) {
  test(`Bash desktop refuses an unrelated ${os} launcher ${entry}`, { skip: windows }, (t) => {
    const f = fixture(t);
    f.env.MOCK_OS = os;
    desktopArchive(f, os === "Darwin" ? "osx-x64" : "linux-x64");
    const launcher = os === "Darwin" ? join(f.home, "Applications", "Log Studio.app") : join(f.data, "applications", "logstudio-desktop.desktop");
    mkdirSync(join(launcher, ".."), { recursive: true });
    if (entry === "file") writeFileSync(launcher, "unrelated");
    else if (entry === "directory") mkdirSync(launcher);
    else symlinkSync(f.downloads, launcher);
    const result = f.bash("--desktop");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to replace/);
    if (entry === "file") assert.equal(readFileSync(launcher, "utf8"), "unrelated");
    else if (entry === "symlink") assert.equal(readlinkSync(launcher), f.downloads);
    else assert.deepEqual(readdirSync(launcher), []);
    assert.equal(existsSync(join(f.bin, "logstudio-desktop")), false);
  });
}

test("Bash desktop refuses an unrelated executable", { skip: windows }, (t) => {
  const f = fixture(t);
  desktopArchive(f);
  mkdirSync(f.bin);
  writeFileSync(join(f.bin, "logstudio-desktop"), "unrelated");
  assert.match(f.bash("--desktop").stderr, /Refusing to replace/);
  assert.equal(readFileSync(join(f.bin, "logstudio-desktop"), "utf8"), "unrelated");
});

test("Bash desktop requires both the archive and checksum download", { skip: windows }, (t) => {
  const f = fixture(t);
  const missingArchive = f.bash("--desktop");
  assert.notEqual(missingArchive.status, 0);
  assert.equal(existsSync(f.install), false);
  const asset = desktopArchive(f);
  rmSync(join(f.downloads, `${asset}.sha256`));
  const result = f.bash("--desktop");
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(f.install), false);
  assert.equal(existsSync(join(f.bin, "logstudio-desktop")), false);
});

for (const desktop of [false, true]) {
  test(`Bash rejects absolute ${desktop ? "desktop" : "CLI"} archive paths before extraction`, { skip: windows }, (t) => {
    const f = fixture(t);
    const outside = join(f.directory, "outside.txt");
    writeFileSync(outside, "unchanged");
    const asset = `logstudio${desktop ? "-desktop" : ""}-linux-x64.tar.gz`;
    const archive = run("tar", ["-czPf", join(f.downloads, asset), outside]);
    assert.equal(archive.status, 0, archive.stderr);
    checksum(f, asset);
    const result = f.bash(...(desktop ? ["--desktop"] : []));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsafe paths/);
    assert.equal(existsSync(f.install), false);
    assert.equal(readFileSync(outside, "utf8"), "unchanged");
  });
}

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

for (const desktop of [false, true]) {
  test(`Windows rejects ${desktop ? "desktop" : "CLI"} traversal entries before extraction`, { skip: !windows }, (t) => {
    const f = fixture(t);
    const asset = `logstudio${desktop ? "-desktop" : ""}-${windowsRid()}.zip`;
    const create = run("pwsh", ["-NoProfile", "-Command", `
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::Open($env:MOCK_ARCHIVE, [IO.Compression.ZipArchiveMode]::Create)
    [void]$zip.CreateEntry("../escaped.txt")
    $zip.Dispose()
    `], { MOCK_ARCHIVE: join(f.downloads, asset) });
    assert.equal(create.status, 0, create.stderr);
    checksum(f, asset);
    const result = f.powershell(...(desktop ? ["-Desktop"] : []));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsafe paths/);
    assert.equal(existsSync(f.install), false);
  });
}

test("Windows desktop waits for WinExe help, installs a Start Menu shortcut, and preserves CLI", { skip: !windows }, (t) => {
  const f = fixture(t);
  mkdirSync(join(f.install, "bin"), { recursive: true });
  writeFileSync(join(f.install, "bin", "logstudio.exe"), "unrelated CLI must not be touched");
  desktopArchive(f, windowsRid());
  const result = f.powershell("-Desktop");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(f.install, "bin", "logstudio.exe"), "utf8"), "unrelated CLI must not be touched");
  assert.equal(existsSync(shortcutPath(f)), true);
  const inspect = () => run("pwsh", ["-NoProfile", "-Command", `
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($env:MOCK_SHORTCUT)
    $bin = Join-Path $env:MOCK_INSTALL_DIR "desktop-bin"
    $release = [IO.Path]::GetFullPath(@((Get-Item -LiteralPath $bin -Force).Target)[0])
    $expectedTarget = Join-Path $release "LogStudio.Desktop.exe"
    if ([IO.Path]::GetFullPath($shortcut.TargetPath) -ne [IO.Path]::GetFullPath($expectedTarget)) { throw "Wrong shortcut target: $($shortcut.TargetPath)" }
    if ([IO.Path]::GetFullPath($shortcut.WorkingDirectory) -ne $release) { throw "Wrong shortcut working directory: $($shortcut.WorkingDirectory)" }
  `], { MOCK_SHORTCUT: shortcutPath(f), MOCK_INSTALL_DIR: f.install });
  const installedShortcut = inspect();
  assert.equal(installedShortcut.status, 0, installedShortcut.stdout + installedShortcut.stderr);
  assert.equal(run(join(f.install, "desktop-bin", "LogStudio.Desktop.exe"), ["--help"]).status, 0);
  const update = f.powershell("-Desktop");
  assert.equal(update.status, 0, update.stdout + update.stderr);
  const updatedShortcut = inspect();
  assert.equal(updatedShortcut.status, 0, updatedShortcut.stdout + updatedShortcut.stderr);
  assert.equal(readdirSync(f.install).filter((name) => name.startsWith("desktop-release.")).length, 2);
});

for (const missing of ["executable", "LogStudio.dll", "LogStudio.Desktop.dll", "Photino.Native.dll", "empty-native"]) {
  test(`Windows desktop refuses archives missing ${missing}`, { skip: !windows }, (t) => {
    const f = fixture(t);
    desktopArchive(f, windowsRid(), missing);
    const result = f.powershell("-Desktop");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /archive is missing/);
    assert.equal(existsSync(shortcutPath(f)), false);
    assert.equal(existsSync(join(f.install, "desktop-bin")), false);
  });
}

test("Windows desktop checksum failure leaves the shortcut unchanged", { skip: !windows }, (t) => {
  const f = fixture(t);
  const asset = desktopArchive(f, windowsRid());
  assert.equal(f.powershell("-Desktop").status, 0);
  const previous = readFileSync(shortcutPath(f));
  checksum(f, asset, "0".repeat(64));
  const result = f.powershell("-Desktop");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum verification failed/);
  assert.deepEqual(readFileSync(shortcutPath(f)), previous);
  assert.equal(readdirSync(f.install).filter((name) => name.startsWith("desktop-release.")).length, 1);
});

for (const entry of ["file", "directory", "shortcut"]) {
  test(`Windows desktop refuses an unrelated Start Menu ${entry}`, { skip: !windows }, (t) => {
    const f = fixture(t);
    desktopArchive(f, windowsRid());
    const path = shortcutPath(f);
    mkdirSync(join(path, ".."), { recursive: true });
    if (entry === "directory") mkdirSync(path);
    else if (entry === "file") writeFileSync(path, "unrelated");
    else {
      const create = run("pwsh", ["-NoProfile", "-Command", `
        $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($env:MOCK_SHORTCUT)
        $shortcut.TargetPath = $env:MOCK_NODE
        $shortcut.Save()
      `], { MOCK_SHORTCUT: path, MOCK_NODE: process.execPath });
      assert.equal(create.status, 0, create.stderr);
    }
    const original = entry === "directory" ? null : readFileSync(path);
    const result = f.powershell("-Desktop");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to replace|shortcut|invalid/i);
    if (original) assert.deepEqual(readFileSync(path), original);
    else assert.deepEqual(readdirSync(path), []);
    assert.equal(existsSync(join(f.install, "desktop-bin")), false);
  });
}

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

test("compiled desktop archive installs and verifies without a GUI or installed .NET runtime", { skip: !process.env.LOGSTUDIO_TEST_DESKTOP_ARCHIVE }, (t) => {
  const f = fixture(t);
  const rid = process.env.LOGSTUDIO_TEST_RID;
  f.env.MOCK_OS = rid.startsWith("osx-") ? "Darwin" : "Linux";
  f.env.MOCK_ARCH = rid.endsWith("-arm64") ? "arm64" : "x86_64";
  const asset = `logstudio-desktop-${rid}${windows ? ".zip" : ".tar.gz"}`;
  cpSync(process.env.LOGSTUDIO_TEST_DESKTOP_ARCHIVE, join(f.downloads, asset));
  checksum(f, asset);
  const result = windows ? f.powershell("-Desktop") : f.bash("--desktop");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const executable = windows ? join(f.install, "desktop-bin", "LogStudio.Desktop.exe") : join(f.bin, "logstudio-desktop");
  for (const option of ["--help", "--version"]) {
    const verified = run(executable, [option], { DOTNET_ROOT: join(f.directory, "no-dotnet"), DOTNET_MULTILEVEL_LOOKUP: "0" });
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, option === "--help" ? /logstudio/i : /\d+\.\d+\.\d+/);
  }
});
