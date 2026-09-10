#!/usr/bin/env bash
# Install the minimal DevSpace container ensure loop as a per-user LaunchAgent.
#
# The LaunchAgent has exactly one lifecycle responsibility: periodically invoke
# the host-only control-plane entrypoint:
#
#   $HOME/Doc/devspace-container/dsup.sh --ensure
#
# Docker/container safety policy belongs to dsup.sh, not to this installer.
set -euo pipefail

LABEL="com.webmcp.devspace-recovery"
DOMAIN="gui/$(id -u)"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"
STDOUT_LOG="$LOG_DIR/webmcp-devspace-recovery.log"
STDERR_LOG="$LOG_DIR/webmcp-devspace-recovery.err"
DSUP="$HOME/Doc/devspace-container/dsup.sh"
WRITABLE_PROJECT_ROOT="$HOME/Doc/My code"
START_INTERVAL=60

LAUNCHCTL_BIN="${LAUNCHCTL_BIN:-$(command -v launchctl || true)}"
PLUTIL_BIN="${PLUTIL_BIN:-$(command -v plutil || true)}"
PYTHON3_BIN="${PYTHON3_BIN:-/usr/bin/python3}"

ROLLBACK_DIR=""
PLIST_CANDIDATE=""
rollback_required=0
had_plist=0
had_service=0

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

cleanup_state() {
  if [ -n "$PLIST_CANDIDATE" ]; then
    rm -f "$PLIST_CANDIDATE" >/dev/null 2>&1 || true
  fi
  if [ -n "$ROLLBACK_DIR" ]; then
    rm -rf "$ROLLBACK_DIR" >/dev/null 2>&1 || true
  fi
}

query_service_state() {
  local query_status
  if "$LAUNCHCTL_BIN" print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    printf 'loaded\n'
    return 0
  else
    query_status=$?
  fi

  if [ "$query_status" -eq 113 ]; then
    printf 'absent\n'
    return 0
  fi

  echo "ERROR: launchctl 无法确认 LaunchAgent 状态：$LABEL (exit=$query_status)" >&2
  return 1
}

wait_for_service_absent() {
  local attempts delay_seconds attempt service_state
  attempts="${WEBMCP_RECOVERY_STOP_ATTEMPTS:-20}"
  delay_seconds="${WEBMCP_RECOVERY_STOP_DELAY_SECONDS:-0.25}"

  if ! printf '%s' "$attempts" | grep -Eq '^[1-9][0-9]*$'; then
    echo "ERROR: WEBMCP_RECOVERY_STOP_ATTEMPTS 必须是正整数。" >&2
    return 1
  fi
  if ! printf '%s' "$delay_seconds" | grep -Eq '^[0-9]+([.][0-9]+)?$'; then
    echo "ERROR: WEBMCP_RECOVERY_STOP_DELAY_SECONDS 必须是非负数字。" >&2
    return 1
  fi

  attempt=1
  while [ "$attempt" -le "$attempts" ]; do
    if ! service_state="$(query_service_state)"; then
      return 1
    fi
    if [ "$service_state" = "absent" ]; then
      return 0
    fi
    if [ "$attempt" -lt "$attempts" ]; then
      sleep "$delay_seconds"
    fi
    attempt=$((attempt + 1))
  done
  return 1
}

assert_launchd_domain() {
  if ! "$LAUNCHCTL_BIN" print "$DOMAIN" >/dev/null 2>&1; then
    echo "ERROR: launchctl 无法读取 per-user domain：$DOMAIN" >&2
    return 1
  fi
}

