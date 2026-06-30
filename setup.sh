#!/usr/bin/env bash
# setup.sh — Install copilot-api as a macOS startup item and configure Claude Code
# Usage: bash setup.sh
# Tested on macOS with mise for Node version management.

set -euo pipefail

# ─── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[info]${NC} $*"; }
success() { echo -e "${GREEN}[ok]${NC}   $*"; }
warn()    { echo -e "${YELLOW}[warn]${NC} $*"; }
die()     { echo -e "${RED}[error]${NC} $*" >&2; exit 1; }

# ─── Config ───────────────────────────────────────────────────────────────────
REPO_URL="https://github.com/Ebonsignori/copilot-api"
INSTALL_DIR="${HOME}/Projects/copilot-api"
NODE_VERSION="24"                        # minimum major version
LAUNCH_AGENT_LABEL="com.copilot-api.start"
LAUNCH_AGENT_PLIST="${HOME}/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist"
STARTUP_SCRIPT="${HOME}/.local/bin/copilot-api-start.sh"
CLAUDE_SETTINGS="${HOME}/.claude/settings.json"
PROXY_PORT=4141

# ─── 0. Platform check ────────────────────────────────────────────────────────
[[ "$(uname)" == "Darwin" ]] || die "This script is for macOS only."

echo ""
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║       copilot-api × Claude Code setup           ║"
echo "  ╚══════════════════════════════════════════════════╝"
echo ""

# ─── 1. Resolve node ─────────────────────────────────────────────────────────
info "Looking for Node.js ${NODE_VERSION}+..."

NODE_BIN=""

# Prefer mise-managed node (same as original setup)
if command -v mise &>/dev/null; then
  MISE_NODE="$(mise where node 2>/dev/null || true)"
  if [[ -n "$MISE_NODE" && -x "${MISE_NODE}/bin/node" ]]; then
    NODE_BIN="${MISE_NODE}/bin/node"
    NODE_DIR="${MISE_NODE}/bin"
    info "Using mise-managed node: ${NODE_BIN}"
  fi
fi

# Fall back to system / brew / nvm node
if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
  NODE_DIR="$(dirname "$NODE_BIN" 2>/dev/null || true)"
fi

[[ -x "$NODE_BIN" ]] || die "Node.js not found. Install it via https://mise.jdx.dev or https://nodejs.org and re-run."

ACTUAL_VERSION="$("$NODE_BIN" --version | sed 's/v//' | cut -d. -f1)"
(( ACTUAL_VERSION >= NODE_VERSION )) || die "Node ${NODE_VERSION}+ required, found v${ACTUAL_VERSION}."
success "Node $("$NODE_BIN" --version) at ${NODE_BIN}"

NPM_BIN="${NODE_DIR}/npm"
[[ -x "$NPM_BIN" ]] || NPM_BIN="$(command -v npm)" || die "npm not found."

# ─── 2. Clone / update repo ──────────────────────────────────────────────────
if [[ -d "${INSTALL_DIR}/.git" ]]; then
  info "Repo already cloned — pulling latest..."
  git -C "$INSTALL_DIR" pull --ff-only || warn "git pull failed; continuing with existing code."
else
  info "Cloning ${REPO_URL} → ${INSTALL_DIR}..."
  git clone "$REPO_URL" "$INSTALL_DIR"
fi
success "Repo ready at ${INSTALL_DIR}"

# ─── 3. Install deps & build ─────────────────────────────────────────────────
info "Installing npm dependencies..."
"$NPM_BIN" install --prefix "$INSTALL_DIR" --silent

info "Building TypeScript..."
"$NPM_BIN" run --prefix "$INSTALL_DIR" build
success "Build complete — dist/ is ready."

# ─── 4. GitHub auth ──────────────────────────────────────────────────────────
TOKEN_FILE="${HOME}/.local/share/copilot-api/github_token"
if [[ -f "$TOKEN_FILE" ]]; then
  success "GitHub token already exists — skipping auth."
