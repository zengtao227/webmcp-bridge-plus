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

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ]; then
  echo "找不到 node，可用 NODE_BIN=/path/to/node 指定。" >&2
  exit 1
fi

mkdir -p "$PLIST_DIR" "$LOG_DIR"

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
  <true/>

  <key>StandardOutPath</key>
  <string>$LOG_DIR/webmcp-devspace-adapter.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/webmcp-devspace-adapter.err</string>
</dict>
</plist>
PLIST

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if ! launchctl bootstrap "$DOMAIN" "$PLIST" 2>/tmp/webmcp-launchd.err; then
  echo
  echo "⚠ launchctl bootstrap 失败：$(tr -d '\n' < /tmp/webmcp-launchd.err)"
  rm -f /tmp/webmcp-launchd.err
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
rm -f /tmp/webmcp-launchd.err
launchctl enable "$DOMAIN/$LABEL" || true
launchctl kickstart -k "$DOMAIN/$LABEL" || true

printf '已安装 %s\n' "$LABEL"

for _ in $(seq 1 20); do
  if curl -sf --noproxy '*' "http://$ADAPTER_LISTEN_HOST:$ADAPTER_PORT/healthz" >/dev/null 2>&1; then
    echo
    echo "✔ 适配器在线：http://$ADAPTER_LISTEN_HOST:$ADAPTER_PORT/healthz"
    echo "  日志：$LOG_DIR/webmcp-devspace-adapter.log"
    echo
    echo "tunnel-client 的 mcp.server_urls 应指向："
    echo "  http://$ADAPTER_LISTEN_HOST:$ADAPTER_PORT/mcp"
    exit 0
  fi
  sleep 1
done

echo
echo "⚠ 起是起来了，但 /healthz 还没响应。常见原因："
echo "   1. Keychain 还没解锁（登录前拉起时）：等几秒会自动重试，或手动 kickstart"
echo "      launchctl kickstart -k $DOMAIN/$LABEL"
echo "   2. owner token 引用不对："
echo "      security find-generic-password -w -s ${DEVSPACE_OWNER_TOKEN_REF#keychain:}"
echo "   3. 看错误日志："
echo "      tail -20 $LOG_DIR/webmcp-devspace-adapter.err"
exit 1
