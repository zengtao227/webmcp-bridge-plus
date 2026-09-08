#!/usr/bin/env bash
# 把私有 MCP 适配器装成 launchd LaunchAgent：登录即起、崩了自动拉起、
# 网络/容器恢复后自动重连。这样"开隧道"就不再是一个需要记得做的动作。
#
#   ./install-launchd.sh              安装并启动
#   ./install-launchd.sh --uninstall  卸载
#
# 可覆盖的环境变量：
#   ADAPTER_PORT=8787
#   DEVSPACE_UPSTREAM_URL=http://127.0.0.1:7676
#   DEVSPACE_OWNER_TOKEN_REF=keychain:devspace-owner-token
#   NODE_BIN=/path/to/node    （建议固定，避免指向 WorkBuddy 临时 Node）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
ENTRY="$REPO/adapter/bin/start.js"

LABEL="com.webmcp.devspace-adapter"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"
DOMAIN="gui/$(id -u)"

ADAPTER_PORT="${ADAPTER_PORT:-8787}"
ADAPTER_LISTEN_HOST="${ADAPTER_LISTEN_HOST:-127.0.0.1}"
DEVSPACE_UPSTREAM_URL="${DEVSPACE_UPSTREAM_URL:-http://127.0.0.1:7676}"
DEVSPACE_OWNER_TOKEN_REF="${DEVSPACE_OWNER_TOKEN_REF:-keychain:devspace-owner-token}"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "已卸载 $LABEL"
  exit 0
fi

if [ ! -f "$ENTRY" ]; then
  echo "找不到入口文件：$ENTRY" >&2
  exit 1
fi

NODE_BIN="${NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
  # Prefer stable system paths so the plist does not break when WorkBuddy
  # switches its private Node.
  for candidate in /usr/local/bin/node /opt/homebrew/bin/node; do
    if [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ]; then
  echo "找不到 node，可用 NODE_BIN=/path/to/node 指定。" >&2
  exit 1
fi
if echo "$NODE_BIN" | grep -qi workbuddy; then
  echo "⚠ 找到的 node 路径看起来是 WorkBuddy 内部路径：$NODE_BIN" >&2
  echo "  建议设置 NODE_BIN 指向一个稳定的系统 Node（例如 /opt/homebrew/bin/node）。" >&2
fi

mkdir -p "$PLIST_DIR" "$LOG_DIR"

# Safe temp file; mktemp prevents symlink attacks.
ERR_TMP=$(mktemp /tmp/webmcp-launchd.XXXXXX)
trap 'rm -f "$ERR_TMP"' EXIT

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ENTRY</string>
  </array>

  <!-- 只有引用，没有明文。真正的密码在 Keychain / 文件里。 -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>ADAPTER_TRANSPORT</key>
    <string>stdio</string>
    <key>ADAPTER_LISTEN_HOST</key>
    <string>$ADAPTER_LISTEN_HOST</string>
    <key>ADAPTER_PORT</key>
    <string>$ADAPTER_PORT</string>
    <key>DEVSPACE_UPSTREAM_URL</key>
    <string>$DEVSPACE_UPSTREAM_URL</string>
    <key>DEVSPACE_OWNER_TOKEN_REF</key>
    <string>$DEVSPACE_OWNER_TOKEN_REF</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>60</integer>

  <key>StandardOutPath</key>
  <string>$LOG_DIR/webmcp-devspace-adapter.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/webmcp-devspace-adapter.err</string>
</dict>
</plist>
PLIST

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if ! launchctl bootstrap "$DOMAIN" "$PLIST" 2>"$ERR_TMP"; then
  echo
  echo "⚠ launchctl bootstrap 失败：$(tr -d '\n' < "$ERR_TMP")"
  echo
  echo "  plist 已经写好（内容是对的，$PLIST）。"
  echo "  launchd 只能从真正的 GUI 会话里装载，所以请在 Terminal.app 里重跑一次："
  echo
  echo "      \"$HERE/install-launchd.sh\""
  echo
  echo "  或者手动："
  echo "      launchctl bootstrap $DOMAIN \"$PLIST\""
  echo "      launchctl kickstart -k $DOMAIN/$LABEL"
  echo
  echo "  没装载之前适配器不会运行 —— 这不会造成公网暴露，只是 ChatGPT 连不上。"
  exit 1
fi
launchctl enable "$DOMAIN/$LABEL" || true
launchctl kickstart -k "$DOMAIN/$LABEL" || true

printf '已安装 %s\n' "$LABEL"
