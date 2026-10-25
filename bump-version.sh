#!/usr/bin/env bash
set -euo pipefail

readonly ProjectRoot="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PropsFile="$ProjectRoot/Directory.Build.props"
readonly FrontendPackage="$ProjectRoot/frontend/package.json"
readonly FrontendLock="$ProjectRoot/frontend/package-lock.json"
readonly ConsumerProject="$ProjectRoot/samples/PackageConsumer/PackageConsumer.csproj"
readonly ReadmeFile="$ProjectRoot/README.md"
readonly GuideFile="$ProjectRoot/docs/guide.md"
readonly LibraryProject="$ProjectRoot/src/LogStudio/LogStudio.csproj"

CreateTag=false
PushChanges=false
TargetVersion=""

usage() {
  printf '%s\n' \
    "Align the version across Directory.Build.props, frontend, samples, and documentation." \
    "" \
    "Usage: ./bump-version.sh [--tag] [--push] <version>" \
    "" \
    "  <version>  The new version (e.g. 1.0.2; no v prefix)." \
    "  --tag, -t  Create or update the git tag (e.g. 1.0.2) pointing to HEAD." \
    "  --push     Commit the version bump, push the branch, then create and push the tag." \
    "  --help, -h Show this help." \
    "" \
    "This script updates:" \
    "  - Directory.Build.props (<Version>)" \
    "  - frontend/package.json and frontend/package-lock.json" \
    "  - samples/PackageConsumer/PackageConsumer.csproj" \
    "  - README.md and docs/guide.md installation and package references"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag|-t) CreateTag=true ;;
    --push) PushChanges=true ;;
    --help|-h) usage; exit 0 ;;
    -*)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "$TargetVersion" ]]; then
        printf 'Unexpected argument: %s\n' "$1" >&2
        usage >&2
        exit 2
      fi
      TargetVersion="$1"
      ;;
  esac
  shift
done

if [[ -z "$TargetVersion" ]]; then
  printf 'Version argument is required.\n' >&2
  usage >&2
  exit 2
fi

SemverPattern='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$'
if [[ ! "$TargetVersion" =~ $SemverPattern ]]; then
  printf 'Invalid version: "%s". Expected unprefixed semver such as 1.0.2 or 1.0.2-rc.1\n' "$TargetVersion" >&2
  exit 1
fi

if [[ ! -f "$PropsFile" ]]; then
  printf 'Directory.Build.props not found at %s\n' "$PropsFile" >&2
  exit 1
fi

CurrentVersion="$(sed -n -E 's/^[[:space:]]*<Version>([^<]+)<\/Version>.*$/\1/p' "$PropsFile")"
if [[ -z "$CurrentVersion" ]]; then
  printf 'Could not determine current version from %s\n' "$PropsFile" >&2
  exit 1
fi

VersionFiles=()
for File in Directory.Build.props frontend/package.json frontend/package-lock.json \
  samples/PackageConsumer/PackageConsumer.csproj README.md docs/guide.md; do
  if [[ -f "$ProjectRoot/$File" ]]; then
    VersionFiles+=("$File")
  fi
done

if [[ "$PushChanges" == true ]]; then
  Branch="$(git -C "$ProjectRoot" symbolic-ref --quiet --short HEAD)" || {
    printf 'Cannot push a version bump without a checked-out git branch.\n' >&2
    exit 1
  }
  if ! git -C "$ProjectRoot" diff --cached --quiet; then
    printf 'Commit or unstage existing staged changes before using --push.\n' >&2
    exit 1
  fi
  VersionChanges="$(git -C "$ProjectRoot" status --porcelain -- "${VersionFiles[@]}")"
  if [[ -n "$VersionChanges" ]]; then
    printf 'Commit or stash changes to versioned files before using --push.\n' >&2
    exit 1
  fi
  ExistingTag="$(git -C "$ProjectRoot" tag --list "$TargetVersion")"
  if [[ -n "$ExistingTag" ]]; then
    printf 'Git tag %s already exists; --push will not overwrite it.\n' "$TargetVersion" >&2
    exit 1
  fi
  PushRemote="$(git -C "$ProjectRoot" for-each-ref --format='%(upstream:remotename)' "refs/heads/$Branch")"
  if [[ -z "$PushRemote" ]]; then
    PushRemote=origin
  fi
  git -C "$ProjectRoot" remote get-url "$PushRemote" >/dev/null
fi

printf 'Updating version from %s to %s...\n' "$CurrentVersion" "$TargetVersion"

