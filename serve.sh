#!/bin/sh
# Serve this directory over HTTP so a userscript manager can install
# threadside.user.js from a URL. Firefox extensions cannot read file:// paths,
# so pasting or serving are the only two options.
#
# Once installed this way, the manager remembers the URL, so "Check for updates"
# in its dashboard reinstalls whatever is on disk right now.

set -e

PORT="${PORT:-8731}"
DIR="$(cd "$(dirname "$0")" && pwd)"

printf '\nInstall URL:  http://127.0.0.1:%s/threadside.user.js\n' "$PORT"
printf 'Open that in Firefox and the userscript manager will offer to install.\n'
printf 'Ctrl+C to stop.\n\n'

exec python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$DIR"
