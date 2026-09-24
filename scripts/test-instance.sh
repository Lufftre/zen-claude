#!/bin/sh
# Launches a throwaway Zen profile with a copy of the extension that talks to port 8766, so tests don't collide with
# a real browser holding the default port. Use with ZEN_CLAUDE_PORT=8766.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
copy=${TMPDIR:-/tmp}/zen-claude-test-ext
rm -rf "$copy" && cp -R "$root/extension" "$copy"
sed -i '' 's/port: 8765/port: 8766/g' "$copy/background.js"
exec "$root/node_modules/.bin/web-ext" run --source-dir "$copy" --firefox=/Applications/Zen.app/Contents/MacOS/zen \
  --no-reload --pref zen.welcome-screen.seen=true --pref extensions.experiments.enabled=true "$@"
