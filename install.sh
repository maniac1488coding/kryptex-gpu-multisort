#!/usr/bin/env bash
#
# Kryptex GPU Multi-Sort — автоматическое развёртывание.
#
# Скрипт делает всё сам:
#   1. проверяет и при необходимости устанавливает Node.js (>= 18);
#   2. разворачивает код (из текущей папки или клонирует репозиторий);
#   3. ставит зависимости (у приложения их нет, но шаг выполняется по-честному);
#   4. подбирает свободный порт;
#   5. регистрирует сервис (systemd --user, иначе nohup + cron @reboot);
#   6. запускает и проверяет, что веб-интерфейс отвечает.
#
# Примеры:
#   ./install.sh                       # поставить в текущую папку, порт подобрать
#   ./install.sh --port 9000           # конкретный порт
#   ./install.sh --host 0.0.0.0        # доступ с других устройств
#   ./install.sh --dir ~/gpu-sort      # развернуть в другую папку
#   ./install.sh --repo https://github.com/user/repo.git
#   ./install.sh --update              # обновить код и перезапустить
#   ./install.sh --uninstall           # остановить и удалить сервис
#
set -euo pipefail

APP_NAME="kryptex-gpu-multisort"
SERVICE_NAME="kryptex-gpu"
NODE_MIN=18
DEFAULT_PORT=8099

# ---------------------------------------------------------------- параметры

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_URL="${REPO_URL:-}"
APP_DIR="${APP_DIR:-}"
PORT="${PORT:-}"
HOST="${HOST:-127.0.0.1}"
ACTION="install"
USE_SERVICE=1
FORCE=0

usage() {
  sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Опции:
  --port N          порт (по умолчанию — первый свободный начиная с 8099)
  --host ADDR       адрес прослушивания (127.0.0.1 по умолчанию, 0.0.0.0 — для сети)
  --dir PATH        куда развернуть (по умолчанию — папка скрипта, иначе ~/kryptex-gpu-multisort)
  --repo URL        откуда клонировать, если запускаете не из репозитория
  --no-service      не регистрировать сервис, просто запустить процесс
  --update          обновить код (git pull) и перезапустить
  --uninstall       остановить сервис и удалить его регистрацию
  --force           переустановить сервис, даже если он уже есть
  -h, --help        эта справка
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)       PORT="${2:?--port требует значение}"; shift 2 ;;
    --host)       HOST="${2:?--host требует значение}"; shift 2 ;;
    --dir)        APP_DIR="${2:?--dir требует значение}"; shift 2 ;;
    --repo)       REPO_URL="${2:?--repo требует значение}"; shift 2 ;;
    --no-service) USE_SERVICE=0; shift ;;
    --update)     ACTION="update"; shift ;;
    --uninstall)  ACTION="uninstall"; shift ;;
    --force)      FORCE=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "Неизвестная опция: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# ---------------------------------------------------------------- вывод

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_OK=$'\033[32m'
  C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_ACC=$'\033[36m'
else
  C_RESET=""; C_DIM=""; C_OK=""; C_WARN=""; C_ERR=""; C_ACC=""
fi

