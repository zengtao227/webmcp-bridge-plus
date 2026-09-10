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
DEPLOYER="$REPO/adapter/deploy/deploy-host-runtime.js"
HOST_RUNTIME_ROOT="${WEBMCP_HOST_RUNTIME_ROOT:-$HOME/Doc/devspace-container/runtime/webmcp-adapter}"
DEFAULT_WRITABLE_ROOT="$HOME/Doc/My code"
EXTRA_WRITABLE_ROOT="${DEVSPACE_PROJECT_ROOT:-}"
RUNTIME_ENTRY="$HOST_RUNTIME_ROOT/current/adapter/bin/start.js"
LEGACY_LAUNCHER="$HOME/.local/bin/webmcp-devspace-adapter"
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

query_launch_agent_state() {
  local target_label query_status
  target_label="${1:-$LABEL}"
  if launchctl print "$DOMAIN/$target_label" >/dev/null 2>&1; then
    printf 'loaded\n'
    return 0
  else
    query_status=$?
  fi

  if [ "$query_status" -eq 113 ]; then
    printf 'absent\n'
    return 0
  fi

  echo "无法确认 LaunchAgent 状态：$target_label (launchctl exit=$query_status)" >&2
  return 1
}

wait_for_launch_agent_absent() {
  local target_label attempts delay_seconds attempt launch_state
  target_label="${1:-$LABEL}"
  attempts="${WEBMCP_STOP_ATTEMPTS:-20}"
  delay_seconds="${WEBMCP_STOP_DELAY_SECONDS:-0.25}"

  if ! printf '%s' "$attempts" | grep -Eq '^[1-9][0-9]*$'; then
    echo "WEBMCP_STOP_ATTEMPTS 必须是正整数。" >&2
    return 1
  fi
  if ! printf '%s' "$delay_seconds" | grep -Eq '^[0-9]+([.][0-9]+)?$'; then
    echo "WEBMCP_STOP_DELAY_SECONDS 必须是非负数字。" >&2
    return 1
  fi

  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if ! launch_state="$(query_launch_agent_state "$target_label")"; then
      return 1
    fi
    if [ "$launch_state" = "absent" ]; then
      return 0
    fi
    if [ "$attempt" -lt "$attempts" ]; then
      sleep "$delay_seconds"
    fi
  done
  return 1
}

