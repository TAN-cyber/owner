#!/bin/bash
# Owner script locator — source this file to export paths to bundled scripts.
#
# Usage:
#   . /path/to/owner/scripts/owner-env.sh
#
# This file is sourced by workflow snippets. Do not set global shell options here.

_owner_env_source="${BASH_SOURCE[0]:-$0}"
_owner_script_dir="$(cd "$(dirname "$_owner_env_source")" && pwd -P)"
_owner_env_sourced=0
(return 0 2>/dev/null) && _owner_env_sourced=1

export OWNER_GUARD="${OWNER_GUARD:-${_owner_script_dir}/owner-guard.sh}"
export OWNER_STATE="${OWNER_STATE:-${_owner_script_dir}/owner-state.sh}"
export OWNER_HANDOFF="${OWNER_HANDOFF:-${_owner_script_dir}/owner-handoff.sh}"
export OWNER_ARCHIVE="${OWNER_ARCHIVE:-${_owner_script_dir}/owner-archive.sh}"
export OWNER_YAML_VALIDATE="${OWNER_YAML_VALIDATE:-${_owner_script_dir}/owner-yaml-validate.sh}"

_owner_bash_is_usable() {
  local _owner_bash_candidate="$1"
  if [ -z "$_owner_bash_candidate" ]; then
    return 1
  fi
  case "$_owner_bash_candidate" in
    */Windows/System32/bash.exe|*/windows/system32/bash.exe|*\\Windows\\System32\\bash.exe|*\\windows\\system32\\bash.exe)
      return 1
      ;;
  esac
  "$_owner_bash_candidate" -lc 'printf owner-bash-ok' >/dev/null 2>&1
}

_owner_resolve_bash() {
  local _owner_bash_candidate

  if _owner_bash_is_usable "${OWNER_BASH:-}"; then
    printf '%s\n' "$OWNER_BASH"
    return 0
  fi

  if _owner_bash_is_usable "${BASH:-}"; then
    printf '%s\n' "$BASH"
    return 0
  fi

  _owner_bash_candidate="$(command -v sh 2>/dev/null | awk '{ sub(/\/sh(\.exe)?$/, "/bash.exe"); print }')"
  if _owner_bash_is_usable "$_owner_bash_candidate"; then
    printf '%s\n' "$_owner_bash_candidate"
    return 0
  fi

  _owner_bash_candidate="$(command -v bash 2>/dev/null || true)"
  if _owner_bash_is_usable "$_owner_bash_candidate"; then
    printf '%s\n' "$_owner_bash_candidate"
    return 0
  fi

  return 1
}

OWNER_BASH="$(_owner_resolve_bash || true)"
export OWNER_BASH

_owner_env_fail() {
  echo "ERROR: Owner scripts not found. Ensure the owner skill is installed completely." >&2
  echo "Expected path pattern: */owner/scripts/owner-*.sh under project or platform skill directories" >&2
}

_owner_bash_fail() {
  echo "ERROR: usable bash not found. Install Git Bash or set OWNER_BASH to a working bash executable." >&2
  echo "Windows WSL launcher bash.exe is not supported for Owner scripts." >&2
}

_owner_env_abort() {
  local _owner_env_was_sourced="$_owner_env_sourced"
  unset _owner_env_source _owner_script_dir _owner_script _owner_env_missing _owner_env_sourced
  unset _owner_bash_candidate
  unset -f _owner_env_fail _owner_bash_fail _owner_bash_is_usable _owner_resolve_bash
  if [ "$_owner_env_was_sourced" -eq 1 ]; then
    unset -f _owner_env_abort
    return 1
  fi
  exit 1
}

_owner_env_missing=0
if [ -z "$OWNER_BASH" ]; then
  _owner_bash_fail
  _owner_env_missing=1
fi
for _owner_script in \
  "$OWNER_GUARD" \
  "$OWNER_STATE" \
  "$OWNER_HANDOFF" \
  "$OWNER_ARCHIVE" \
  "$OWNER_YAML_VALIDATE"; do
  if [ ! -f "$_owner_script" ]; then
    _owner_env_fail
    _owner_env_missing=1
    break
  fi
done

if [ "$_owner_env_missing" -ne 0 ]; then
  _owner_env_abort
else
  unset _owner_env_source _owner_script_dir _owner_script _owner_env_missing _owner_env_sourced
  unset _owner_bash_candidate
  unset -f _owner_env_fail _owner_bash_fail _owner_bash_is_usable _owner_resolve_bash _owner_env_abort
fi
