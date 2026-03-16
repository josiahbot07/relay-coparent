#!/bin/bash
# Restart coparent relay launchd services

LAUNCH_DIR="$HOME/Library/LaunchAgents"
UID_NUM=$(id -u)

MAIN_PLIST="com.claude.coparent-relay.plist"
OPTIONAL_PLISTS=(
  "com.claude.coparent-briefing.plist"
  "com.claude.coparent-checkin.plist"
  "com.claude.coparent-compact.plist"
  "com.claude.coparent-legal-refresh.plist"
)

# Check main plist exists
if [ ! -f "$LAUNCH_DIR/$MAIN_PLIST" ]; then
  echo "ERROR: $MAIN_PLIST not installed in $LAUNCH_DIR"
  echo "Run 'bun run setup:launchd' first."
  exit 1
fi

restart_service() {
  local plist="$1"
  local path="$LAUNCH_DIR/$plist"

  if [ ! -f "$path" ]; then
    return 1
  fi

  echo "Restarting $plist..."
  launchctl bootout "gui/$UID_NUM" "$path" 2>/dev/null
  sleep 1
  launchctl bootstrap "gui/$UID_NUM" "$path"
  return 0
}

# Restart main relay
restart_service "$MAIN_PLIST"

# Restart optional agents if installed
for plist in "${OPTIONAL_PLISTS[@]}"; do
  restart_service "$plist" && echo "  ✓ $plist"
done

# Wait for services to settle
sleep 2

# Verify
echo ""
echo "Running coparent agents:"
launchctl list | grep coparent || echo "  (none found)"
echo ""
echo "All claude agents:"
launchctl list | grep claude || echo "  (none found)"