status() {
  if ! launch_state="$(query_launch_agent_state)"; then
    return 1
  fi
  if [ "$launch_state" = "absent" ]; then
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

  if launch_info="$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null)"; then
    :
  else
    launch_info_status=$?
    if [ "$launch_info_status" -eq 113 ]; then
      echo "LaunchAgent 在状态检查期间变为未加载：$LABEL" >&2
    else
      echo "无法读取 LaunchAgent 详情：$LABEL (launchctl exit=$launch_info_status)" >&2
    fi
    return 1
  fi
  pid="$(printf '%s\n' "$launch_info" | sed -nE 's/^[[:space:]]*pid = ([0-9]+)$/\1/p' | head -1)"
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

ROLLBACK_DIR=""
PLIST_CANDIDATE=""
rollback_required=0
had_current=0
previous_current_target=""
had_live_profile=0
had_plist=0
had_service=0

capture_recoverable_state() {
  if ! ROLLBACK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/webmcp-launchd-rollback.XXXXXX")"; then
    echo "无法创建 activation rollback state directory。" >&2
    return 1
  fi

  if [ -L "$HOST_RUNTIME_ROOT/current" ]; then
    had_current=1
    if ! previous_current_target="$(readlink "$HOST_RUNTIME_ROOT/current")"; then
      echo "无法读取 existing current target；拒绝进入激活流程。" >&2
      return 1
    fi
  elif [ -e "$HOST_RUNTIME_ROOT/current" ]; then
    echo "现有 host runtime current 不是符号链接；拒绝进入激活流程。" >&2
    return 1
  fi

  if [ -e "$LIVE_PROFILE" ]; then
    if [ ! -f "$LIVE_PROFILE" ] || [ -L "$LIVE_PROFILE" ]; then
      echo "现有 LIVE_PROFILE 不是普通文件；拒绝进入激活流程：$LIVE_PROFILE" >&2
      return 1
    fi
    had_live_profile=1
    if ! cp -p "$LIVE_PROFILE" "$ROLLBACK_DIR/live-profile"; then
      echo "无法备份 existing LIVE_PROFILE；拒绝进入激活流程。" >&2
      return 1
    fi
  fi

  if [ -e "$PLIST" ]; then
    if [ ! -f "$PLIST" ] || [ -L "$PLIST" ]; then
      echo "现有 plist 不是普通文件；拒绝进入激活流程：$PLIST" >&2
      return 1
    fi
    had_plist=1
    if ! cp -p "$PLIST" "$ROLLBACK_DIR/launch-agent.plist"; then
      echo "无法备份 existing plist；拒绝进入激活流程。" >&2
      return 1
    fi
  fi

  if ! launch_state="$(query_launch_agent_state)"; then
    echo "无法保存原 LaunchAgent 状态；拒绝进入激活流程。" >&2
    return 1
  fi
  if [ "$launch_state" = "loaded" ]; then
    had_service=1
    if [ "$had_plist" -ne 1 ]; then
      echo "原 LaunchAgent 正在运行但没有可恢复 plist；拒绝进入激活流程。" >&2
      return 1
    fi
  fi
}

restore_file_atomically() {
  backup="$1"
  destination="$2"
  existed="$3"
  temporary="$destination.rollback.$$"

  if [ "$existed" -eq 1 ]; then
    if [ ! -f "$backup" ]; then
      echo "Rollback backup 缺失：$backup" >&2
      return 1
    fi
    if ! cp -p "$backup" "$temporary" || ! mv -f "$temporary" "$destination"; then
      rm -f "$temporary" >/dev/null 2>&1 || true
      return 1
    fi
    return 0
  fi

  rm -f "$destination"
}

restore_previous_current() {
  current_path="$HOST_RUNTIME_ROOT/current"
  temporary_current="$HOST_RUNTIME_ROOT/.current-rollback.$$"

  if [ "$had_current" -eq 1 ]; then
    rm -f "$temporary_current" >/dev/null 2>&1 || true
    if ! ln -s "$previous_current_target" "$temporary_current"; then
      return 1
    fi
    if ! "$PYTHON3_BIN" - "$temporary_current" "$current_path" <<'PY'
import os
import sys

os.replace(sys.argv[1], sys.argv[2])
PY
    then
      rm -f "$temporary_current" >/dev/null 2>&1 || true
      return 1
    fi
    return 0
  fi

  if [ -e "$current_path" ] && [ ! -L "$current_path" ]; then
    echo "Rollback 拒绝删除非符号链接 current：$current_path" >&2
    return 1
  fi
  rm -f "$current_path"
}

rollback_activation() {
  rollback_failed=0
  rollback_required=0
  can_restore_service=0

  if launch_state="$(query_launch_agent_state)"; then
    if [ "$launch_state" = "loaded" ]; then
      if ! launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1; then
        echo "ROLLBACK ERROR: 无法停止失败的新 LaunchAgent。" >&2
        rollback_failed=1
      fi
      if wait_for_launch_agent_absent "$LABEL"; then
        can_restore_service=1
      else
        echo "ROLLBACK ERROR: bootout 后未能在限定时间内确认 LaunchAgent absent。" >&2
        rollback_failed=1
      fi
    else
      can_restore_service=1
    fi
  else
    echo "ROLLBACK ERROR: 无法确认失败的新 LaunchAgent 状态。" >&2
    rollback_failed=1
  fi
  if ! "$TUNNEL_CLIENT_BIN" runtimes stop "$ALIAS" >/dev/null 2>&1; then
    echo "ROLLBACK ERROR: 无法停止失败的新 tunnel runtime。" >&2
    rollback_failed=1
  fi
  if ! restore_previous_current; then
    echo "ROLLBACK ERROR: 无法原子恢复 previous current。" >&2
    rollback_failed=1
  fi
  if ! restore_file_atomically "$ROLLBACK_DIR/live-profile" "$LIVE_PROFILE" "$had_live_profile"; then
    echo "ROLLBACK ERROR: 无法恢复旧 LIVE_PROFILE。" >&2
    rollback_failed=1
  fi
  if ! restore_file_atomically "$ROLLBACK_DIR/launch-agent.plist" "$PLIST" "$had_plist"; then
    echo "ROLLBACK ERROR: 无法恢复旧 plist。" >&2
    rollback_failed=1
  fi

  if [ "$had_service" -eq 1 ]; then
    if [ "$can_restore_service" -ne 1 ]; then
      echo "ROLLBACK ERROR: 当前 LaunchAgent 状态未知，不能安全恢复原 LaunchAgent。" >&2
      rollback_failed=1
    elif [ ! -f "$PLIST" ]; then
      echo "ROLLBACK ERROR: 原 LaunchAgent 曾运行，但恢复后的 plist 不存在。" >&2
      rollback_failed=1
    else
      if ! launchctl enable "$DOMAIN/$LABEL" >/dev/null 2>&1; then
        echo "ROLLBACK ERROR: 无法重新 enable 原 LaunchAgent。" >&2
        rollback_failed=1
      fi
      if ! launchctl bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1; then
        echo "ROLLBACK ERROR: 无法重新 bootstrap 原 LaunchAgent。" >&2
        rollback_failed=1
      elif launch_state="$(query_launch_agent_state)"; then
        if [ "$launch_state" != "loaded" ]; then
          echo "ROLLBACK ERROR: 原 LaunchAgent bootstrap 后确认 absent。" >&2
          rollback_failed=1
        fi
      else
        echo "ROLLBACK ERROR: 无法确认原 LaunchAgent 已恢复 loaded 状态。" >&2
        rollback_failed=1
      fi
    fi
  fi

  [ "$rollback_failed" -eq 0 ]
}

cleanup_activation_state() {
  if [ -n "$PLIST_CANDIDATE" ]; then
    rm -f "$PLIST_CANDIDATE" >/dev/null 2>&1 || true
  fi
  if [ -n "$ROLLBACK_DIR" ]; then
    rm -rf "$ROLLBACK_DIR" >/dev/null 2>&1 || true
  fi
}

on_exit() {
  exit_code=$?
  trap - EXIT
  if [ "$exit_code" -ne 0 ] && [ "$rollback_required" -eq 1 ]; then
    if rollback_activation; then
      echo "激活失败；bounded rollback 已恢复 previous current/profile/plist，并按原状态恢复 LaunchAgent。" >&2
    else
      echo "ROLLBACK FAILED: 激活失败且旧服务状态未能完整恢复；请人工检查 current/profile/plist/LaunchAgent。" >&2
      exit_code=70
    fi
  fi
  cleanup_activation_state
  exit "$exit_code"
}

trap on_exit EXIT

case "${1:-}" in
  --status)
    status
    exit $?
    ;;
  --uninstall)
    if ! launch_state="$(query_launch_agent_state "$LABEL")"; then
      echo "无法确认当前 LaunchAgent 状态；拒绝卸载。" >&2
      exit 1
    fi
    if [ "$launch_state" = "loaded" ]; then
      if ! launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1; then
        echo "无法停止当前 LaunchAgent；拒绝卸载。" >&2
        exit 1
      fi
      if ! wait_for_launch_agent_absent "$LABEL"; then
        echo "bootout 后无法确认当前 LaunchAgent 已停止；拒绝修改 plist。" >&2
        exit 1
      fi
    fi

    if ! legacy_state="$(query_launch_agent_state "$LEGACY_LABEL")"; then
      echo "无法确认 legacy LaunchAgent 状态；拒绝修改 legacy plist。" >&2
      exit 1
    fi
    if [ "$legacy_state" = "loaded" ]; then
      if ! launchctl bootout "$DOMAIN/$LEGACY_LABEL" >/dev/null 2>&1; then
        echo "无法停止 legacy LaunchAgent；拒绝修改 legacy plist。" >&2
        exit 1
      fi
      if ! wait_for_launch_agent_absent "$LEGACY_LABEL"; then
        echo "bootout 后无法确认 legacy LaunchAgent 已停止；拒绝修改 legacy plist。" >&2
        exit 1
      fi
    fi

    "$TUNNEL_CLIENT_BIN" runtimes stop "$ALIAS" >/dev/null 2>&1 || true
    "$TUNNEL_CLIENT_BIN" runtimes rm "$ALIAS" >/dev/null 2>&1 || true
    disable_plist "$PLIST"
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