step() { printf '%s==>%s %s\n' "$C_ACC" "$C_RESET" "$*"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    %s✓%s %s\n' "$C_OK" "$C_RESET" "$*"; }
warn() { printf '    %s!%s %s\n' "$C_WARN" "$C_RESET" "$*" >&2; }
die()  { printf '%sОшибка:%s %s\n' "$C_ERR" "$C_RESET" "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- утилиты

port_busy() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
}

# Совпадение с портом, который уже слушает НАШ сервис из другого места, не считаем занятым
find_free_port() {
  local p="${1:-$DEFAULT_PORT}" limit=$(( ${1:-$DEFAULT_PORT} + 100 ))
  while (( p < limit )); do
    if ! port_busy "$p"; then echo "$p"; return 0; fi
    p=$(( p + 1 ))
  done
  return 1
}

# Определяем, лежит ли рядом готовый проект
looks_like_project() {
  [[ -f "$1/server.mjs" && -d "$1/public" ]]
}

# ---------------------------------------------------------------- Node.js

node_version_ok() {
  have node || return 1
  local v
  v="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [[ "$v" -ge "$NODE_MIN" ]]
}

install_node() {
  step "Node.js не найден или старее $NODE_MIN — устанавливаю"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    have brew || die "Установите Homebrew (https://brew.sh) либо Node.js $NODE_MIN+ вручную"
    brew install node
    return
  fi

  have sudo || die "Для установки Node.js нужен sudo или права root"
  if [[ "$(id -u)" -eq 0 ]]; then SUDO=""; else SUDO="sudo"; fi

  if have apt-get; then
    info "подключаю репозиторий NodeSource и ставлю nodejs"
    $SUDO apt-get update -qq
    $SUDO apt-get install -y -qq ca-certificates curl gnupg
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
    $SUDO apt-get install -y -qq nodejs
  elif have dnf; then
    $SUDO dnf install -y nodejs npm
  elif have yum; then
    $SUDO yum install -y nodejs npm
  elif have pacman; then
    $SUDO pacman -Sy --noconfirm nodejs npm
  elif have zypper; then
    $SUDO zypper --non-interactive install nodejs npm
  elif have apk; then
    $SUDO apk add --no-cache nodejs npm
  else
    die "Не знаю, как поставить Node.js в этой системе. Поставьте вручную: https://nodejs.org"
  fi

  node_version_ok || die "Node.js установлен, но версия всё ещё ниже $NODE_MIN"
}

ensure_node() {
  step "Проверяю Node.js"
  if node_version_ok; then
    ok "node $(node -v) ($(command -v node))"
  else
    install_node
    ok "node $(node -v)"
  fi
  have npm && ok "npm $(npm -v)" || warn "npm не найден — зависимости ставить не буду (приложению они не нужны)"
}

# ---------------------------------------------------------------- код

fetch_code() {
  if looks_like_project "$SCRIPT_DIR"; then
    APP_DIR="${APP_DIR:-$SCRIPT_DIR}"
    if [[ "$APP_DIR" != "$SCRIPT_DIR" ]]; then
      step "Копирую проект в $APP_DIR"
      mkdir -p "$APP_DIR"
      for item in server.mjs public package.json package-lock.json run.sh README.md LICENSE .gitignore; do
        [[ -e "$SCRIPT_DIR/$item" ]] && cp -r "$SCRIPT_DIR/$item" "$APP_DIR/"
      done
    fi
    ok "код на месте: $APP_DIR"
    return
  fi

  APP_DIR="${APP_DIR:-$HOME/$APP_NAME}"

  if [[ -d "$APP_DIR/.git" ]]; then
    step "Обновляю код в $APP_DIR"
    git -C "$APP_DIR" pull --ff-only
    ok "обновлено"
    return
  fi

  [[ -n "$REPO_URL" ]] || die "Проект не найден рядом и не задан --repo URL. Укажите репозиторий: ./install.sh --repo <url>"
  have git || die "Нужен git для клонирования репозитория"
  step "Клонирую $REPO_URL → $APP_DIR"
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
  ok "склонировано"
}

install_deps() {
  step "Ставлю зависимости"
  cd "$APP_DIR"
  if [[ ! -f package.json ]]; then
    ok "package.json нет — пропускаю"
    return
  fi
  if ! have npm; then
    warn "npm недоступен — пропускаю (у приложения нет runtime-зависимостей)"
    return
  fi

  # у приложения нет зависимостей времени выполнения; шаг нужен для полноты
  if [[ -f package-lock.json ]]; then
    npm ci --omit=dev --silent --no-audit --no-fund || npm install --omit=dev --silent --no-audit --no-fund
  else
    npm install --omit=dev --silent --no-audit --no-fund
  fi
  ok "зависимости в порядке (runtime-зависимостей нет)"

  if [[ "${WITH_DEV:-0}" == "1" ]]; then
    info "ставлю devDependencies для тестов"
    npm install --silent --no-audit --no-fund
    ok "jsdom и прочее установлены"
  fi
}

# ---------------------------------------------------------------- сервис

service_unit_path() { echo "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/${SERVICE_NAME}.service"; }
has_systemd_user() { have systemctl && systemctl --user show-environment >/dev/null 2>&1; }

install_service_systemd() {
  local unit node_bin
  unit="$(service_unit_path)"
  node_bin="$(command -v node)"
  mkdir -p "$(dirname "$unit")"

  step "Регистрирую сервис systemd --user"
  cat > "$unit" <<EOF
[Unit]
Description=Kryptex GPU multi-sort (веб-таблица видеокарт)
Documentation=file://$APP_DIR/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$node_bin $APP_DIR/server.mjs
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=HOST=$HOST
Restart=on-failure
RestartSec=5
StandardOutput=append:$APP_DIR/server.log
StandardError=append:$APP_DIR/server.log

[Install]
WantedBy=default.target
EOF
  ok "юнит: $unit"

  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  systemctl --user restart "$SERVICE_NAME"

  if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo no)" != "yes" ]]; then
    warn "автозапуск после перезагрузки выключен (Linger=no)"
    info "включить: sudo loginctl enable-linger $USER"
  fi
  ok "сервис запущен"
}

