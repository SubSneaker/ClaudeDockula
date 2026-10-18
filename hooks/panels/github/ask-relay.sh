#!/bin/sh
# The background reviewer's PermissionRequest hook: hands one permission ask to the GitHub panel through files,
# then prints the panel's answer. With no answer in 10 minutes, the ask is denied.
dir="$1"
id="$(date +%s)-$$"
answer="$dir/answer-$id.json"
cat > "$dir/ask-$id.tmp" && mv "$dir/ask-$id.tmp" "$dir/ask-$id.json"
i=0
# The panel's answer ends in `}}}`: a file still being written is not read yet. A review that ended took the folder.
while ! grep -qs '}}}$' "$answer"; do
  i=$((i+1))
  if [ ! -d "$dir" ]; then
    echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"The review ended"}}}'
    exit 0
  fi
  if [ "$i" -gt 600 ]; then
    echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"No answer in time"}}}'
    exit 0
  fi
  sleep 1
done
# An answer may allow a rule for this review only, never in a settings file.
if grep -qs '"destination":"[A-Za-z]*Settings"' "$answer"; then
  echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Refused an answer that would change settings"}}}'
  exit 0
fi
cat "$answer"