NODE_BIN="${WEBMCP_RUNTIME_NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "找不到 node；可用 WEBMCP_RUNTIME_NODE_BIN=/absolute/path 指定。" >&2
  exit 1
fi
PYTHON3_BIN="${PYTHON3_BIN:-/usr/bin/python3}"
if [ ! -x "$PYTHON3_BIN" ]; then
  echo "找不到可执行 python3：$PYTHON3_BIN" >&2
  exit 1
fi
PLUTIL_BIN="${PLUTIL_BIN:-$(command -v plutil || true)}"
if [ -z "$PLUTIL_BIN" ] || [ ! -x "$PLUTIL_BIN" ]; then
  echo "找不到 plutil；可用 PLUTIL_BIN=/absolute/path 指定。" >&2
  exit 1
fi
if [ ! -f "$DEPLOYER" ]; then
  echo "Host runtime deployer 不存在：$DEPLOYER" >&2
  exit 1
fi
if [ ! -d "$DEFAULT_WRITABLE_ROOT" ]; then
  echo "默认 DevSpace writable root 不存在：$DEFAULT_WRITABLE_ROOT" >&2
  exit 1
fi
if [ -n "$EXTRA_WRITABLE_ROOT" ] && [ ! -d "$EXTRA_WRITABLE_ROOT" ]; then
  echo "附加 DevSpace writable root 不存在：$EXTRA_WRITABLE_ROOT" >&2
  exit 1
