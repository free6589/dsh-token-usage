#!/usr/bin/env bash
# Link, build and install dsh-token-usage into a local DSH web profile.
#
#   scripts/install-local.sh [--no-build] [--no-link] [--profile DIR] [--harness DIR]
#
# Environment overrides:
#   DSH_HARNESS_ROOT   Harness checkout used as dependency source
#                      (default: /home/fish/projects_mine/deepseek-harness)
#   DSH_PROFILE_DIR    Target profile directory
#                      (default: $DSH_HOME/profiles/$DSH_PROFILE, else ~/.dsh/profiles/web)
#   DSH_LINK_SKIP_BRIDGE=1  skip the Harness packages/external manifest bridge
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

harness_root=${DSH_HARNESS_ROOT:-/home/fish/projects_mine/deepseek-harness}
profile_dir=${DSH_PROFILE_DIR:-${DSH_HOME:-$HOME/.dsh}/profiles/${DSH_PROFILE:-web}}
do_link=1
do_build=1

while test $# -gt 0; do
  case "$1" in
    --harness) harness_root=$2; shift 2 ;;
    --profile) profile_dir=$2; shift 2 ;;
    --no-link) do_link=0; shift ;;
    --no-build) do_build=0; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

harness_root=$(cd "$harness_root" && pwd)
profile_dir=${profile_dir%/}
package_name=$(node -p "require('$root/package.json').name")

echo "==> repo:     $root"
echo "==> harness:  $harness_root"
echo "==> profile:  $profile_dir"

if test "$do_link" = 1; then
  echo "==> linking node_modules from the Harness checkout"
  # The linker skips the packages/external manifest bridge by itself when the
  # Harness root is an installed release or read-only; DSH_LINK_SKIP_BRIDGE=1
  # forces the skip for a checkout you must not touch.
  node scripts/link-dsh-workspace.mjs "$harness_root" "$root/node_modules"
fi

if test "$do_build" = 1; then
  echo "==> building lib/ from src/"
  npm run build
fi

test -f "$root/lib/index.js" || { echo "build did not produce lib/index.js" >&2; exit 1; }
test -d "$profile_dir" || { echo "profile directory not found: $profile_dir" >&2; exit 1; }
if ! test -w "$profile_dir/node_modules" && ! test -w "$profile_dir"; then
  echo "profile directory is not writable: $profile_dir" >&2
  echo "run this step outside the read-only sandbox (it writes the profile install)" >&2
  exit 1
fi

echo "==> installing $package_name into $profile_dir"
mkdir -p "$profile_dir/node_modules"
ln -sfn "$root" "$profile_dir/node_modules/$package_name"

node --input-type=module - "$profile_dir/package.json" "$package_name" "$root" <<'NODE'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const [manifestPath, name, source] = process.argv.slice(2)
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {}
manifest.dependencies ??= {}
manifest.dependencies[name] = `link:${source}`
const profile = (manifest.dsh ??= {}).profile ??= {}
const bundles = (profile.bundles ??= [])
if (!bundles.includes(name)) bundles.push(name)
if (existsSync(manifestPath)) {
  copyFileSync(manifestPath, `${manifestPath}.bak-install-local-${Date.now()}`)
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`registered ${name} as a profile dependency and bundle`)
NODE

echo "==> done. Restart the DSH web profile to load $package_name."