restore_plist() {
  temporary="$PLIST.rollback.$$"

  if [ "$had_plist" -eq 1 ]; then
    if [ ! -f "$ROLLBACK_DIR/previous.plist" ]; then
      echo "ROLLBACK ERROR: previous plist backup 缺失。" >&2
      return 1
    fi
    if ! cp -p "$ROLLBACK_DIR/previous.plist" "$temporary"; then
      echo "ROLLBACK ERROR: 无法复制 previous plist backup。" >&2
      rm -f "$temporary" >/dev/null 2>&1 || true
      return 1
    fi
    if ! mv -f "$temporary" "$PLIST"; then
      echo "ROLLBACK ERROR: 无法原子恢复 previous plist。" >&2
      rm -f "$temporary" >/dev/null 2>&1 || true
      return 1
    fi
    return 0
  fi

  if [ -e "$PLIST" ] && { [ ! -f "$PLIST" ] || [ -L "$PLIST" ]; }; then
    echo "ROLLBACK ERROR: 拒绝删除 unexpected non-regular plist：$PLIST" >&2
    return 1
  fi
  rm -f "$PLIST"
}

rollback_install() {
  rollback_failed=0
  rollback_required=0
  can_restore_service=0

  if service_state="$(query_service_state)"; then
    if [ "$service_state" = "loaded" ]; then
      if ! "$LAUNCHCTL_BIN" bootout "$DOMAIN/$LABEL" >/dev/null 2>&1; then
        echo "ROLLBACK ERROR: 无法停止 partially activated LaunchAgent。" >&2
        rollback_failed=1
      fi
      if wait_for_service_absent; then
        can_restore_service=1
      else
        echo "ROLLBACK ERROR: bootout 后未能在限定时间内确认 LaunchAgent absent。" >&2
        rollback_failed=1
      fi
    else
      can_restore_service=1
    fi
  else
    echo "ROLLBACK ERROR: 无法确认 partially activated LaunchAgent 状态。" >&2
    rollback_failed=1
  fi

  if ! restore_plist; then
    rollback_failed=1
  fi

  if [ "$had_service" -eq 1 ]; then
    if [ "$can_restore_service" -ne 1 ]; then
      echo "ROLLBACK ERROR: 当前 LaunchAgent 状态未知，不能安全 bootstrap previous LaunchAgent。" >&2
      rollback_failed=1
    elif [ ! -f "$PLIST" ]; then
      echo "ROLLBACK ERROR: previous LaunchAgent 曾运行，但 plist 未恢复。" >&2
      rollback_failed=1
    elif ! "$LAUNCHCTL_BIN" bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1; then
      echo "ROLLBACK ERROR: 无法重新 bootstrap previous LaunchAgent。" >&2
      rollback_failed=1
    elif service_state="$(query_service_state)"; then
      if [ "$service_state" != "loaded" ]; then
        echo "ROLLBACK ERROR: previous LaunchAgent bootstrap 后确认 absent。" >&2
        rollback_failed=1
      fi
    else
      echo "ROLLBACK ERROR: 无法确认 previous LaunchAgent 已恢复 loaded 状态。" >&2
      rollback_failed=1
    fi
  fi

  [ "$rollback_failed" -eq 0 ]
}

on_exit() {
  exit_code=$?
  trap - EXIT

  if [ "$exit_code" -ne 0 ] && [ "$rollback_required" -eq 1 ]; then
    if rollback_install; then
      echo "安装失败；已恢复 previous plist/LaunchAgent 状态。" >&2
    else
      echo "ROLLBACK FAILED: 安装失败且 previous LaunchAgent 状态未能完整恢复，请人工检查。" >&2
      exit_code=70
    fi
  fi

  cleanup_state
  exit "$exit_code"
}

trap on_exit EXIT

validate_launchctl() {
  if [ -z "$LAUNCHCTL_BIN" ] || [ ! -x "$LAUNCHCTL_BIN" ]; then
    fail "找不到可执行 launchctl；可用 LAUNCHCTL_BIN=/absolute/path 指定。"
  fi
}

validate_install_tools() {
  validate_launchctl
  if [ -z "$PLUTIL_BIN" ] || [ ! -x "$PLUTIL_BIN" ]; then
    fail "找不到可执行 plutil；可用 PLUTIL_BIN=/absolute/path 指定。"
  fi
  if [ ! -x "$PYTHON3_BIN" ]; then
    fail "找不到可执行 python3：$PYTHON3_BIN"
  fi
}