install_service_fallback() {
  step "systemd недоступен — запускаю через nohup и добавляю в cron @reboot"
  cd "$APP_DIR"
  PORT="$PORT" HOST="$HOST" ./run.sh restart >/dev/null 2>&1 || PORT="$PORT" HOST="$HOST" ./run.sh start
  ok "процесс запущен, PID $(cat "$APP_DIR/server.pid" 2>/dev/null || echo '?')"

  if have crontab; then
    local marker="# $APP_NAME autostart"
    { crontab -l 2>/dev/null | grep -vF "$marker" || true
      echo "@reboot cd $APP_DIR && PORT=$PORT HOST=$HOST ./run.sh start $marker"
    } | crontab -
    ok "добавлен автозапуск в cron"
  else
    warn "cron не найден — после перезагрузки запускайте вручную: cd $APP_DIR && ./run.sh start"
  fi
}

remove_service() {
  if [[ -f "$(service_unit_path)" ]] || has_systemd_user; then
    step "Останавливаю сервис systemd --user"
    systemctl --user disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
    rm -f "$(service_unit_path)"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    ok "сервис удалён"
  fi
  if [[ -f "$APP_DIR/server.pid" ]]; then
    ( cd "$APP_DIR" && ./run.sh stop ) >/dev/null 2>&1 || true
    ok "фоновый процесс остановлен"
  fi
  if have crontab; then
    local marker="# $APP_NAME autostart"
    if crontab -l 2>/dev/null | grep -qF "$marker"; then
      { crontab -l 2>/dev/null | grep -vF "$marker" || true; } | crontab -
      ok "запись автозапуска удалена"
    fi
  fi
}

# ---------------------------------------------------------------- проверка

health_check() {
  local probe_host="$HOST" url
  [[ "$probe_host" == "0.0.0.0" || "$probe_host" == "::" ]] && probe_host="127.0.0.1"
  url="http://${probe_host}:${PORT}/api/health"

  step "Проверяю, что веб-интерфейс отвечает"
  local i
  for i in $(seq 1 30); do
    if have curl && curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      ok "отвечает: $url"
      return 0
    fi
    if ! have curl && port_busy "$PORT"; then
      ok "порт $PORT слушается"
      return 0
    fi
    sleep 1
  done
  warn "не дождался ответа от $url"
  info "лог: tail -n 50 $APP_DIR/server.log"
  return 1
}

# ---------------------------------------------------------------- действия

do_uninstall() {
  APP_DIR="${APP_DIR:-$(looks_like_project "$SCRIPT_DIR" && echo "$SCRIPT_DIR" || echo "$HOME/$APP_NAME")}"
  remove_service
  printf '\n%sГотово.%s Данные в %s не тронуты — удалить вручную: rm -rf %s\n' \
    "$C_OK" "$C_RESET" "$APP_DIR" "$APP_DIR"
}

