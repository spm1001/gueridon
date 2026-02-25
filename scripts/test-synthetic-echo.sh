#!/bin/bash
# Test: does CC faithfully echo the [guéridon:system] prefix?
#
# Sends a synthetic-prefixed message through claude -p in stream-json mode,
# captures the echoed "user" event, and checks whether the prefix survived.
#
# Run from the gueridon repo root:
#   bash scripts/test-synthetic-echo.sh
#
# Expected output:
#   PASS — prefix survived the CC roundtrip
# or:
#   FAIL — prefix was modified or missing

set -euo pipefail

PREFIX="[guéridon:system]"
BODY="Echo test — does this prefix survive?"
FULL_MSG="${PREFIX} ${BODY}"

echo "Sending: ${FULL_MSG}"
echo "---"

# Send via stream-json input, capture all stdout
OUTPUT=$(echo "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"${FULL_MSG}. Reply with just the word OK.\"}}" \
  | claude -p --verbose \
      --input-format stream-json \
      --output-format stream-json \
      --no-input \
      --max-turns 1 \
      2>/dev/null)

# Extract the echoed user event (type: "user") and pull the content field
ECHOED=$(echo "$OUTPUT" \
  | grep '"type":"user"' \
  | head -1 \
  | python3 -c "import sys, json; e=json.load(sys.stdin); print(e.get('message',{}).get('content',''))")

echo "Echoed: ${ECHOED}"
echo "---"

if [[ "$ECHOED" == "${FULL_MSG}"* ]]; then
  echo "PASS — prefix survived the CC roundtrip"
  exit 0
else
  echo "FAIL — prefix was modified or missing"
  echo "Expected to start with: ${FULL_MSG}"
  echo "Got: ${ECHOED}"
  exit 1
fi