# 1. Update Directory.Build.props
sed -i.bak -E "s/<Version>${CurrentVersion}<\/Version>/<Version>${TargetVersion}<\/Version>/" "$PropsFile"
rm -f "$PropsFile.bak"

# 2. Update frontend/package.json
if [[ -f "$FrontendPackage" ]]; then
  sed -i.bak -E "s/\"version\": \"[^\"]+\"/\"version\": \"${TargetVersion}\"/" "$FrontendPackage"
  rm -f "$FrontendPackage.bak"
fi

# 3. Update frontend/package-lock.json
if [[ -f "$FrontendLock" ]]; then
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    const newVer = process.argv[2];
    const lock = JSON.parse(fs.readFileSync(path, "utf8"));
    lock.version = newVer;
    if (lock.packages && lock.packages[""]) {
      lock.packages[""].version = newVer;
    }
    fs.writeFileSync(path, JSON.stringify(lock, null, 2) + "\n");
  ' "$FrontendLock" "$TargetVersion"
fi

# 4. Update samples/PackageConsumer/PackageConsumer.csproj
if [[ -f "$ConsumerProject" ]]; then
  sed -i.bak -E "s/<PackageReference Include=\"LogStudio\" Version=\"[^\"]+\"/<PackageReference Include=\"LogStudio\" Version=\"${TargetVersion}\"/" "$ConsumerProject"
  rm -f "$ConsumerProject.bak"
fi

# 5. Update documentation
for DocumentationFile in "$ReadmeFile" "$GuideFile"; do
  if [[ -f "$DocumentationFile" ]]; then
    sed -i.bak -E "s/--version ${CurrentVersion}/--version ${TargetVersion}/g" "$DocumentationFile"
    rm -f "$DocumentationFile.bak"
    sed -i.bak -E "s/-Version ${CurrentVersion}/-Version ${TargetVersion}/g" "$DocumentationFile"
    rm -f "$DocumentationFile.bak"
    sed -i.bak -E "s/\`${CurrentVersion}\` \(or \`${CurrentVersion}-rc\.1\`/\`${TargetVersion}\` \(or \`${TargetVersion}-rc\.1\`/g" "$DocumentationFile"
    rm -f "$DocumentationFile.bak"
    sed -i.bak -E "s/LogStudio\.${CurrentVersion}\.nupkg/LogStudio\.${TargetVersion}\.nupkg/g" "$DocumentationFile"
    rm -f "$DocumentationFile.bak"
  fi
done

# Verify with MSBuild if dotnet is available
if command -v dotnet >/dev/null 2>&1 && [[ -f "$LibraryProject" ]]; then
  ResolvedVersion="$(dotnet msbuild "$LibraryProject" -nologo -getProperty:PackageVersion 2>/dev/null || true)"
  if [[ -n "$ResolvedVersion" && "$ResolvedVersion" != "$TargetVersion" ]]; then
    printf 'Warning: MSBuild PackageVersion evaluated to %s, expected %s\n' "$ResolvedVersion" "$TargetVersion" >&2
  fi
fi

# 6. Optional commit, push, and git tag
if [[ "$PushChanges" == true ]]; then
  git -C "$ProjectRoot" add -- "${VersionFiles[@]}"
  git -C "$ProjectRoot" commit -m "Bump version to $TargetVersion"
  git -C "$ProjectRoot" push --set-upstream "$PushRemote" "$Branch"
  git -C "$ProjectRoot" tag "$TargetVersion"
  git -C "$ProjectRoot" push "$PushRemote" "refs/tags/$TargetVersion"
elif [[ "$CreateTag" == true ]]; then
  if command -v git >/dev/null 2>&1 && git -C "$ProjectRoot" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$ProjectRoot" tag -f "$TargetVersion"
    printf 'Updated git tag %s -> %s\n' "$TargetVersion" "$(git -C "$ProjectRoot" rev-parse --short HEAD)"
  else
    printf 'Warning: Cannot create git tag; not inside a git repository.\n' >&2
  fi
fi

printf '\nSuccessfully bumped version to %s\n' "$TargetVersion"
printf 'Updated:\n'
printf '  - Directory.Build.props\n'
printf '  - frontend/package.json\n'
printf '  - frontend/package-lock.json\n'
printf '  - samples/PackageConsumer/PackageConsumer.csproj\n'
printf '  - README.md\n'
printf '  - docs/guide.md\n'
if [[ "$CreateTag" == true || "$PushChanges" == true ]]; then
  printf '  - git tag %s\n' "$TargetVersion"
fi
