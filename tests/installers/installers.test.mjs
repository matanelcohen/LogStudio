import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
