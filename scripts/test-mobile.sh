#!/bin/bash
#
# test-mobile.sh — Launch guéridon for mobile testing
#
# Prerequisites:
#   - Chrome Debug running (CDP on :9222)
#     Launch: ~/Repos/skill-chrome-log/scripts/chrome-debug.sh
#     Or: open ~/Applications/Chrome\ Debug.app
#   - webctl configured with cdp_endpoint: http://localhost:9222
#     (check: cat ~/Library/Application\ Support/webctl/config.json)
#
# Usage:
#   scripts/test-mobile.sh              # Start servers, open mobile viewport
#   scripts/test-mobile.sh --stop       # Tear down background servers
#   scripts/test-mobile.sh --status     # Check what's running
#   scripts/test-mobile.sh --desktop    # Start without mobile emulation
#
# After running, interact via webctl:
#   webctl screenshot -p /tmp/gueridon.png   # Capture current state
#   webctl click 'text=Select folder'        # Click element
#   webctl type 'textarea' --text 'hello'    # Type into input
#   webctl snapshot                          # DOM snapshot for debugging
#
# Mobile viewport uses CDP Emulation.setDeviceMetricsOverride
# to simulate iPhone 14 Pro (393x852 @3x). Reset with --desktop.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CDP_PORT=9222
DEV_PORT=5173
BRIDGE_PORT=3001
PID_DIR="$PROJECT_DIR/.test-pids"
# APP_URL set dynamically: --prod uses bridge (:3001), default uses Vite (:5173)
APP_URL="http://localhost:$DEV_PORT"

# iPhone 14 Pro
MOBILE_WIDTH=393
MOBILE_HEIGHT=852
MOBILE_DPR=3

# --- Helpers ---

log() { echo "→ $*"; }
warn() { echo "⚠ $*" >&2; }

check_port() {
    curl -sf "http://localhost:$1" >/dev/null 2>&1
}

wait_for_port() {
    local port=$1 name=$2 timeout=${3:-15} elapsed=0
    while ! check_port "$port"; do
        sleep 1
        elapsed=$((elapsed + 1))
        if [ "$elapsed" -ge "$timeout" ]; then
            warn "$name didn't start within ${timeout}s"
            return 1
        fi
    done
    log "$name ready on :$port (${elapsed}s)"
}

read_pid() {
    local file="$PID_DIR/$1.pid"
    [ -f "$file" ] && cat "$file" || true
}

