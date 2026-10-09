#!/usr/bin/env bash
# Запуск/остановка веб-интерфейса Kryptex Multi-Sort.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8099}"
HOST="${HOST:-127.0.0.1}"
PIDFILE="server.pid"
LOGFILE="server.log"

stop() {
  if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    kill "$(cat "$PIDFILE")" && echo "Остановлен PID $(cat "$PIDFILE")"
    rm -f "$PIDFILE"
  else
    echo "Не запущен."
  fi
}

case "${1:-start}" in
  start)
    if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "Уже запущен: PID $(cat "$PIDFILE") → http://${HOST}:${PORT}"
      exit 0
    fi
    PORT="$PORT" HOST="$HOST" nohup node server.mjs > "$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    sleep 2
    echo "Запущен: PID $(cat "$PIDFILE") → http://${HOST}:${PORT}"
    tail -n 3 "$LOGFILE"
    ;;
  stop) stop ;;
  restart) stop; exec "$0" start ;;
  status)
    if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "Работает: PID $(cat "$PIDFILE")"
      curl -s "http://${HOST}:${PORT}/api/health" || true
      echo
    else
      echo "Не запущен."
    fi
    ;;
  *) echo "Использование: $0 {start|stop|restart|status}"; exit 1 ;;
esac