fi
READY_ATTEMPTS="${WEBMCP_READY_ATTEMPTS:-30}"
READY_DELAY_SECONDS="${WEBMCP_READY_DELAY_SECONDS:-1}"
if ! printf '%s' "$READY_ATTEMPTS" | grep -Eq '^[1-9][0-9]*$'; then
  echo "WEBMCP_READY_ATTEMPTS 必须是正整数。" >&2
  exit 1
fi
if ! printf '%s' "$READY_DELAY_SECONDS" | grep -Eq '^[0-9]+([.][0-9]+)?$'; then
  echo "WEBMCP_READY_DELAY_SECONDS 必须是非负数字。" >&2
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

mkdir -p "$PROFILE_DIR" "$KEY_DIR" "$(dirname "$HEALTH_URL_FILE")" "$PLIST_DIR" "$LOG_DIR"
chmod 700 "$PROFILE_DIR" "$KEY_DIR"

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

# Save every state element needed for a bounded activation rollback before the
# deployer changes `current` and before the first running Tunnel is interrupted.
if ! capture_recoverable_state; then
  echo "无法保存激活前状态；拒绝继续。" >&2
  exit 1
fi

# Generate the candidate plist into the LaunchAgents directory so its eventual
# rename is atomic. Validate it before deploying or interrupting any service.
PLIST_CANDIDATE="$(mktemp "$PLIST_DIR/.${LABEL}.candidate.XXXXXX")"
if ! PLIST_LABEL="$LABEL" \
PLIST_TUNNEL_CLIENT="$TUNNEL_CLIENT_BIN" \
PLIST_PROFILE_DIR="$PROFILE_DIR" \
PLIST_PROFILE="$PROFILE" \
PLIST_STDOUT="$STDOUT_LOG" \
PLIST_STDERR="$STDERR_LOG" \
"$PYTHON3_BIN" - "$PLIST_CANDIDATE" <<'PY'
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
then
  echo "plist candidate 生成失败；现有 current/profile/plist/LaunchAgent 未切换。" >&2
  exit 1
