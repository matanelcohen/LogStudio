import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const bashBump = fileURLToPath(new URL("../../bump-version.sh", import.meta.url));
const powershellBump = fileURLToPath(new URL("../../bump-version.ps1", import.meta.url));
const windows = process.platform === "win32";

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd: cwd || process.env.TEMP || process.env.TMPDIR || root,
    encoding: "utf8",
    timeout: 30000
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function fixture(t, source) {
  const dir = mkdtempSync(join(tmpdir(), "bump-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "frontend"));
  mkdirSync(join(dir, "docs"));
  mkdirSync(join(dir, "samples", "PackageConsumer"), { recursive: true });

  const propsPath = join(dir, "Directory.Build.props");
  const pkgPath = join(dir, "frontend", "package.json");
  const lockPath = join(dir, "frontend", "package-lock.json");
  const consumerPath = join(dir, "samples", "PackageConsumer", "PackageConsumer.csproj");
  const readmePath = join(dir, "README.md");
  const guidePath = join(dir, "docs", "guide.md");
  const localBump = join(dir, basename(source));

  writeFileSync(propsPath, `<Project>\n  <PropertyGroup>\n    <Version>1.0.0</Version>\n  </PropertyGroup>\n</Project>\n`);
  writeFileSync(pkgPath, JSON.stringify({ name: "logstudio-frontend", version: "1.0.0" }, null, 2));
  writeFileSync(lockPath, JSON.stringify({ name: "logstudio-frontend", version: "1.0.0", packages: { "": { name: "logstudio-frontend", version: "1.0.0" } } }, null, 2));
  writeFileSync(consumerPath, `<Project>\n  <ItemGroup>\n    <PackageReference Include="LogStudio" Version="1.0.0" />\n  </ItemGroup>\n</Project>\n`);
  writeFileSync(readmePath, `# Test\n--version 1.0.0\n-Version 1.0.0\n\`1.0.0\` (or \`1.0.0-rc.1\`)\nLogStudio.1.0.0.nupkg\n`);
  writeFileSync(guidePath, readFileSync(readmePath, "utf8"));
  writeFileSync(localBump, readFileSync(source, "utf8"), { mode: 0o755 });

  return { dir, localBump, propsPath, pkgPath, lockPath, consumerPath, readmePath, guidePath };
}

test("bump-version.sh help runs and displays usage", { skip: windows }, () => {
  const result = run("bash", [bashBump, "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: \.\/bump-version\.sh/);
  assert.match(result.stdout, /--tag/);
});

test("bump-version.sh rejects missing version argument", { skip: windows }, () => {
  const result = run("bash", [bashBump]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Version argument is required/);
});

test("bump-version.sh rejects unknown options", { skip: windows }, () => {
  const result = run("bash", [bashBump, "--unknown"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown option/);
});

test("bump-version.sh rejects invalid semver format", { skip: windows }, () => {
  const result = run("bash", [bashBump, "not-a-version"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid version/);
});

test("bump-version.ps1 help runs and displays usage", () => {
  const result = run("pwsh", ["-NoProfile", "-File", powershellBump, "-Help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: \.\\bump-version\.ps1/);
  assert.match(result.stdout, /-Tag/);
});

test("bump-version.ps1 rejects missing version argument", () => {
  const result = run("pwsh", ["-NoProfile", "-File", powershellBump]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Version argument is required/);
});

test("bump-version.ps1 rejects invalid semver format", () => {
  const result = run("pwsh", ["-NoProfile", "-File", powershellBump, "-Version", "bad.version"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid version/);
});

test("bump-version.sh updates version across repository files", { skip: windows }, (t) => {
  const { dir, localBump, propsPath, pkgPath, lockPath, consumerPath, readmePath, guidePath } = fixture(t, bashBump);

  const result = run("bash", [localBump, "1.2.3"], dir);
  assert.equal(result.status, 0, result.stderr);

  assert.match(readFileSync(propsPath, "utf8"), /<Version>1\.2\.3<\/Version>/);
  assert.equal(JSON.parse(readFileSync(pkgPath, "utf8")).version, "1.2.3");
  assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).version, "1.2.3");
  assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).packages[""].version, "1.2.3");
  assert.match(readFileSync(consumerPath, "utf8"), /Version="1\.2\.3"/);
  for (const path of [readmePath, guidePath]) {
    const documentation = readFileSync(path, "utf8");
    assert.match(documentation, /--version 1\.2\.3/);
    assert.match(documentation, /-Version 1\.2\.3/);
    assert.match(documentation, /`1\.2\.3` \(or `1\.2\.3-rc\.1`\)/);
    assert.match(documentation, /LogStudio\.1\.2\.3\.nupkg/);
    assert.doesNotMatch(documentation, /1\.0\.0|v1\.2\.3/);
  }
});

test("bump-version.ps1 updates version across repository files", (t) => {
  const { dir, localBump, propsPath, pkgPath, lockPath, consumerPath, readmePath, guidePath } = fixture(t, powershellBump);

  const result = run("pwsh", ["-NoProfile", "-File", localBump, "-Version", "1.2.3"], dir);
  assert.equal(result.status, 0, result.stderr);

  assert.match(readFileSync(propsPath, "utf8"), /<Version>1\.2\.3<\/Version>/);
  assert.equal(JSON.parse(readFileSync(pkgPath, "utf8")).version, "1.2.3");
  assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).version, "1.2.3");
  assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).packages[""].version, "1.2.3");
  assert.match(readFileSync(consumerPath, "utf8"), /Version="1\.2\.3"/);
  for (const path of [readmePath, guidePath]) {
    const documentation = readFileSync(path, "utf8");
    assert.match(documentation, /--version 1\.2\.3/);
    assert.match(documentation, /-Version 1\.2\.3/);
    assert.match(documentation, /`1\.2\.3` \(or `1\.2\.3-rc\.1`\)/);
    assert.match(documentation, /LogStudio\.1\.2\.3\.nupkg/);
    assert.doesNotMatch(documentation, /1\.0\.0|v1\.2\.3/);
  }
});

for (const [source, command, options, tagOption] of [
  [bashBump, "bash", [], "--tag"],
  [powershellBump, "pwsh", ["-NoProfile", "-File"], "-Tag"]
]) {
  const skip = command === "bash" && windows;

  test(`${basename(source)} rejects prefixed versions without modifying files`, { skip }, (t) => {
    const f = fixture(t, source);
    const paths = [f.propsPath, f.pkgPath, f.lockPath, f.consumerPath, f.readmePath, f.guidePath];
    const original = paths.map((path) => readFileSync(path, "utf8"));
    for (const version of ["v1.0.2", "V1.0.2", "v1.0.3-rc.1"]) {
      const result = run(command, [...options, f.localBump, version], f.dir);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /Invalid version/);
      assert.deepEqual(paths.map((path) => readFileSync(path, "utf8")), original);
    }
  });

  for (const version of ["1.0.2", "1.0.3", "1.0.3-rc.1"]) {
    test(`${basename(source)} creates the exact ${version} tag`, { skip }, (t) => {
      const f = fixture(t, source);
      for (const args of [
        ["init", "--quiet"],
        ["-c", "user.name=Contract Test", "-c", "user.email=contract@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "fixture"]
      ]) {
        const result = run("git", args, f.dir);
        assert.equal(result.status, 0, result.stderr);
      }
      const result = run(command, [...options, f.localBump, version, tagOption], f.dir);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(run("git", ["tag", "--list"], f.dir).stdout.trim(), version);
      assert.equal(run("git", ["rev-parse", `refs/tags/${version}`], f.dir).stdout, run("git", ["rev-parse", "HEAD"], f.dir).stdout);
      assert.equal(JSON.parse(readFileSync(f.pkgPath, "utf8")).version, version);
      assert.match(result.stdout, new RegExp(`Successfully bumped version to ${version.replaceAll(".", "\\.")}`));
      assert.doesNotMatch(result.stdout, /\bv[0-9]+\./);
    });
  }
}