validate_dsup() {
  case "$HOME" in
    /*) ;;
    *) fail "HOME 必须是绝对路径。" ;;
  esac

  if [ -L "$DSUP" ]; then
    fail "拒绝符号链接 dsup.sh：$DSUP"
  fi
  if [ ! -e "$DSUP" ]; then
    fail "host-side dsup.sh 不存在：$DSUP"
  fi
  if [ ! -f "$DSUP" ]; then
    fail "host-side dsup.sh 不是普通文件：$DSUP"
  fi
  if [ ! -x "$DSUP" ]; then
    fail "host-side dsup.sh 不可执行：$DSUP"
  fi
  if [ ! -d "$WRITABLE_PROJECT_ROOT" ]; then
    fail "writable project root 不存在：$WRITABLE_PROJECT_ROOT"
  fi

  if ! dsup_links="$($PYTHON3_BIN -c 'import os,sys; print(os.stat(sys.argv[1], follow_symlinks=False).st_nlink)' "$DSUP")"; then
    fail "无法读取 dsup.sh link count。"
  fi
  if [ "$dsup_links" != "1" ]; then
    fail "拒绝 link count 非 1 的 dsup.sh：$DSUP"
  fi

  if ! dsup_real="$($PYTHON3_BIN -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$DSUP")"; then
    fail "无法解析 dsup.sh realpath。"
  fi
  if ! project_real="$($PYTHON3_BIN -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$WRITABLE_PROJECT_ROOT")"; then
    fail "无法解析 writable project root realpath。"
  fi

  case "$dsup_real" in
    "$project_real"|"$project_real"/*)
      fail "拒绝执行 DevSpace-writable project root 内的 dsup.sh：$dsup_real"
      ;;
  esac
}

capture_previous_state() {
  if ! ROLLBACK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/webmcp-devspace-recovery-rollback.XXXXXX")"; then
    echo "ERROR: 无法创建 rollback state directory。" >&2
    return 1
  fi

  if [ -e "$PLIST" ]; then
    if [ ! -f "$PLIST" ] || [ -L "$PLIST" ]; then
      echo "ERROR: existing plist 不是普通文件：$PLIST" >&2
      return 1
    fi
    if ! "$PLUTIL_BIN" -lint "$PLIST" >/dev/null 2>&1; then
      echo "ERROR: existing plist 无法通过 plutil 校验；拒绝替换。" >&2
      return 1
    fi
    had_plist=1
    if ! cp -p "$PLIST" "$ROLLBACK_DIR/previous.plist"; then
      echo "ERROR: 无法备份 existing plist；拒绝替换。" >&2
      return 1
    fi
  fi

  if ! service_state="$(query_service_state)"; then
    echo "ERROR: 无法保存 previous LaunchAgent 状态；拒绝修改。" >&2
    return 1
  fi
  if [ "$service_state" = "loaded" ]; then
    had_service=1
    if [ "$had_plist" -ne 1 ]; then
      echo "ERROR: LaunchAgent 正在运行但没有可恢复的 plist；拒绝修改。" >&2
      return 1
    fi
  fi
}

uninstall() {
  validate_launchctl
  if ! assert_launchd_domain; then
    exit 1
  fi

  if ! service_state="$(query_service_state)"; then
    fail "无法确认 LaunchAgent 状态；拒绝卸载。"
  fi
  if [ "$service_state" = "loaded" ]; then
    if ! "$LAUNCHCTL_BIN" bootout "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      fail "无法停止 LaunchAgent：$LABEL"
    fi
    if ! wait_for_service_absent; then
      fail "bootout 后未能在限定时间内确认 LaunchAgent absent；拒绝删除 plist。"
    fi
  fi

  if [ -e "$PLIST" ]; then
    if [ ! -f "$PLIST" ] || [ -L "$PLIST" ]; then
      fail "拒绝删除 non-regular plist：$PLIST"
    fi
    if ! rm -f "$PLIST"; then
      fail "无法删除 plist：$PLIST"
    fi
  fi

  echo "DevSpace recovery LaunchAgent 已卸载：$LABEL"
}

case "${1:-}" in
  --uninstall)
    uninstall
    exit 0
    ;;
  "") ;;
  *)
    echo "用法：$0 [--uninstall]" >&2
    exit 2
    ;;
esac

validate_install_tools
validate_dsup
if ! assert_launchd_domain; then
  exit 1
fi

if ! mkdir -p "$PLIST_DIR" "$LOG_DIR"; then
  fail "无法创建 LaunchAgents/Logs 目录。"
fi

if ! PLIST_CANDIDATE="$(mktemp "$PLIST_DIR/.${LABEL}.candidate.XXXXXX")"; then
  fail "无法创建 plist candidate。"
fi

if ! PLIST_LABEL="$LABEL" \
PLIST_DSUP="$DSUP" \
PLIST_STDOUT="$STDOUT_LOG" \
PLIST_STDERR="$STDERR_LOG" \
PLIST_INTERVAL="$START_INTERVAL" \
"$PYTHON3_BIN" - "$PLIST_CANDIDATE" <<'PY'
import os
import plistlib
import sys

payload = {
    "Label": os.environ["PLIST_LABEL"],
    "ProgramArguments": [
        os.environ["PLIST_DSUP"],
        "--ensure",
    ],
    "EnvironmentVariables": {
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    },
    "RunAtLoad": True,
    "StartInterval": int(os.environ["PLIST_INTERVAL"]),
    "StandardOutPath": os.environ["PLIST_STDOUT"],
    "StandardErrorPath": os.environ["PLIST_STDERR"],
}

with open(sys.argv[1], "wb") as destination:
    plistlib.dump(payload, destination)
PY
then
  fail "plist candidate 生成失败；existing plist/LaunchAgent 未修改。"
fi

if ! chmod 600 "$PLIST_CANDIDATE"; then
  fail "无法设置 plist candidate 权限。"
fi
if ! "$PLUTIL_BIN" -lint "$PLIST_CANDIDATE" >/dev/null 2>&1; then
  fail "plist candidate 校验失败；existing plist/LaunchAgent 未修改。"
fi

if ! capture_previous_state; then
  exit 1
fi

if [ "$had_plist" -eq 1 ] && [ "$had_service" -eq 1 ] && cmp -s "$PLIST_CANDIDATE" "$PLIST"; then
  echo "DevSpace recovery LaunchAgent 已是目标配置：$LABEL"
  exit 0
fi

if [ "$had_service" -eq 1 ]; then
  bootout_failed=0
  if ! "$LAUNCHCTL_BIN" bootout "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    bootout_failed=1
  fi
  if ! wait_for_service_absent; then
    if [ "$bootout_failed" -eq 1 ]; then
      echo "ERROR: 无法停止 previous LaunchAgent；原服务仍在运行，未修改 plist。" >&2
      exit 1
    fi
    rollback_required=1
    echo "ERROR: bootout 后未能在限定时间内确认 previous LaunchAgent absent；触发 rollback。" >&2
    exit 1
  fi
  if [ "$bootout_failed" -eq 1 ]; then
    rollback_required=1
    echo "ERROR: launchctl bootout 返回失败且 previous service 已 absent；触发 rollback。" >&2
    exit 1
  fi
fi

rollback_required=1
if ! mv -f "$PLIST_CANDIDATE" "$PLIST"; then
  echo "ERROR: 无法原子发布 plist；触发 rollback。" >&2
  exit 1
fi
PLIST_CANDIDATE=""

if ! "$LAUNCHCTL_BIN" bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1; then
  echo "ERROR: launchctl bootstrap 失败；触发 rollback。" >&2
  exit 1
fi

if ! service_state="$(query_service_state)"; then
  echo "ERROR: bootstrap 后无法确认 LaunchAgent 状态；触发 rollback。" >&2
  exit 1
fi
if [ "$service_state" != "loaded" ]; then
  echo "ERROR: bootstrap 返回成功但 LaunchAgent 确认 absent；触发 rollback。" >&2
  exit 1
fi

rollback_required=0
echo "DevSpace recovery LaunchAgent 已安装：$LABEL"
echo "  $DSUP --ensure"
echo "  interval=${START_INTERVAL}s"
