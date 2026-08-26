#!/usr/bin/env bash
# Первичная настройка сервера под mcp-wb. Ubuntu 24.04.
# Запускать на сервере от root:
#   bash bootstrap.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/hollowmountain/wb_mcp.git}"
APP_DIR="${APP_DIR:-/opt/mcp-wb}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

if [[ $EUID -ne 0 ]]; then
    echo "Запускайте от root: sudo bash bootstrap.sh" >&2
    exit 1
fi

say "Обновляю пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git ufw

say "Ставлю Docker из официального репозитория"
if ! command -v docker >/dev/null 2>&1; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
        > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
    echo "Docker уже установлен: $(docker --version)"
fi
systemctl enable --now docker

say "Открываю порты 22, 80, 443"
ufw allow 22/tcp  >/dev/null
ufw allow 80/tcp  >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ufw status numbered | sed 's/^/    /'

say "Забираю код в $APP_DIR"
if [[ -d "$APP_DIR/.git" ]]; then
    git -C "$APP_DIR" pull --ff-only
else
    git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi

say "Готовлю .env"
cd "$APP_DIR"
if [[ ! -f .env ]]; then
    cp .env.example .env
    # Секрет сессий генерируем сразу, чтобы его точно не забыли.
    SECRET="$(openssl rand -hex 32)"
    sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=${SECRET}|" .env
    chmod 600 .env
    echo "Создан $APP_DIR/.env — заполните WB_TOKEN, PUBLIC_URL, MCP_DOMAIN, ACME_EMAIL, ALLOWED_EMAILS."
else
    echo ".env уже есть, не трогаю."
fi

cat <<'NEXT'

Дальше вручную:
  1. nano /opt/mcp-wb/.env      — вписать WB_TOKEN и домен
  2. cd /opt/mcp-wb && docker compose -f docker/docker-compose.yml up -d --build
  3. docker compose -f docker/docker-compose.yml logs -f

Проверка снаружи:
  curl https://<домен>/.well-known/oauth-protected-resource/mcp
NEXT
