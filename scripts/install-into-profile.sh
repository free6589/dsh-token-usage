#!/usr/bin/env bash
# Install dsh-token-usage into a *running* DSH profile by name, from the fork.
#
#   scripts/install-into-profile.sh [--home DIR] [--profile NAME] [--ref REF] [--link]
#
# The stock `dsh` launcher resolves the profile as $DSH_HOME/profiles/<name>, so an
# unset DSH_HOME silently installs into ~/.dsh. When more than one instance is
# running, that is how a plugin lands in the wrong one: pass --home (or export
# DSH_HOME) explicitly.
#
# Must run outside the DSH file sandbox (the profile lives outside the session
# workspace, which the sandbox mounts read-only).
set -euo pipefail

home=${DSH_HOME:-$HOME/.dsh}
profile=${DSH_PROFILE:-web}
ref=00d8bb8
mode=git
repo_dir=$(cd "$(dirname "$0")/.." && pwd)

while test $# -gt 0; do
  case "$1" in
    --home) home=$2; shift 2 ;;
    --profile) profile=$2; shift 2 ;;
    --ref) ref=$2; shift 2 ;;
    --link) mode=link; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

dir="$home/profiles/$profile"
manifest="$dir/package.json"
test -f "$manifest" || { echo "no profile manifest at $manifest" >&2; exit 1; }
test -w "$dir" || { echo "profile dir not writable: $dir (run outside the DSH sandbox)" >&2; exit 1; }

if test "$mode" = git; then
  spec="github:free6589/dsh-token-usage#$ref"
else
  test -f "$repo_dir/lib/index.js" || { echo "build first: npm run build" >&2; exit 1; }
  spec="link:$repo_dir"
fi

echo "==> profile: $dir"
echo "==> spec:    $spec"
cp -a "$manifest" "$manifest.bak-$(date +%Y%m%d-%H%M%S)"

echo "==> installing with DSH_HOME=$home"
DSH_HOME="$home" dsh plugin --profile "$profile" add "$spec"

# `dsh plugin add` is a pnpm passthrough: it never touches dsh.profile.bundles,
# and a package that is not listed there is never mounted.
if jq -e '.dsh.profile.bundles | index("dsh-token-usage")' "$manifest" >/dev/null; then
  echo "==> bundle already registered"
else
  echo "==> registering the bundle in dsh.profile.bundles"
  jq '.dsh.profile.bundles += ["dsh-token-usage"] | .dsh.profile.bundles |= unique' \
    "$manifest" > "$manifest.new"
  mv "$manifest.new" "$manifest"
fi

echo "==> restart the instance so the profile re-composes:"
echo "    restart the service that serves $home (e.g. systemctl --user restart dsh-$profile.service)"
echo "==> then open the Web GUI and check the sidebar rate + Token usage panel"
