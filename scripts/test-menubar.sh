#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$("$ROOT/scripts/build-menubar.sh")"
BIN="$APP_DIR/Contents/MacOS/WebMCPMenuBar"

"$BIN" --self-test
