#!/usr/bin/env sh
#
# BurnMeter one-line installer for macOS and Linux.
#
#     curl -fsSL https://raw.githubusercontent.com/OWNER/burnmeter/main/install.sh | sh
#
# Installs to ~/.claude/burnmeter and wires up the Claude Code statusline.
# There is no desktop-shortcut step on these platforms - see the README for
# launchd (macOS) and systemd --user (Linux) autostart.
#
# The repo is private, so you need a GitHub token with read access:
#
#     BURNMETER_TOKEN=github_pat_... sh -c "$(curl -fsSL .../install.sh)"
#
# The token is saved to ~/.claude/burnmeter/.token so updates keep working.
# Override the source with BURNMETER_REPO=you/your-fork before running.

set -eu

REPO="${BURNMETER_REPO:-OWNER/burnmeter}"
BRANCH="${BURNMETER_BRANCH:-main}"
TOKEN="${BURNMETER_TOKEN:-}"
DEST="$HOME/.claude/burnmeter"

printf '\n  BurnMeter\n  what your Claude Code usage is worth\n\n'

if ! command -v node >/dev/null 2>&1; then
  printf '  Node.js is required and was not found on your PATH.\n'
  printf '  Install it from https://nodejs.org and run this again.\n\n'
  exit 1
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then
  printf '  Node %s found, but BurnMeter needs 18 or newer.\n\n' "$(node -v)"
  exit 1
fi
printf '  + Node %s\n' "$(node -v)"

TMP=$(mktemp -d 2>/dev/null || mktemp -d -t burnmeter)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

printf '  . downloading %s@%s\n' "$REPO" "$BRANCH"
if ! curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" -o "$TMP/src.tar.gz"; then
  printf '  x could not download. Check the repo name, or that it is public.\n\n'
  exit 1
fi

tar -xzf "$TMP/src.tar.gz" -C "$TMP"
SRC=$(find "$TMP" -maxdepth 1 -type d -name '*-*' | head -1)
[ -n "$SRC" ] || { printf '  x archive looked empty\n\n'; exit 1; }

printf '  . installing\n'
node "$SRC/install.js"

printf '\n  Done.\n\n'
printf '  Start it:   node "%s/server.js"\n' "$DEST"
printf '  Then open:  http://127.0.0.1:4317\n\n'
printf '  Keep it running in the background:\n'
printf '    nohup node "%s/server.js" >/tmp/burnmeter.log 2>&1 &\n\n' "$DEST"
