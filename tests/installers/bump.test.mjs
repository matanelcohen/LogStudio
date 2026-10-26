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
const bumpWorkflow = readFileSync(new URL("../../.github/workflows/bump-version.yml", import.meta.url), "utf8");
const windows = process.platform === "win32";
const versionFiles = [
  "Directory.Build.props", "frontend/package.json", "frontend/package-lock.json",
  "samples/PackageConsumer/PackageConsumer.csproj", "README.md", "docs/guide.md"
];

function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, {
    cwd: cwd || process.env.TEMP || process.env.TMPDIR || root,
    env: { ...process.env, ...env },
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

function git(cwd, ...args) {
  const result = run("git", args, cwd);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function gitFixture(t, source) {
  const f = fixture(t, source);
  const remote = mkdtempSync(join(tmpdir(), "bump-remote-"));
  t.after(() => rmSync(remote, { recursive: true, force: true }));
  git(remote, "init", "--bare", "--quiet");
  git(f.dir, "init", "--quiet", "--initial-branch=release-test");
  git(f.dir, "config", "user.name", "Contract Test");
  git(f.dir, "config", "user.email", "contract@example.invalid");
  git(f.dir, "config", "commit.gpgsign", "false");
  git(f.dir, "config", "tag.gpgsign", "false");
  writeFileSync(join(f.dir, "unrelated.txt"), "original\n");
  git(f.dir, "add", ".");
  git(f.dir, "commit", "--quiet", "-m", "fixture");
  git(f.dir, "remote", "add", "origin", remote);
  return { ...f, remote, initialHead: git(f.dir, "rev-parse", "HEAD") };
}

function workflowStep(name) {
  const match = bumpWorkflow.replace(/\r\n/g, "\n").match(new RegExp(`      - name: ${name}\\n[\\s\\S]*?        run: \\|\\n((?:          .*\\n)+)`));
  assert.ok(match, name);
  return match[1].replace(/^          /gm, "");
}

test("bump workflow accepts a manual version and checks out the selected branch with tags", () => {
  assert.match(bumpWorkflow, /workflow_dispatch:\s+inputs:\s+version:\s+description: [^\n]+\s+required: true\s+type: string/);
  assert.match(bumpWorkflow, /contents: write/);
  assert.match(bumpWorkflow, /actions: write/);
  assert.match(bumpWorkflow, /group: bump-version\s+cancel-in-progress: false/);
  assert.match(bumpWorkflow, /ref: \$\{\{ github\.ref \}\}\s+fetch-depth: 0/);
  assert.match(bumpWorkflow, /RELEASE_VERSION: \$\{\{ inputs\.version \}\}/);
  assert.match(bumpWorkflow, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(bumpWorkflow, /GH_REPO: \$\{\{ github\.repository \}\}/);
  assert.doesNotMatch(workflowStep("Bump version and push"), /\$\{\{/);
  assert.doesNotMatch(workflowStep("Start compiled release"), /\$\{\{/);
});

for (const version of ["1.2.3", "1.2.4-rc.1"]) {
  test(`bump workflow pushes ${version} before dispatching its compiled release`, { skip: windows }, (t) => {
    const f = gitFixture(t, bashBump);
    const tools = join(f.dir, "tools");
    const dispatchLog = join(f.dir, "dispatch.log");
    mkdirSync(tools);
    writeFileSync(join(tools, "gh"), `#!/bin/sh
set -eu
branch=$(git --git-dir "$MOCK_REMOTE" rev-parse --verify "refs/heads/$GITHUB_REF_NAME")
tag=$(git --git-dir "$MOCK_REMOTE" rev-parse --verify "refs/tags/$RELEASE_VERSION")
[ "$branch" = "$tag" ]
printf '%s\\n' "$@" > "$MOCK_DISPATCH_LOG"
`, { mode: 0o755 });

    const result = run("bash", ["-e", "-c", `${workflowStep("Bump version and push")}\n${workflowStep("Start compiled release")}`], f.dir, {
      PATH: `${tools}:${process.env.PATH}`,
      RELEASE_VERSION: version,
      GITHUB_REF_NAME: "release-test",
      MOCK_REMOTE: f.remote,
      MOCK_DISPATCH_LOG: dispatchLog
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(f.dir, "log", "-1", "--format=%an <%ae>"), "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>");
    assert.equal(JSON.parse(git(f.dir, "--git-dir", f.remote, "show", `${version}:frontend/package.json`)).version, version);
    assert.deepEqual(readFileSync(dispatchLog, "utf8").trim().split("\n"), [
      "workflow", "run", "release.yml", "--ref", "release-test", "-f", `tag=${version}`
    ]);
  });
}

test("bump-version.sh help runs and displays usage", { skip: windows }, () => {
  const result = run("bash", [bashBump, "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: \.\/bump-version\.sh/);
  assert.match(result.stdout, /--tag/);
  assert.match(result.stdout, /--push/);
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
  assert.match(result.stdout, /-Push/);
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

for (const [source, command, options, tagOption, pushOption] of [
  [bashBump, "bash", [], "--tag", "--push"],
  [powershellBump, "pwsh", ["-NoProfile", "-File"], "-Tag", "-Push"]
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

  for (const version of ["1.2.3", "1.2.4-rc.1"]) {
    test(`${basename(source)} commits and pushes ${version} before publishing its tag`, { skip }, (t) => {
      const f = gitFixture(t, source);
      const extraOptions = version.includes("-") ? [tagOption] : [];
      writeFileSync(join(f.dir, "unrelated.txt"), "uncommitted\n");
      writeFileSync(join(f.dir, "untracked.txt"), "untracked\n");
      git(f.dir, "tag", "unrelated-tag");
      writeFileSync(join(f.remote, "hooks", "pre-receive"), `#!/bin/sh
while read old new ref; do
  if [ "$ref" = "refs/tags/${version}" ]; then
    branch=$(git rev-parse --verify refs/heads/release-test) || exit 1
    [ "$branch" = "$new" ] || exit 1
  fi
  printf '%s\\n' "$ref" >> received-refs
done
`, { mode: 0o755 });

      const result = run(command, [...options, f.localBump, pushOption, version, ...extraOptions], join(f.dir, "docs"));
      assert.equal(result.status, 0, result.stderr);
      const head = git(f.dir, "rev-parse", "HEAD");
      assert.notEqual(head, f.initialHead);
      assert.equal(git(f.dir, "log", "-1", "--format=%s"), `Bump version to ${version}`);
      assert.deepEqual(git(f.dir, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n").sort(), [...versionFiles].sort());
      assert.equal(git(f.dir, "--git-dir", f.remote, "rev-parse", "refs/heads/release-test"), head);
      assert.equal(git(f.dir, "--git-dir", f.remote, "rev-parse", `refs/tags/${version}`), head);
      assert.equal(git(f.dir, "rev-parse", `refs/tags/${version}`), head);
      assert.equal(JSON.parse(git(f.dir, "--git-dir", f.remote, "show", `${version}:frontend/package.json`)).version, version);
      assert.equal(git(f.dir, "--git-dir", f.remote, "tag", "--list"), version);
      assert.deepEqual(readFileSync(join(f.remote, "received-refs"), "utf8").trim().split("\n"), ["refs/heads/release-test", `refs/tags/${version}`]);
      assert.equal(git(f.dir, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/release-test");
      assert.match(git(f.dir, "status", "--porcelain"), /M unrelated\.txt/);
      assert.match(git(f.dir, "status", "--porcelain"), /\?\? untracked\.txt/);
      assert.match(result.stdout, /Successfully bumped version/);
    });
  }

  test(`${basename(source)} pushes to the configured upstream remote`, { skip }, (t) => {
    const f = gitFixture(t, source);
    git(f.dir, "remote", "rename", "origin", "releases");
    git(f.dir, "push", "--quiet", "--set-upstream", "releases", "release-test");
    const result = run(command, [...options, f.localBump, "1.2.3", pushOption], f.dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(f.dir, "--git-dir", f.remote, "rev-parse", "refs/tags/1.2.3"), git(f.dir, "rev-parse", "HEAD"));
    assert.equal(git(f.dir, "rev-parse", "--abbrev-ref", "@{upstream}"), "releases/release-test");
  });

  test(`${basename(source)} does not commit or push without the push option`, { skip }, (t) => {
    const f = gitFixture(t, source);
    const result = run(command, [...options, f.localBump, "1.2.3"], f.dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(f.dir, "rev-parse", "HEAD"), f.initialHead);
    assert.equal(git(f.dir, "tag", "--list"), "");
    assert.equal(git(f.dir, "--git-dir", f.remote, "for-each-ref", "--format=%(refname)"), "");
  });

  for (const failure of ["staged changes", "version edits", "existing tag", "detached HEAD", "missing remote"]) {
    test(`${basename(source)} rejects push with ${failure} before modifying version files`, { skip }, (t) => {
      const f = gitFixture(t, source);
      if (failure === "staged changes") {
        writeFileSync(join(f.dir, "unrelated.txt"), "staged\n");
        git(f.dir, "add", "unrelated.txt");
      } else if (failure === "version edits") {
        writeFileSync(f.readmePath, "uncommitted documentation\n");
      } else if (failure === "existing tag") {
        git(f.dir, "tag", "1.2.3");
      } else if (failure === "detached HEAD") {
        git(f.dir, "checkout", "--quiet", "--detach");
      } else {
        git(f.dir, "remote", "remove", "origin");
      }
      const original = versionFiles.map((path) => readFileSync(join(f.dir, path), "utf8"));
      const result = run(command, [...options, f.localBump, "1.2.3", pushOption, tagOption], f.dir);
      assert.notEqual(result.status, 0, result.stdout);
      assert.ok(result.stderr.trim(), "failure must be reported");
      assert.doesNotMatch(result.stdout, /Successfully bumped version/);
      assert.deepEqual(versionFiles.map((path) => readFileSync(join(f.dir, path), "utf8")), original);
      assert.equal(git(f.dir, "rev-parse", "HEAD"), f.initialHead);
      assert.equal(git(f.dir, "tag", "--list"), failure === "existing tag" ? "1.2.3" : "");
    });
  }

  for (const failure of ["commit", "branch push", "tag push"]) {
    test(`${basename(source)} stops when ${failure} fails`, { skip }, (t) => {
      const f = gitFixture(t, source);
      if (failure === "commit") {
        writeFileSync(join(f.dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho 'Commit rejected' >&2\nexit 1\n", { mode: 0o755 });
      } else {
        writeFileSync(join(f.remote, "hooks", "pre-receive"), `#!/bin/sh
while read old new ref; do
  case "$ref" in
    ${failure === "branch push" ? "refs/heads/*" : "refs/tags/*"}) echo 'Push rejected' >&2; exit 1 ;;
  esac
done
`, { mode: 0o755 });
      }
      const result = run(command, [...options, f.localBump, "1.2.3", pushOption], f.dir);
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, /rejected/i);
      assert.doesNotMatch(result.stdout, /Successfully bumped version/);
      assert.equal(git(f.dir, "--git-dir", f.remote, "tag", "--list"), "");
      assert.equal(git(f.dir, "tag", "--list"), failure === "tag push" ? "1.2.3" : "");
      assert.equal(git(f.dir, "--git-dir", f.remote, "for-each-ref", "--format=%(refname)", "refs/heads"), failure === "tag push" ? "refs/heads/release-test" : "");
      if (failure === "commit") {
        assert.equal(git(f.dir, "rev-parse", "HEAD"), f.initialHead);
      }
    });
  }
}