else
  info "Running GitHub device auth flow (you'll need to paste a code at github.com/login/device)..."
  "$NODE_BIN" "${INSTALL_DIR}/dist/main.js" auth
  [[ -f "$TOKEN_FILE" ]] || die "Auth failed — token file not created."
  success "GitHub token saved."
fi

# ─── 5. Write startup script ─────────────────────────────────────────────────
info "Writing startup script to ${STARTUP_SCRIPT}..."
mkdir -p "$(dirname "$STARTUP_SCRIPT")"
cat > "$STARTUP_SCRIPT" <<STARTUP
#!/bin/bash
export PATH="${NODE_DIR}:\$PATH"
exec "${NODE_BIN}" "${INSTALL_DIR}/dist/main.js" start
STARTUP
chmod +x "$STARTUP_SCRIPT"
success "Startup script written."

# ─── 6. Install LaunchAgent ──────────────────────────────────────────────────
info "Installing LaunchAgent plist..."
mkdir -p "${HOME}/Library/LaunchAgents"
cat > "$LAUNCH_AGENT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCH_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${STARTUP_SCRIPT}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>/tmp/copilot-api.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/copilot-api.error.log</string>
</dict>
</plist>
PLIST

# Unload first (silently, in case it was already loaded)
launchctl unload "$LAUNCH_AGENT_PLIST" 2>/dev/null || true
launchctl load -w "$LAUNCH_AGENT_PLIST"
success "LaunchAgent loaded — proxy will auto-start on login."

# ─── 7. Wait for proxy to be ready ──────────────────────────────────────────
info "Waiting for proxy to start on port ${PROXY_PORT}..."
MAX_WAIT=20
for i in $(seq 1 $MAX_WAIT); do
  if curl -sf "http://localhost:${PROXY_PORT}/v1/models" -o /dev/null 2>/dev/null; then
    success "Proxy is up and responding."
    break
  fi
  sleep 1
  if (( i == MAX_WAIT )); then
    warn "Proxy didn't respond within ${MAX_WAIT}s — check /tmp/copilot-api.error.log"
  fi
done

# ─── 8. Configure Claude Code ────────────────────────────────────────────────
info "Configuring Claude Code settings..."
mkdir -p "${HOME}/.claude"

# Merge our env block into existing settings.json (preserve any existing keys)
if [[ -f "$CLAUDE_SETTINGS" ]]; then
  # Back up existing settings
  cp "$CLAUDE_SETTINGS" "${CLAUDE_SETTINGS}.bak"
  info "Backed up existing settings to ${CLAUDE_SETTINGS}.bak"
fi

# Use node/python to safely merge JSON rather than clobbering the file
"$NODE_BIN" - <<'JS'
const fs   = require("fs");
const path = require("path");
const file = path.join(process.env.HOME, ".claude", "settings.json");

let existing = {};
try { existing = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}

const proxy_env = {
  ANTHROPIC_BASE_URL: "http://localhost:4141",
  ANTHROPIC_AUTH_TOKEN: "dummy"
};

existing.env = Object.assign({}, existing.env || {}, proxy_env);
fs.writeFileSync(file, JSON.stringify(existing, null, 2) + "\n");
console.log("settings.json updated.");
JS

success "Claude Code settings updated:"
echo   "      ANTHROPIC_BASE_URL  → http://localhost:${PROXY_PORT}"
echo   "      ANTHROPIC_AUTH_TOKEN → dummy"

# ─── 9. Done ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}  ✓ Setup complete!${NC}"
echo ""
echo "  Proxy logs : /tmp/copilot-api.log"
echo "  Error logs : /tmp/copilot-api.error.log"
echo "  Token file : ${TOKEN_FILE}"
echo ""
echo "  To check proxy status:"
echo "    curl http://localhost:${PROXY_PORT}/v1/models"
echo ""
echo "  To restart the proxy:"
echo "    launchctl kickstart -k \"gui/\$(id -u)/${LAUNCH_AGENT_LABEL}\""
echo ""
echo "  To stop the proxy:"
echo "    launchctl unload ${LAUNCH_AGENT_PLIST}"
echo ""
echo "  Open a new terminal, run 'claude', and you're good to go!"
echo ""
