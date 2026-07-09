#!/bin/bash
# Post-file-edit hook: detect local (function/method-scoped) imports in Python files.
# Returns agent_message telling the model to move them to the top of the file.

input=$(cat)
file_path=$(echo "$input" | jq -r '.file_path // .path // empty')

# Only check Python files
if [[ "$file_path" != *.py ]]; then
  echo '{"status": "pass"}'
  exit 0
fi

# Skip test files — they sometimes have legitimate conditional imports
if [[ "$file_path" == *test_* ]] || [[ "$file_path" == *_test.py ]]; then
  echo '{"status": "pass"}'
  exit 0
fi

if [[ ! -f "$file_path" ]]; then
  echo '{"status": "pass"}'
  exit 0
fi

# Detect indented import/from statements (local imports)
local_imports=$(grep -n '^\s\+\(from \|import \)' "$file_path" 2>/dev/null | grep -v '^\s*#' | head -5)

if [[ -n "$local_imports" ]]; then
  cat <<EOF
{
  "additional_context": "VIOLATION: Local imports detected in $file_path. Move ALL imports to the top of the file. Never use function-scoped or method-scoped imports. Lines with local imports:\n$local_imports"
}
EOF
  exit 0
fi

echo '{"status": "pass"}'
exit 0