is_alive() {
    [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null
}

# Send a CDP command to the guéridon page via its DevTools WebSocket
cdp_send() {
    local method=$1 params=$2
    local page_ws
    page_ws=$(curl -sf "http://localhost:$CDP_PORT/json" | \
        node -e "
            let d='';
            process.stdin.on('data',c=>d+=c);
            process.stdin.on('end',()=>{
                const pages=JSON.parse(d);
                const p=pages.find(p=>p.url.includes('localhost:$DEV_PORT')||p.url.includes('localhost:$BRIDGE_PORT'));
                if(p) console.log(p.webSocketDebuggerUrl);
                else process.exit(1);
            });
        ")

    if [ -z "$page_ws" ]; then
        warn "No guéridon page found in Chrome Debug tabs"
        return 1
    fi

    node -e "
        const ws = new (require('ws'))('$page_ws');
        ws.on('open', () => ws.send(JSON.stringify({id:1, method:'$method', params:$params})));
        ws.on('message', d => { console.log(d.toString()); ws.close(); });
        ws.on('error', e => { console.error(e.message); process.exit(1); });
    "
}

# --- Commands ---

do_status() {
    local dev_pid bridge_pid
    dev_pid=$(read_pid dev)
    bridge_pid=$(read_pid bridge)

    echo "Chrome Debug (:$CDP_PORT): $(check_port $CDP_PORT && echo "running" || echo "NOT RUNNING")"
    echo "Dev server   (:$DEV_PORT): $(is_alive "$dev_pid" && echo "running (pid $dev_pid)" || echo "stopped")"
    echo "Bridge       (:$BRIDGE_PORT): $(is_alive "$bridge_pid" && echo "running (pid $bridge_pid)" || echo "stopped")"
    echo "webctl:       $(webctl pages 2>/dev/null | grep -q localhost && echo "connected" || echo "not connected")"
}

do_stop() {
    local dev_pid bridge_pid
    dev_pid=$(read_pid dev)
    bridge_pid=$(read_pid bridge)

    is_alive "$dev_pid" && log "Stopping dev (pid $dev_pid)" && kill "$dev_pid" 2>/dev/null || true
    is_alive "$bridge_pid" && log "Stopping bridge (pid $bridge_pid)" && kill "$bridge_pid" 2>/dev/null || true
    webctl stop 2>/dev/null && log "Stopped webctl" || true

    rm -rf "$PID_DIR"
    log "Cleaned up"
}

set_mobile_viewport() {
    log "Setting mobile viewport (${MOBILE_WIDTH}x${MOBILE_HEIGHT} @${MOBILE_DPR}x)..."
    cdp_send "Emulation.setDeviceMetricsOverride" \
        "{\"width\":$MOBILE_WIDTH,\"height\":$MOBILE_HEIGHT,\"deviceScaleFactor\":$MOBILE_DPR,\"mobile\":true}" \
        >/dev/null
    log "Mobile viewport active"
}

clear_mobile_viewport() {
    log "Clearing mobile viewport override..."
    cdp_send "Emulation.clearDeviceMetricsOverride" "{}" >/dev/null
    log "Desktop viewport restored"
}

do_start() {
    local mobile=${1:-true}
    local prod=${2:-false}

    # 0. Check Chrome Debug
    if ! check_port $CDP_PORT; then
        warn "Chrome Debug not running on :$CDP_PORT"
        warn "Launch it: ~/Repos/skill-chrome-log/scripts/chrome-debug.sh"
        warn "Or: open ~/Applications/Chrome\\ Debug.app"
        exit 1
    fi
    log "Chrome Debug running"

    mkdir -p "$PID_DIR"

    if [ "$prod" = true ]; then
        # --- Production mode: build + bridge serves everything on :3001 ---
        APP_URL="http://localhost:$BRIDGE_PORT"

        log "Building for production..."
        cd "$PROJECT_DIR"
        npm run build

        # Bridge (serves static files + WS)
        local bridge_pid
        bridge_pid=$(read_pid bridge)
        if is_alive "$bridge_pid"; then
            log "Bridge already running (pid $bridge_pid)"
        else
            log "Starting bridge..."
            npm run bridge > "$PID_DIR/bridge.log" 2>&1 &
            echo $! > "$PID_DIR/bridge.pid"
            sleep 2
            bridge_pid=$(read_pid bridge)
            if is_alive "$bridge_pid"; then
                log "Bridge started (pid $bridge_pid)"
            else
                warn "Bridge failed to start — check $PID_DIR/bridge.log"
                exit 1
            fi
        fi
    else
        # --- Dev mode: Vite :5173 + bridge :3001 ---

        # 1. Dev server
        local dev_pid
        dev_pid=$(read_pid dev)
        if is_alive "$dev_pid"; then
            log "Dev server already running (pid $dev_pid)"
        else
            log "Starting dev server..."
            cd "$PROJECT_DIR"
            npm run dev > "$PID_DIR/dev.log" 2>&1 &
            echo $! > "$PID_DIR/dev.pid"
            wait_for_port $DEV_PORT "Dev server" || exit 1
        fi

        # 2. Bridge
        local bridge_pid
        bridge_pid=$(read_pid bridge)
        if is_alive "$bridge_pid"; then
            log "Bridge already running (pid $bridge_pid)"
        else
            log "Starting bridge..."
            cd "$PROJECT_DIR"
            npm run bridge > "$PID_DIR/bridge.log" 2>&1 &
            echo $! > "$PID_DIR/bridge.pid"
            sleep 2
            bridge_pid=$(read_pid bridge)
            if is_alive "$bridge_pid"; then
                log "Bridge started (pid $bridge_pid)"
            else
                warn "Bridge failed to start — check $PID_DIR/bridge.log"
                exit 1
            fi
        fi
    fi

    # 3. webctl → Chrome Debug
    log "Connecting webctl to Chrome Debug..."
    webctl start 2>/dev/null || true

    # 4. Navigate
    log "Navigating to $APP_URL"
    webctl navigate "$APP_URL" 2>/dev/null
    sleep 1

    # 5. Mobile viewport (unless --desktop)
    if [ "$mobile" = true ]; then
        set_mobile_viewport
    fi

    log ""
    log "Ready! guéridon at $APP_URL"
    log ""
    log "  webctl screenshot -p /tmp/gueridon.png"
    log "  webctl snapshot"
    log "  webctl click 'text=...'"
    log "  scripts/test-mobile.sh --stop"
}

# --- Main ---

case "${1:-}" in
    --stop)     do_stop ;;
    --status)   do_status ;;
    --prod)     do_start true true ;;    # Build + bridge serves everything
    --desktop)  do_start false ;;
    --mobile)   set_mobile_viewport ;;   # Toggle on existing page
    --help|-h)  head -25 "$0" | grep '^#' | sed 's/^# \?//' ;;
    *)          do_start true ;;
esac
