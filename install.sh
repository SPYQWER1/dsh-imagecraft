#!/usr/bin/env bash
# Install dsh-imagegen tools (image_gen + image_vision) into a DeepSeek
# Harness agent preset directory.
#
# Usage:
#   ./install.sh --preset <id>            # install into ~/.dsh/.agent-presets/<id>
#   ./install.sh --preset-dir <dir>       # install into an explicit preset dir
#   ./install.sh                          # list detected presets and pick one
#
# The preset's agent.cordis.yml must exist (create a preset first — e.g. by
# copying a built-in one, or via the harness UI). The imagegen-tool.js plugin
# row is appended idempotently; run the script again to update the files.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRESETS_ROOT="${DSH_HOME:-$HOME/.dsh}/.agent-presets"
ROW_ID="tool-imagegen"
ROW_NAME="./imagegen-tool.js"

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

preset_dir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --preset)
      [[ $# -ge 2 ]] || die "--preset requires an id"
      preset_dir="$PRESETS_ROOT/$2"
      shift 2
      ;;
    --preset-dir)
      [[ $# -ge 2 ]] || die "--preset-dir requires a path"
      preset_dir="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,11p' "$0"
      exit 0
      ;;
    *)
      die "unknown argument: $1 (see --help)"
      ;;
  esac
done

if [[ -z "$preset_dir" ]]; then
  if [[ -d "$PRESETS_ROOT" ]]; then
    mapfile -t presets < <(find "$PRESETS_ROOT" -maxdepth 1 -mindepth 1 -type d -printf '%f\n' | sort)
  else
    presets=()
  fi
  if [[ ${#presets[@]} -eq 0 ]]; then
    die "no presets found under $PRESETS_ROOT — create one first (copy a built-in preset or use the harness UI), then rerun with --preset <id>"
  fi
  say "Detected presets:"
  for i in "${!presets[@]}"; do say "  $((i + 1)). ${presets[$i]}"; done
  read -r -p "Pick a preset number: " choice
  [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#presets[@]} )) || die "invalid choice"
  preset_dir="$PRESETS_ROOT/${presets[$((choice - 1))]}"
fi

[[ -d "$preset_dir" ]] || die "preset directory not found: $preset_dir"
COMPOSITION="$preset_dir/agent.cordis.yml"
[[ -f "$COMPOSITION" ]] || die "no agent.cordis.yml in $preset_dir — a preset needs its composition file"

# 1. Copy plugin and transports (idempotent overwrite).
cp "$REPO_DIR/imagegen-tool.js" "$preset_dir/imagegen-tool.js"
mkdir -p "$preset_dir/scripts"
cp "$REPO_DIR"/scripts/codex-imagegen.mjs "$REPO_DIR"/scripts/codex-vision.mjs "$preset_dir/scripts/"
if [[ -f "$REPO_DIR/scripts/image_gen.py" ]]; then
  cp "$REPO_DIR/scripts/image_gen.py" "$preset_dir/scripts/"
fi

# 2. Append the composition row if absent (idempotent).
if grep -q "^[[:space:]]*- id: $ROW_ID$" "$COMPOSITION"; then
  say "composition row '$ROW_ID' already present — files updated."
else
  cat >> "$COMPOSITION" <<EOF

# ── dsh-imagegen (image_gen + image_vision) ────────────────────────────────
- id: $ROW_ID
  name: '$ROW_NAME'
EOF
  say "appended composition row '$ROW_ID' to $COMPOSITION"
fi

say "installed. Start a new session with this preset (or restart the current one) to get image_gen / image_vision."
say "Auth: uses the ChatGPT login state (~/.codex/auth.json from 'codex login', or the OPENAI_CODEX_* credentials); no API key needed."
