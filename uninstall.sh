#!/usr/bin/env bash
# Uninstall dsh-imagegen from a DeepSeek Harness agent preset directory.
#
# Usage: ./uninstall.sh --preset <id> | --preset-dir <dir>
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRESETS_ROOT="${DSH_HOME:-$HOME/.dsh}/.agent-presets"
ROW_ID="tool-imagegen"

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
      sed -n '2,6p' "$0"
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
[[ -n "$preset_dir" ]] || die "specify --preset <id> or --preset-dir <dir>"
[[ -d "$preset_dir" ]] || die "preset directory not found: $preset_dir"

COMPOSITION="$preset_dir/agent.cordis.yml"
if [[ -f "$COMPOSITION" ]]; then
  # Remove the composition row and its section comment (exact block as written
  # by install.sh), then any stray row.
  python3 - "$COMPOSITION" <<'PYEOF'
import re, sys
path = sys.argv[1]
text = open(path, encoding='utf-8').read()
block = re.compile(
    r"\n# ── dsh-imagegen \(image_gen \+ image_vision\) ─+─*\n"
    r"- id: tool-imagegen\n"
    r"  name: '\./imagegen-tool\.js'\n",
    re.MULTILINE,
)
text, n = block.subn('\n', text)
if not n:
    text = re.sub(r"\n- id: tool-imagegen\n[^\n]*\n", '\n', text, count=1)
open(path, 'w', encoding='utf-8').write(text)
print('removed composition row' if n else 'no composition row found')
PYEOF
fi

rm -f "$preset_dir/imagegen-tool.js"
rm -f "$preset_dir/scripts/codex-imagegen.mjs" "$preset_dir/scripts/codex-vision.mjs" "$preset_dir/scripts/image_gen.py"
say() { printf '%s\n' "$*"; }
say "removed dsh-imagegen files from $preset_dir"
