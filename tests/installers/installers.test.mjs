import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const bashInstaller = fileURLToPath(new URL("../../install.sh", import.meta.url));
const powershellInstaller = fileURLToPath(new URL("../../install.ps1", import.meta.url));
const windows = process.platform === "win32";

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.env.TEMP || process.env.TMPDIR || root,
    encoding: "utf8",
    timeout: 30000
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

test("PowerShell help runs without installing anything", () => {
  const result = run("pwsh", ["-NoProfile", "-File", powershellInstaller, "-Help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /-Local/);
  assert.match(result.stdout, /-Offline/);
  assert.match(result.stdout, /-NuGetSource/);
});

test("PowerShell rejects contradictory restore modes before invoking tools", () => {
  const result = run("pwsh", ["-NoProfile", "-File", powershellInstaller, "-Offline", "-Online"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Choose one installation scope and one restore mode/);
});

test("PowerShell rejects contradictory install scopes before invoking tools", () => {
  const result = run("pwsh", ["-NoProfile", "-File", powershellInstaller, "-Local", "-Global"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Choose one installation scope and one restore mode/);
});

test("Bash help runs without installing anything", { skip: windows }, () => {
  const result = run("bash", [bashInstaller, "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--local/);
  assert.match(result.stdout, /--offline/);
  assert.match(result.stdout, /--nuget-source/);
});

test("Bash rejects a missing feed argument without invoking tools", { skip: windows }, () => {
  const result = run("bash", [bashInstaller, "--nuget-source"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires a feed URL or directory/);
});

test("Bash rejects unknown options without invoking tools", { skip: windows }, () => {
  const result = run("bash", [bashInstaller, "--not-an-installer-option"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown option/);
});

for (const [name, first, retry, succeeds, attempts] of [
  ["successful audit", 0, 0, true, 1],
  ["transient registry failure", 1, 0, true, 2],
  ["persistent registry failure", 1, 1, false, 2],
  ["high-severity vulnerabilities", 1, 1, false, 2]
]) {
  test(`Bash online restore handles ${name}`, { skip: windows }, () => {
    const installer = readFileSync(bashInstaller, "utf8");
    const block = installer.match(/if \[\[ "\$FrontendRestored" != true \]\]; then\n([\s\S]*?)\nfi/);
    assert.ok(block);
    const result = run("bash", ["-ec", `
FrontendRestored=false
attempts=0
npm() {
  if [[ "$1" == ci ]]; then
    [[ "$2" == --prefer-online ]]
    return
  fi
  [[ "$1" == audit && "$2" == --audit-level=high ]] || exit 99
  attempts=$((attempts + 1))
  echo "audit-attempt"
  if [[ "$attempts" == 1 ]]; then return ${first}; fi
  return ${retry}
}
sleep() { :; }
${block[0]}
echo build-reached
`]);
    assert.equal(result.status === 0, succeeds, result.stderr);
    assert.equal(result.stdout.includes("build-reached"), succeeds);
    assert.equal(result.stdout.match(/audit-attempt/g)?.length, attempts);
  });

  test(`PowerShell online restore handles ${name}`, () => {
    const installer = readFileSync(powershellInstaller, "utf8");
    const checked = installer.match(/function Invoke-Checked[\s\S]*?\n}/);
    const block = installer.match(/    if \(-not \$FrontendRestored\) \{\n([\s\S]*?)\n    }/);
    assert.ok(checked);
    assert.ok(block);
    const result = run("pwsh", ["-NoProfile", "-Command", `
$ErrorActionPreference = "Stop"
$FrontendRestored = $false
$Npm = "Invoke-MockNpm"
$script:attempts = 0
function Invoke-MockNpm {
    if ($args[0] -eq "ci" -and $args[1] -eq "--prefer-online") {
        $global:LASTEXITCODE = 0
        return
    }
    if ($args[0] -ne "audit" -or $args[1] -ne "--audit-level=high") { throw "Unexpected npm arguments" }
    $script:attempts++
    Write-Host "audit-attempt"
    $global:LASTEXITCODE = if ($script:attempts -eq 1) { ${first} } else { ${retry} }
}
function Start-Sleep { param($Seconds) }
${checked[0]}
${block[0]}
Write-Host "build-reached"
`]);
    assert.equal(result.status === 0, succeeds, result.stderr);
    assert.equal(result.stdout.includes("build-reached"), succeeds);
    assert.equal(result.stdout.match(/audit-attempt/g)?.length, attempts);
  });
}
