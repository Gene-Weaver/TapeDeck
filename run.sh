#!/usr/bin/env bash
# Launch TapeDeck. Creates the venv on first run. Pass --mock to run without a printer.
set -e
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  PY=$(command -v python3.12 || command -v python3.11 || command -v python3)
  "$PY" -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi
exec .venv/bin/python -m tapedeck "$@"
