#!/usr/bin/env bash
# Install the complete private DevSpace path as a per-user LaunchAgent.
#
# tunnel-client is the supervised process. It spawns the adapter over stdio, so
# the adapter has no TCP/Unix listener of its own.
#
#   ./install-launchd.sh              configure, install, start, verify
#   ./install-launchd.sh --status     verify launchd and the dynamic readyz URL
#   ./install-launchd.sh --uninstall  disable the local service (remote tunnel stays)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
ENTRY="$REPO/adapter/bin/start.js"
LAUNCHER_DIR="${TUNNEL_LAUNCHER_DIR:-$HOME/.local/bin}"
LAUNCHER="$LAUNCHER_DIR/webmcp-devspace-adapter"
ALIAS="${TUNNEL_ALIAS:-devspace}"
PROFILE="${TUNNEL_PROFILE:-devspace}"
PROFILE_DIR="${TUNNEL_PROFILE_DIR:-$HOME/.config/tunnel-client}"
LIVE_PROFILE="$PROFILE_DIR/$PROFILE.yaml"
RUNTIME_DIR="${TUNNEL_RUNTIME_DIR:-$HOME/Library/Application Support/tunnel-client}"
KEY_DIR="${TUNNEL_SECRET_DIR:-$RUNTIME_DIR/secrets}"
KEY_FILE="${TUNNEL_RUNTIME_KEY_FILE:-$KEY_DIR/devspace-runtime-api-key}"
HEALTH_URL_FILE="${TUNNEL_HEALTH_URL_FILE:-$RUNTIME_DIR/health/$ALIAS.url}"
LABEL="com.webmcp.devspace-tunnel"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"
STDOUT_LOG="$LOG_DIR/webmcp-devspace-tunnel.log"
STDERR_LOG="$LOG_DIR/webmcp-devspace-tunnel.err"
LEGACY_LABEL="com.webmcp.devspace-adapter"
LEGACY_PLIST="$PLIST_DIR/$LEGACY_LABEL.plist"
DOMAIN="gui/$(id -u)"

TUNNEL_CLIENT_BIN="${TUNNEL_CLIENT_BIN:-$HOME/Doc/devspace-container/bin/tunnel-client}"
if [ ! -x "$TUNNEL_CLIENT_BIN" ]; then
  TUNNEL_CLIENT_BIN="$(command -v tunnel-client || true)"
fi
if [ -z "$TUNNEL_CLIENT_BIN" ] || [ ! -x "$TUNNEL_CLIENT_BIN" ]; then
  echo "找不到 tunnel-client；可用 TUNNEL_CLIENT_BIN=/absolute/path 指定。" >&2
  exit 1
fi

status() {
  if ! launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    echo "未加载 LaunchAgent：$LABEL" >&2
    return 1
  fi
  if [ ! -s "$HEALTH_URL_FILE" ]; then
    echo "健康地址文件不存在或为空：$HEALTH_URL_FILE" >&2
    return 1
  fi

  health_base="$(head -1 "$HEALTH_URL_FILE")"
  if ! printf '%s' "$health_base" | grep -Eq '^http://127\.0\.0\.1:[0-9]+$'; then
    echo "拒绝使用非 loopback 或格式异常的健康地址：$health_base" >&2
    return 1
  fi

  ready="$(curl --silent --show-error --fail --max-time 2 "$health_base/readyz" 2>/dev/null || true)"
  if [ "$ready" != "ready" ]; then
    echo "LaunchAgent 已加载，但 tunnel runtime 尚未 ready：$health_base/readyz" >&2
    return 1
  fi

  pid="$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null | sed -nE 's/^[[:space:]]*pid = ([0-9]+)$/\1/p' | head -1)"
  echo "ready=true label=$LABEL pid=${pid:-unknown} health=$health_base/readyz"
}

disable_plist() {
  source_plist="$1"
  if [ ! -f "$source_plist" ]; then
    return
  fi
  disabled_plist="$source_plist.disabled"
  if [ -e "$disabled_plist" ]; then
    disabled_plist="$disabled_plist.$(date +%Y%m%d%H%M%S)"
  fi
  mv "$source_plist" "$disabled_plist"
}