fi
chmod 600 "$PLIST_CANDIDATE"
if ! "$PLUTIL_BIN" -lint "$PLIST_CANDIDATE" >/dev/null; then
  echo "plist candidate 校验失败；现有 current/profile/plist/LaunchAgent 未切换。" >&2
  exit 1
fi

# Build and verify the host-only adapter snapshot before interrupting the current
# Tunnel. The default $HOME/Doc/My code boundary is enforced by the deployer;
# DEVSPACE_PROJECT_ROOT, when present, is only an additional writable boundary.
deploy_args=(
  --source-root "$REPO"
  --runtime-root "$HOST_RUNTIME_ROOT"
)
if [ -n "$EXTRA_WRITABLE_ROOT" ]; then
  deploy_args+=(--project-root "$EXTRA_WRITABLE_ROOT")
fi
if ! "$NODE_BIN" "$DEPLOYER" "${deploy_args[@]}"; then
  echo "Host-only adapter runtime 部署失败；保留现有 Tunnel 不变。" >&2
  exit 1
fi
rollback_required=1
if [ ! -x "$RUNTIME_ENTRY" ]; then
  echo "已部署 runtime entrypoint 不可执行：$RUNTIME_ENTRY" >&2
  exit 1
fi

# From this point onward, every failing exit goes through the same bounded
# rollback in the EXIT trap.
if [ "$had_service" -eq 1 ]; then
  if ! launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    echo "无法停止原 LaunchAgent；触发 bounded rollback。" >&2
    exit 1
  fi
  if ! wait_for_launch_agent_absent "$LABEL"; then
    echo "停止原 LaunchAgent 后未能在限定时间内确认 absent；触发 bounded rollback。" >&2
    exit 1
  fi
fi
"$TUNNEL_CLIENT_BIN" runtimes stop "$ALIAS" >/dev/null 2>&1 || true
if ! "$TUNNEL_CLIENT_BIN" runtimes connect \
    --alias "$ALIAS" \
    --profile "$PROFILE" \
    --profile-dir "$PROFILE_DIR" \
    --tunnel-id "$TUNNEL_ID" \
    --runtime-api-key "file:$KEY_FILE" \
    --mcp-command "$RUNTIME_ENTRY"; then
  "$TUNNEL_CLIENT_BIN" runtimes status "$ALIAS" --json >&2 || true
  echo "临时 runtime connect 失败；触发 bounded rollback。" >&2
  exit 1
fi

if ! status_json="$("$TUNNEL_CLIENT_BIN" runtimes status "$ALIAS" --json)"; then
  echo "无法读取临时 runtime 状态；触发 bounded rollback。" >&2
  exit 1
fi
if ! printf '%s' "$status_json" | grep -Eq '"process_running"[[:space:]]*:[[:space:]]*true'; then
  echo "$status_json" >&2
  echo "临时 runtime 没有运行；触发 bounded rollback。" >&2
  exit 1
fi
if ! printf '%s' "$status_json" | grep -Eq '"ready"[[:space:]]*:[[:space:]]*true'; then
  echo "$status_json" >&2
  echo "临时 runtime 尚未 ready；触发 bounded rollback。" >&2
  exit 1
fi

