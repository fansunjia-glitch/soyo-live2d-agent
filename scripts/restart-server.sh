#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${SOYO_BRANCH:-main}"
RUNTIME_DIR="${SOYO_RUNTIME_DIR:-${PROJECT_DIR}/backend/data}"
PID_FILE="${RUNTIME_DIR}/soyo-dev.pid"
LOG_FILE="${RUNTIME_DIR}/soyo.log"
BACKEND_PORT=8787
FRONTEND_PORT=5173

log() {
  printf '[soyo] %s\n' "$*"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log "Missing required command: $1"
    exit 1
  fi
}

port_in_use() {
  ss -ltnH "sport = :$1" 2>/dev/null | grep -q .
}

stop_previous_process_group() {
  if [[ ! -f "${PID_FILE}" ]]; then
    return
  fi

  local pid
  pid="$(tr -cd '0-9' < "${PID_FILE}")"
  if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
    local process_args
    process_args="$(ps -p "${pid}" -o args= 2>/dev/null || true)"
    if [[ "${process_args}" != *"npm run dev"* ]]; then
      log "Ignoring stale PID file; process ${pid} is not a Soyo dev server"
      rm -f "${PID_FILE}"
      return
    fi

    log "Stopping previous process group ${pid}"
    kill -TERM -- "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null || true

    for _ in {1..10}; do
      if ! kill -0 "${pid}" 2>/dev/null; then
        break
      fi
      sleep 1
    done

    if kill -0 "${pid}" 2>/dev/null; then
      log "Previous process did not stop in time; forcing shutdown"
      kill -KILL -- "-${pid}" 2>/dev/null || kill -KILL "${pid}" 2>/dev/null || true
    fi
  fi
  rm -f "${PID_FILE}"
}

clear_port() {
  local port="$1"
  if ! port_in_use "${port}"; then
    return
  fi
  if ! command -v fuser >/dev/null 2>&1; then
    log "Port ${port} is occupied and fuser is unavailable. Install psmisc and retry."
    exit 1
  fi

  log "Clearing port ${port}"
  fuser -k "${port}/tcp" >/dev/null 2>&1 || true
}

dependencies_changed() {
  local old_revision="$1"
  local new_revision="$2"
  shift 2
  if [[ "${old_revision}" == "${new_revision}" ]]; then
    return 1
  fi
  if git diff --quiet "${old_revision}" "${new_revision}" -- "$@"; then
    return 1
  fi
  return 0
}

cd "${PROJECT_DIR}"
mkdir -p "${RUNTIME_DIR}"

require_command git
require_command npm
require_command python3
require_command curl
require_command ss
require_command ps

if ! git diff --quiet || ! git diff --cached --quiet; then
  log "Tracked files have local changes. Commit or restore them before restarting."
  exit 1
fi

current_branch="$(git branch --show-current)"
if [[ "${current_branch}" != "${BRANCH}" ]]; then
  log "Expected branch ${BRANCH}, but current branch is ${current_branch}."
  exit 1
fi

old_revision="$(git rev-parse HEAD)"
log "Pulling origin/${BRANCH}"
git pull --ff-only origin "${BRANCH}"
new_revision="$(git rev-parse HEAD)"

python_dependencies_changed=false
node_dependencies_changed=false
if [[ ! -x "${PROJECT_DIR}/.venv/bin/python3" ]]; then
  log "Creating Python virtual environment"
  python3 -m venv "${PROJECT_DIR}/.venv"
  python_dependencies_changed=true
elif dependencies_changed "${old_revision}" "${new_revision}" backend/requirements.txt; then
  python_dependencies_changed=true
fi

if [[ ! -d "${PROJECT_DIR}/node_modules" ]]; then
  node_dependencies_changed=true
elif dependencies_changed "${old_revision}" "${new_revision}" package.json package-lock.json; then
  node_dependencies_changed=true
fi

if [[ "${python_dependencies_changed}" == true ]] \
  || ! "${PROJECT_DIR}/.venv/bin/python3" -c 'import fastapi, httpx, uvicorn' >/dev/null 2>&1; then
  log "Installing Python dependencies"
  "${PROJECT_DIR}/.venv/bin/python3" -m pip install -r backend/requirements.txt
fi

if [[ "${node_dependencies_changed}" == true ]]; then
  log "Installing Node.js dependencies"
  npm install
fi

stop_previous_process_group
clear_port "${BACKEND_PORT}"
clear_port "${FRONTEND_PORT}"

export PATH="${PROJECT_DIR}/.venv/bin:${PATH}"
log "Starting frontend and backend"
if command -v setsid >/dev/null 2>&1; then
  nohup setsid npm run dev > "${LOG_FILE}" 2>&1 < /dev/null &
else
  nohup npm run dev > "${LOG_FILE}" 2>&1 < /dev/null &
fi
service_pid=$!
printf '%s\n' "${service_pid}" > "${PID_FILE}"

for _ in {1..30}; do
  if ! kill -0 "${service_pid}" 2>/dev/null; then
    break
  fi
  if curl -fsS "http://127.0.0.1:${BACKEND_PORT}/health" >/dev/null \
    && curl -fsS "http://127.0.0.1:${FRONTEND_PORT}/" >/dev/null; then
    log "Restart complete at commit ${new_revision:0:7}"
    log "Frontend: http://127.0.0.1:${FRONTEND_PORT}/"
    log "Backend:  http://127.0.0.1:${BACKEND_PORT}/health"
    log "Log file: ${LOG_FILE}"
    exit 0
  fi
  sleep 1
done

log "Services did not become healthy. Recent log output:"
tail -n 80 "${LOG_FILE}" 2>/dev/null || true
exit 1