restore_existing_launch_agent() {
  if [ "${had_service:-0}" -ne 1 ] || [ ! -f "$PLIST" ]; then
    return
  fi
  launchctl enable "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
}

case "${1:-}" in
  --status)
    status
    exit $?
    ;;
  --uninstall)
    launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    "$TUNNEL_CLIENT_BIN" runtimes stop "$ALIAS" >/dev/null 2>&1 || true
    "$TUNNEL_CLIENT_BIN" runtimes rm "$ALIAS" >/dev/null 2>&1 || true
    disable_plist "$PLIST"
    launchctl bootout "$DOMAIN/$LEGACY_LABEL" >/dev/null 2>&1 || true
    disable_plist "$LEGACY_PLIST"
    echo "已停用本机 LaunchAgent 并移除 runtime 元数据：$ALIAS（远端 tunnel 和本机 key 保留）"
    exit 0
    ;;
  "") ;;
  *)
    echo "用法：$0 [--status|--uninstall]" >&2
    exit 2
    ;;
esac

if [ ! -x "$ENTRY" ]; then
  echo "适配器入口不存在或不可执行：$ENTRY" >&2
  exit 1
fi

TUNNEL_ID="${TUNNEL_ID:-}"
if [ -z "$TUNNEL_ID" ] && [ -f "$LIVE_PROFILE" ]; then
  TUNNEL_ID="$(sed -nE \
    -e 's/^[[:space:]]*tunnel_id:[[:space:]]*"?([^"[:space:]]+)"?.*/\1/p' \
    -e 's/^[[:space:]]*"tunnel_id"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' \
    "$LIVE_PROFILE" | head -1)"
fi
if ! printf '%s' "$TUNNEL_ID" | grep -Eq '^tunnel_[0-9a-f]{32}$'; then
  echo "缺少有效 tunnel ID。请设置 TUNNEL_ID=tunnel_<32位小写十六进制> 后重跑。" >&2
  exit 1
fi

mkdir -p "$PROFILE_DIR" "$KEY_DIR" "$(dirname "$HEALTH_URL_FILE")" "$LAUNCHER_DIR" "$PLIST_DIR" "$LOG_DIR"
chmod 700 "$PROFILE_DIR" "$KEY_DIR"

if [ -e "$LAUNCHER" ] && [ ! -L "$LAUNCHER" ]; then
  echo "拒绝覆盖已有文件：$LAUNCHER" >&2
  exit 1
fi
ln -sfn "$ENTRY" "$LAUNCHER"

if [ ! -s "$KEY_FILE" ]; then
  runtime_key="${CONTROL_PLANE_API_KEY:-}"
  if [ -z "$runtime_key" ]; then
    printf '粘贴 OpenAI Tunnel Runtime API key（输入不会显示）：' >&2
    IFS= read -r -s runtime_key
    echo >&2
  fi
  if [ -z "$runtime_key" ]; then
    echo "Runtime API key 为空；拒绝创建不可用的常驻服务。" >&2
    exit 1
  fi
  umask 077
  printf '%s' "$runtime_key" > "$KEY_FILE"
  unset runtime_key
fi
chmod 600 "$KEY_FILE"

# Let tunnel-client generate a profile that matches its installed version, and
# prove the tunnel/key/stdio target before replacing any working service.
had_service=0
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  had_service=1
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
fi
"$TUNNEL_CLIENT_BIN" runtimes stop "$ALIAS" >/dev/null 2>&1 || true
if ! "$TUNNEL_CLIENT_BIN" runtimes connect \
    --alias "$ALIAS" \
    --profile "$PROFILE" \
    --profile-dir "$PROFILE_DIR" \
    --tunnel-id "$TUNNEL_ID" \
    --runtime-api-key "file:$KEY_FILE" \
    --mcp-command "$LAUNCHER"; then
  "$TUNNEL_CLIENT_BIN" runtimes status "$ALIAS" --json >&2 || true
  "$TUNNEL_CLIENT_BIN" runtimes stop "$ALIAS" >/dev/null 2>&1 || true
  restore_existing_launch_agent
  exit 1
fi

status_json="$("$TUNNEL_CLIENT_BIN" runtimes status "$ALIAS" --json)"
if ! printf '%s' "$status_json" | grep -Eq '"process_running"[[:space:]]*:[[:space:]]*true'; then
  echo "$status_json" >&2
  echo "临时 runtime 没有运行；拒绝安装 LaunchAgent。" >&2
  "$TUNNEL_CLIENT_BIN" runtimes stop "$ALIAS" >/dev/null 2>&1 || true
  restore_existing_launch_agent
  exit 1
fi
if ! printf '%s' "$status_json" | grep -Eq '"ready"[[:space:]]*:[[:space:]]*true'; then
  echo "$status_json" >&2
  echo "临时 runtime 尚未 ready；拒绝安装 LaunchAgent。" >&2
  "$TUNNEL_CLIENT_BIN" runtimes stop "$ALIAS" >/dev/null 2>&1 || true
  restore_existing_launch_agent
  exit 1
fi

# Generate the plist without interpolating values into XML markup.
PLIST_LABEL="$LABEL" \
PLIST_TUNNEL_CLIENT="$TUNNEL_CLIENT_BIN" \
PLIST_PROFILE_DIR="$PROFILE_DIR" \
PLIST_PROFILE="$PROFILE" \
PLIST_STDOUT="$STDOUT_LOG" \
PLIST_STDERR="$STDERR_LOG" \
/usr/bin/python3 - "$PLIST" <<'PY'
import os
import plistlib
import sys

payload = {
    "Label": os.environ["PLIST_LABEL"],
    "ProgramArguments": [
        os.environ["PLIST_TUNNEL_CLIENT"],
        "run",
        "--profile-dir",
        os.environ["PLIST_PROFILE_DIR"],
        "--profile",
        os.environ["PLIST_PROFILE"],
    ],
    "EnvironmentVariables": {
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    },
    "RunAtLoad": True,
    "KeepAlive": True,
    "ThrottleInterval": 30,
    "StandardOutPath": os.environ["PLIST_STDOUT"],
    "StandardErrorPath": os.environ["PLIST_STDERR"],
}
with open(sys.argv[1], "wb") as destination:
    plistlib.dump(payload, destination)
PY
chmod 600 "$PLIST"
plutil -lint "$PLIST" >/dev/null

# Replace the temporary detached process with the real login service. The key
# remains a file reference in the generated profile and never enters the plist.
launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
"$TUNNEL_CLIENT_BIN" runtimes stop "$ALIAS" >/dev/null 2>&1 || true
: > "$HEALTH_URL_FILE"
launchctl enable "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
if ! launchctl bootstrap "$DOMAIN" "$PLIST"; then
  echo "LaunchAgent 加载失败；尝试恢复 tunnel-client 的临时托管进程。" >&2
  "$TUNNEL_CLIENT_BIN" runtimes connect \
    --alias "$ALIAS" \
    --profile "$PROFILE" \
    --profile-dir "$PROFILE_DIR" \
    --tunnel-id "$TUNNEL_ID" \
    --runtime-api-key "file:$KEY_FILE" \
    --mcp-command "$LAUNCHER" >/dev/null 2>&1 || true
  exit 1
fi

ready_now=0
for _ in $(seq 1 30); do
  if status >/dev/null 2>&1; then
    ready_now=1
    break
  fi
  sleep 1
done
if [ "$ready_now" -ne 1 ]; then
  launchctl print "$DOMAIN/$LABEL" >&2 || true
  tail -30 "$STDERR_LOG" >&2 2>/dev/null || true
  echo "LaunchAgent 未在 30 秒内 ready；旧 HTTP 适配器仍保持禁用。" >&2
  exit 1
fi

# Retire the obsolete standalone HTTP adapter only after the stdio tunnel is
# proven ready. Keep its plist as a recoverable disabled artifact.
launchctl bootout "$DOMAIN/$LEGACY_LABEL" >/dev/null 2>&1 || true
disable_plist "$LEGACY_PLIST"

status
echo "✔ Secure MCP Tunnel 已由 launchd 常驻：$LABEL"
echo "  适配器由 tunnel-client 通过 stdio 启动（无 8787 监听端口）"
echo "  查看状态：$HERE/install-launchd.sh --status"
