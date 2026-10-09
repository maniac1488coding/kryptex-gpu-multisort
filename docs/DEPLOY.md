# Развёртывание

Проект не имеет зависимостей времени выполнения — нужен только **Node.js 18 или новее**.
Скрипт `install.sh` устанавливает и его, если в системе Node нет или он устарел.

## Быстрый старт

```bash
git clone <repo-url> kryptex-gpu-multisort
cd kryptex-gpu-multisort
./install.sh
```

Через полминуты в консоли появится адрес вида `http://127.0.0.1:8099`.

Если вы уже в скачанной папке (без git) — просто `./install.sh`.

## Что делает `install.sh`

| Шаг | Действие |
|---|---|
| 1 | Проверяет Node.js; если нет или версия < 18 — ставит через NodeSource (apt), dnf, yum, pacman, zypper, apk или Homebrew |
| 2 | Разворачивает код: берёт текущую папку либо клонирует репозиторий в `~/kryptex-gpu-multisort` |
| 3 | Ставит зависимости (`npm ci --omit=dev`); runtime-зависимостей нет, шаг для полноты |
| 4 | Подбирает **свободный порт**, начиная с 8099 |
| 5 | Регистрирует сервис: `systemd --user` (автозапуск, автоперезапуск при падении), иначе `nohup` + `cron @reboot` |
| 6 | Запускает и опрашивает `/api/health`, пока сервис не ответит |

Скрипт идемпотентен: повторный запуск обновляет код и перезапускает сервис на том же порту.

## Опции

```bash
./install.sh --port 9000          # конкретный порт
./install.sh --host 0.0.0.0       # доступ с других устройств в сети
./install.sh --dir ~/gpu-sort     # развернуть в другую папку
./install.sh --repo <url>         # откуда клонировать
./install.sh --no-service         # запустить без регистрации сервиса
./install.sh --update             # git pull + перезапуск
./install.sh --uninstall          # остановить и удалить сервис
./install.sh --force              # переустановить поверх
./install.sh --help
```

Переменные окружения: `PORT`, `HOST`, `APP_DIR`, `REPO_URL`, `WITH_DEV=1`
(поставить ещё и devDependencies для тестов).

## Управление после установки

```bash
systemctl --user status  kryptex-gpu
systemctl --user restart kryptex-gpu
systemctl --user stop    kryptex-gpu
journalctl --user -u kryptex-gpu -f
tail -f ~/kryptex-gpu-multisort/server.log
```

Без systemd (или при `--no-service`) — через `run.sh`:

```bash
./run.sh start | stop | restart | status
```

## Автозапуск после перезагрузки

- **systemd**: включается автоматически. Если `Linger=no`, сервис остановится при
  выходе из системы — включите: `sudo loginctl enable-linger $USER`.
- **cron**: скрипт добавляет строку `@reboot` с меткой `# kryptex-gpu-multisort autostart`.

## Ручная установка (без скрипта)

```bash
# Node 18+ любым способом, например:
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

git clone <repo-url> && cd kryptex-gpu-multisort
node server.mjs                    # → http://127.0.0.1:8099
PORT=9000 HOST=0.0.0.0 node server.mjs
```

## Docker (по желанию)

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || true
COPY server.mjs ./
COPY public ./public
ENV PORT=8099 HOST=0.0.0.0
EXPOSE 8099
CMD ["node", "server.mjs"]
```

```bash
docker build -t kryptex-gpu-multisort .
docker run -d --name kryptex-gpu -p 8099:8099 --restart unless-stopped kryptex-gpu-multisort
```

## Тесты

```bash
npm install          # jsdom (devDependency)
npm test             # 60+ проверок в реальном DOM
```

Браузерный тест (скриншоты, экспорт CSV) требует Playwright и запускается отдельно:

```bash
npm i -D playwright && npx playwright install chromium
npm run test:browser
```

## Диагностика

| Симптом | Что делать |
|---|---|
| `Не нашёл свободный порт` | задайте порт вручную: `./install.sh --port 9000` |
| Сервис не поднимается | `journalctl --user -u kryptex-gpu -n 50` или `tail -50 server.log` |
| Порт занят после перезагрузки | проверьте `ss -ltnp \| grep <порт>` |
| Нет данных — «устаревшие данные» | Kryptex недоступен; сервер отдаёт последнюю удачную копию, повторите позже |
| Нужен доступ из локальной сети | `./install.sh --host 0.0.0.0 --port 8099` и откройте порт в фаерволе |
