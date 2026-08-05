#!/bin/sh
# Load publishing tokens from .env.publish (gitignored) and exec the given
# command with them in the environment. vsce reads VSCE_PAT and ovsx reads
# OVSX_PAT, so neither token ever has to appear on a command line or in shell
# history.
set -e

env_file="$(dirname "$0")/../.env.publish"

if [ -f "$env_file" ]; then
  set -a
  . "$env_file"
  set +a
else
  echo "with-env.sh: $env_file not found." >&2
  echo "Copy .env.publish.example to .env.publish and fill in your tokens." >&2
  exit 1
fi

exec "$@"
