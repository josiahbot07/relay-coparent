#!/bin/bash
# Relay control script — start, stop, restart, status

RELAY_DIR="${HOME}/.coparent-relay"
LOCK_FILE="${RELAY_DIR}/relay.lock"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

get_pid() {
  if [ -f "$LOCK_FILE" ]; then
    pid=$(cat "$LOCK_FILE" | grep -o '"pid":[0-9]*' | grep -o '[0-9]*')
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
  fi
  return 1
}

case "${1:-status}" in
  start)
    if pid=$(get_pid); then
      echo "Already running (PID: $pid)"
      exit 1
    fi
    rm -f "$LOCK_FILE"
    cd "$PROJECT_DIR"
    nohup bun run src/relay.ts > "${RELAY_DIR}/relay.log" 2>&1 &
    sleep 2
    if pid=$(get_pid); then
      echo "Started (PID: $pid)"
    else
      echo "Failed to start — check ${RELAY_DIR}/relay.log"
      exit 1
    fi
    ;;
  stop)
    if pid=$(get_pid); then
      kill "$pid" 2>/dev/null
      sleep 1
      kill -9 "$pid" 2>/dev/null
      rm -f "$LOCK_FILE"
      echo "Stopped (PID: $pid)"
    else
      rm -f "$LOCK_FILE"
      echo "Not running"
    fi
    ;;
  restart)
    "$0" stop
    sleep 1
    "$0" start
    ;;
  status)
    if pid=$(get_pid); then
      echo "Running (PID: $pid)"
    else
      echo "Not running"
    fi
    ;;
  logs)
    tail -f "${RELAY_DIR}/relay.log"
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs}"
    exit 1
    ;;
esac
