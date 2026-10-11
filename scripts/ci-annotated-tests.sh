#!/usr/bin/env bash
# Runs a test command and, when it fails, publishes the failing-test section as ONE error annotation (annotations are readable through the public API, the raw job log is not), so that a
# failure that cannot be reproduced locally can still be diagnosed. The exit code of the command is preserved.
set +e
out="$(mktemp)"
"$@" 2>&1 | tee "$out"
code=${PIPESTATUS[0]}
if [ "$code" -ne 0 ]; then
  detail="$(awk '/failing tests/{f=1} f' "$out" | head -60 | sed 's/%/%25/g' | sed ':a;N;$!ba;s/\n/%0A/g')"
  [ -z "$detail" ] && detail="$(grep -E '^\s*(✖|not ok)' "$out" | head -30 | sed 's/%/%25/g' | sed ':a;N;$!ba;s/\n/%0A/g')"
  echo "::error title=tests failed (exit ${code})::${detail}"
fi
exit "$code"
