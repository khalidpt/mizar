#!/bin/sh
# Everything goes to the CLI; `serve` (the default) starts the web app with the configured sign-in.
set -e
cd /app
[ $# -eq 0 ] && set -- serve
exec node cli/mizar.mjs "$@"