# Atomically publish only the already-validated plist, then replace the detached
# runtime with the real login service. The key remains a file reference.
if ! mv -f "$PLIST_CANDIDATE" "$PLIST"; then
  echo "无法原子发布已校验 plist；触发 bounded rollback。" >&2
  exit 1
fi
PLIST_CANDIDATE=""
if ! "$TUNNEL_CLIENT_BIN" runtimes stop "$ALIAS" >/dev/null 2>&1; then
  echo "无法停止临时 runtime；触发 bounded rollback。" >&2
  exit 1
fi
: > "$HEALTH_URL_FILE"
if ! launchctl enable "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  echo "LaunchAgent enable 失败；触发 bounded rollback。" >&2
  exit 1
fi
if ! launchctl bootstrap "$DOMAIN" "$PLIST"; then
  echo "LaunchAgent bootstrap 失败；触发 bounded rollback。" >&2
  exit 1
fi

ready_now=0
for _ in $(seq 1 "$READY_ATTEMPTS"); do
  if status >/dev/null 2>&1; then
    ready_now=1
    break
  fi
  sleep "$READY_DELAY_SECONDS"
done
if [ "$ready_now" -ne 1 ]; then
  launchctl print "$DOMAIN/$LABEL" >&2 || true
  tail -30 "$STDERR_LOG" >&2 2>/dev/null || true
  echo "LaunchAgent 未在限定 readiness 窗口内 ready；触发 bounded rollback。" >&2
  exit 1
fi

# The new host-only service is proven ready. Activation rollback is no longer
# armed; subsequent legacy cleanup remains outside the Phase A activation unit.
rollback_required=0

# Retire the obsolete standalone HTTP adapter only after the stdio tunnel is
# proven ready. Keep its plist as a recoverable disabled artifact, but never
# mutate it when launchd cannot confirm the legacy service state. A cleanup
# failure must make the installer non-zero without rolling back the already-ready
# stdio Tunnel.
legacy_cleanup_failed=0
if legacy_state="$(query_launch_agent_state "$LEGACY_LABEL")"; then
  if [ "$legacy_state" = "loaded" ]; then
    if ! launchctl bootout "$DOMAIN/$LEGACY_LABEL" >/dev/null 2>&1; then
      echo "无法停止 legacy HTTP LaunchAgent；保留 legacy plist 不变。" >&2
      legacy_cleanup_failed=1
    elif wait_for_launch_agent_absent "$LEGACY_LABEL"; then
      disable_plist "$LEGACY_PLIST"
    else
      echo "legacy HTTP LaunchAgent bootout 后未能在限定时间内确认 absent；保留 legacy plist 不变。" >&2
      legacy_cleanup_failed=1
    fi
  else
    disable_plist "$LEGACY_PLIST"
  fi
else
  echo "无法确认 legacy HTTP LaunchAgent 状态；保留 legacy plist 不变。" >&2
  legacy_cleanup_failed=1
fi

if [ "$legacy_cleanup_failed" -ne 0 ]; then
  echo "ERROR: 新 Secure MCP Tunnel 已 ready，但 legacy HTTP adapter 未能确认停用，需要人工检查；新 Tunnel 保持运行。" >&2
  exit 1
fi

# The pre-Phase-A launcher was a symlink back into the DevSpace-writable repo.
# Remove only that exact legacy symlink after the host-only runtime is proven
# ready; never delete an unrelated user file/symlink at the same location.
if [ -L "$LEGACY_LAUNCHER" ]; then
  legacy_target="$(readlink "$LEGACY_LAUNCHER" || true)"
  if [ "$legacy_target" = "$REPO/adapter/bin/start.js" ]; then
    rm "$LEGACY_LAUNCHER"
  fi
fi

status
echo "✔ Secure MCP Tunnel 已由 launchd 常驻：$LABEL"
echo "  适配器由 tunnel-client 通过 stdio 启动（无 8787 监听端口）"
echo "  查看状态：$HERE/install-launchd.sh --status"
