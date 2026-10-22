import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const bashInstaller = fileURLToPath(new URL("../../install.sh", import.meta.url));
const powershellInstaller = fileURLToPath(new URL("../../install.ps1", import.meta.url));
const windows = process.platform === "win32";

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: process.env.TEMP || process.env.TMPDIR || root,
    env: { ...process.env, ...env },
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

function auditFixture(t, installer, scenario) {
  const directory = mkdtempSync(join(tmpdir(), "logstudio audit-test."));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tools = join(directory, "tools");
  const log = join(directory, "commands");
  const mock = join(tools, "mock.cjs");
  const script = join(directory, installer === "Bash" ? "install.sh" : "install.ps1");
  mkdirSync(tools);
  mkdirSync(join(directory, "frontend"));
  copyFileSync(installer === "Bash" ? bashInstaller : powershellInstaller, script);
  writeFileSync(log, "");
  writeFileSync(mock, `
const fs = require("node:fs");
const [tool, ...args] = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify([tool, ...args]) + "\\n");
if (tool === "sleep") process.exit(0);
if (tool === "dotnet" && args[0] === "--version") {
  console.log("10.0.301");
  process.exit(0);
}
if (tool === "npm" && args[0] === "ci") {
  process.exit(args.includes("--offline") && process.env.MOCK_CACHE_MISS === "true" ? 1 : 0);
}
if (tool === "npm" && args[0] === "audit") {
  const attempts = fs.readFileSync(process.env.MOCK_LOG, "utf8").trim().split("\\n")
    .map(line => JSON.parse(line)).filter(command => command[0] === "npm" && command[1] === "audit").length;
  if (attempts <= Number(process.env.MOCK_AUDIT_FAILURES)) {
    console.error(process.env.MOCK_AUDIT_ERROR);
    process.exit(1);
  }
  console.log("2 moderate severity vulnerabilities");
  process.exit(0);
}
if (tool === "npm" && args.join(" ") === "run build") {
  console.error("Stopped at frontend build for this installer contract test.");
  process.exit(42);
}
console.error("Unexpected command: " + tool + " " + args.join(" "));
process.exit(99);
`);
  for (const tool of ["npm", "dotnet", ...(!windows ? ["sleep"] : [])]) {
    writeFileSync(join(tools, `${tool}${windows ? ".cmd" : ""}`), windows
      ? `@"${process.execPath}" "${mock}" ${tool} %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${mock}" ${tool} "$@"\n`, { mode: 0o755 });
  }
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === "path") || "PATH";
  const env = {
    [pathKey]: `${tools}${delimiter}${process.env[pathKey]}`,
    MOCK_LOG: log,
    MOCK_INSTALLER: script,
    MOCK_NODE: process.execPath,
    MOCK_COMMAND: mock,
    MOCK_AUDIT_FAILURES: String(scenario.failures),
    MOCK_AUDIT_ERROR: scenario.vulnerability ? "1 high severity vulnerability" : "npm error audit endpoint returned an error",
    MOCK_CACHE_MISS: String(scenario.cacheMiss || false)
  };
  const result = installer === "Bash"
    ? run("bash", [script, "--local", ...(scenario.mode ? [`--${scenario.mode.toLowerCase()}`] : [])], env)
    : run("pwsh", ["-NoProfile", "-Command", `
function Start-Sleep { param([int]$Seconds); & $env:MOCK_NODE $env:MOCK_COMMAND sleep $Seconds }
& $env:MOCK_INSTALLER -Local ${scenario.mode ? `-${scenario.mode}` : ""}
exit $LASTEXITCODE
`], env);
  const commands = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { result, commands };
}

for (const installer of ["Bash", "PowerShell"]) {
  for (const scenario of [
    { name: "accepts a successful audit without retrying", mode: "Online", failures: 0, attempts: 1, build: true },
    { name: "recovers from one transient audit failure", mode: "Online", failures: 1, attempts: 2, build: true },
    { name: "recovers on the final audit attempt", mode: "Online", failures: 2, attempts: 3, build: true },
    { name: "stops after persistent audit errors", mode: "Online", failures: 3, attempts: 3, build: false },
    { name: "does not bypass reported vulnerabilities", mode: "Online", failures: 3, attempts: 3, build: false, vulnerability: true },
    { name: "does not audit offline restores", mode: "Offline", failures: 0, attempts: 0, build: true },
    { name: "audits after a cache miss in default mode", failures: 1, attempts: 2, build: true, cacheMiss: true }
  ]) {
    test(`${installer} ${scenario.name}`, { skip: installer === "Bash" && windows }, (t) => {
      const { result, commands } = auditFixture(t, installer, scenario);
      const output = result.stdout + result.stderr;
      const audits = commands.filter(command => command[0] === "npm" && command[1] === "audit");
      assert.notEqual(result.status, 0, "The fixture stops at the build or audit failure.");
      assert.equal(audits.length, scenario.attempts, output);
      for (const audit of audits) assert.deepEqual(audit, ["npm", "audit", "--audit-level=high"]);
      assert.deepEqual(commands.filter(command => command[0] === "sleep"),
        Array.from({ length: Math.max(0, scenario.attempts - 1) }, () => ["sleep", "5"]));
      assert.equal(commands.some(command => command[0] === "npm" && command[1] === "run"), scenario.build, output);
      assert.equal(commands.filter(command => command[0] === "npm" && command[1] === "ci").length,
        scenario.cacheMiss ? 2 : 1, output);
      if (scenario.build) {
        assert.match(output, /Stopped at frontend build/);
      } else {
        assert.match(output, /refusing to continue without a successful vulnerability check/);
      }
      if (scenario.vulnerability) assert.match(output, /1 high severity vulnerability/);
    });
  }
}
