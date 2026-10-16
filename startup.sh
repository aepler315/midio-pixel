#!/bin/sh
set -eu

# Container launchers mount the repo at /workspace. Local checkouts use the
# directory that contains this script.
if [ -d /workspace ] && [ -f /workspace/tools/serve.js ]; then
  cd /workspace
else
  cd "$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
fi

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8080}"
LOG="${STARTUP_LOG:-/tmp/app-startup.log}"
READY_MARK="${READY_MARK:-Super Maudio World}"

ready() {
  # Require the Super Maudio World document, not any HTTP 200 on the port.
  body=$(curl -sf --max-time 2 "http://${HOST}:${PORT}/" || true)
  printf '%s' "$body" | grep -Fq "$READY_MARK"
}

if ready; then
  exit 0
fi

if [ -n "${SERVER_CMD:-}" ]; then
  # Test hook: run an explicit command instead of the real server.
  sh -c "$SERVER_CMD" >>"$LOG" 2>&1 &
else
  # Super Maudio World + Soulseek bridge (loopback-only by default)
  PORT="$PORT" HOST="$HOST" node tools/serve.js >>"$LOG" 2>&1 &
fi
pid=$!

for i in 1 2 3 4 5 6 7 8 9 10; do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "startup.sh: server process exited before becoming ready. See $LOG" >&2
    exit 1
  fi
  if ready; then
    exit 0
  fi
  sleep 0.3
done

echo "startup.sh: server on ${HOST}:${PORT} never became ready. See $LOG" >&2
kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
exit 1