do_update() {
  APP_DIR="${APP_DIR:-$(looks_like_project "$SCRIPT_DIR" && echo "$SCRIPT_DIR" || echo "$HOME/$APP_NAME")}"
  step "Обновляю $APP_DIR"
  if [[ -d "$APP_DIR/.git" ]]; then
    git -C "$APP_DIR" pull --ff-only
  else
    warn "это не git-репозиторий — обновление кода пропущено"
  fi
  cd "$APP_DIR"
  install_deps
  if [[ -f "$(service_unit_path)" ]]; then
    systemctl --user restart "$SERVICE_NAME"
    ok "сервис перезапущен"
  else
    PORT="$PORT" HOST="$HOST" ./run.sh restart >/dev/null 2>&1 || true
    ok "процесс перезапущен"
  fi
  PORT="${PORT:-$(sed -n 's/^Environment=PORT=\([0-9]*\).*/\1/p' "$(service_unit_path)" 2>/dev/null | head -1)}"
  PORT="${PORT:-$DEFAULT_PORT}"
  local unit_host
  unit_host="$(sed -n 's/^Environment=HOST=//p' "$(service_unit_path)" 2>/dev/null | head -1)"
  HOST="${unit_host:-$HOST}"
  health_check || true
  echo
  echo "Открыть: http://127.0.0.1:$PORT"
}

do_install() {
  echo
  echo "${C_ACC}${APP_NAME}${C_RESET} — автоматическое развёртывание"
  echo "${C_DIM}$(date '+%Y-%m-%d %H:%M:%S')${C_RESET}"
  echo

  ensure_node
  fetch_code
  cd "$APP_DIR"

  # порт: явный → из уже установленного сервиса → первый свободный
  local installed_port=""
  if [[ -f "$(service_unit_path)" ]]; then
    installed_port="$(sed -n 's/^Environment=PORT=\([0-9]*\).*/\1/p' "$(service_unit_path)" | head -1)"
  fi

  if [[ -n "$PORT" ]]; then
    step "Порт: $PORT (задан)"
    if port_busy "$PORT" && [[ "$PORT" != "$installed_port" ]] && [[ "$FORCE" -eq 0 ]]; then
      warn "порт $PORT уже занят другим процессом"
      info "освободите его или укажите другой: ./install.sh --port 9000"
      exit 1
    fi
  elif [[ -n "$installed_port" ]]; then
    PORT="$installed_port"
    step "Порт: $PORT (как у установленного сервиса)"
  else
    PORT="$(find_free_port "$DEFAULT_PORT")" || die "не нашёл свободный порт рядом с $DEFAULT_PORT"
    step "Свободный порт: $PORT"
  fi

  install_deps

  if [[ "$USE_SERVICE" -eq 1 ]]; then
    if has_systemd_user; then
      install_service_systemd
    else
      install_service_fallback
    fi
  else
    step "Запускаю без регистрации сервиса"
    PORT="$PORT" HOST="$HOST" ./run.sh restart >/dev/null 2>&1 || PORT="$PORT" HOST="$HOST" ./run.sh start
    ok "процесс запущен"
  fi

  health_check || true

  echo
  printf '%sГотово.%s\n\n' "$C_OK" "$C_RESET"
  printf '  Открыть:      %shttp://127.0.0.1:%s%s\n' "$C_ACC" "$PORT" "$C_RESET"
  printf '  Папка:        %s\n' "$APP_DIR"
  printf '  Лог:          %s\n' "$APP_DIR/server.log"
  echo
  if [[ "$USE_SERVICE" -eq 1 ]] && has_systemd_user; then
    printf '  Управление:   systemctl --user {status|restart|stop} %s\n' "$SERVICE_NAME"
    printf '  Обновление:   %s/install.sh --update\n' "$APP_DIR"
    printf '  Удаление:     %s/install.sh --uninstall\n' "$APP_DIR"
  else
    printf '  Управление:   %s/run.sh {start|stop|restart|status}\n' "$APP_DIR"
  fi
  if [[ "$HOST" == "127.0.0.1" ]]; then
    echo
    info "доступ только с этого компьютера; для сети: ./install.sh --host 0.0.0.0"
  fi
  echo
}

case "$ACTION" in
  install)   do_install ;;
  update)    do_update ;;
  uninstall) do_uninstall ;;
esac
