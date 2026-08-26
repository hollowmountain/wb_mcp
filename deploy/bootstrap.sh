#!/usr/bin/env bash
# Первичная настройка сервера под mcp-wb. Ubuntu 24.04.
#
# Скрипт рассчитан на то, что сервер НЕ пустой: на нём могут работать VPN
# (Hysteria/Xray), панели и другие сервисы. Поэтому здесь нет ни одной
# операции, которая меняет сетевую политику или трогает чужие пакеты.
#
# Запускать от root:  bash bootstrap.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/hollowmountain/wb_mcp.git}"
APP_DIR="${APP_DIR:-/opt/mcp-wb}"
SWAP_FILE="/swapfile"
SWAP_SIZE_MB="${SWAP_SIZE_MB:-2048}"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[33m    ! %s\033[0m\n' "$1"; }

if [[ $EUID -ne 0 ]]; then
    echo "Запускайте от root: sudo bash bootstrap.sh" >&2
    exit 1
fi

# ─── Проверка, что 80 и 443 действительно свободны ───────────────────────────
say "Проверяю, свободны ли порты 80 и 443"
busy=0
for port in 80 443; do
    if ss -lnt "sport = :$port" 2>/dev/null | grep -q LISTEN; then
        warn "Порт $port уже занят:"
        ss -lntp "sport = :$port" | tail -n +2 | sed 's/^/      /'
        busy=1
    else
        echo "    $port свободен"
    fi
done
if [[ $busy -eq 1 ]]; then
    echo "Занятые порты нужны Caddy. Освободите их или поменяйте конфигурацию." >&2
    exit 1
fi

# ─── Firewall: не трогаем, только сообщаем ───────────────────────────────────
say "Состояние firewall"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    echo "    ufw активен — добавляю только 80 и 443, остальные правила не трогаю"
    ufw allow 80/tcp  >/dev/null
    ufw allow 443/tcp >/dev/null
else
    echo "    ufw выключен — оставляю как есть"
    warn "Не включайте ufw без явного списка портов: на сервере работают"
    warn "сторонние сервисы (VPN, панели), и правило по умолчанию их обрубит."
    echo "    Сейчас слушают:"
    ss -lntup 2>/dev/null | awk 'NR>1 {print "      " $1 "  " $5 "  " $7}' | sort -u
fi

# ─── Swap: сборка образа на 1 ГБ RAM без него падает ─────────────────────────
say "Swap"
if [[ -n "$(swapon --show --noheadings 2>/dev/null)" ]]; then
    echo "    swap уже есть, пропускаю"
else
    total_mb=$(free -m | awk '/^Mem:/ {print $2}')
    if (( total_mb < 2048 )); then
        echo "    RAM ${total_mb} МБ — добавляю swap ${SWAP_SIZE_MB} МБ для сборки"
        fallocate -l "${SWAP_SIZE_MB}M" "$SWAP_FILE" || dd if=/dev/zero of="$SWAP_FILE" bs=1M count="$SWAP_SIZE_MB" status=none
        chmod 600 "$SWAP_FILE"
        mkswap "$SWAP_FILE" >/dev/null
        swapon "$SWAP_FILE"
        grep -q "^$SWAP_FILE" /etc/fstab || echo "$SWAP_FILE none swap sw 0 0" >> /etc/fstab
        free -m | grep -i swap | sed 's/^/    /'
    else
        echo "    RAM ${total_mb} МБ — swap не нужен"
    fi
fi

# ─── Пакеты ──────────────────────────────────────────────────────────────────
say "Проверяю Docker и Compose"
export DEBIAN_FRONTEND=noninteractive

if ! command -v docker >/dev/null 2>&1; then
    echo "    Docker не найден — ставлю из репозитория Ubuntu"
    apt-get update -qq
    apt-get install -y -qq docker.io
    systemctl enable --now docker
else
    echo "    $(docker --version) — уже установлен, не трогаю"
fi

if ! docker compose version >/dev/null 2>&1; then
    echo "    Плагин compose не найден — ставлю docker-compose-v2 из репозитория Ubuntu"
    apt-get update -qq
    apt-get install -y -qq docker-compose-v2
else
    echo "    $(docker compose version) — уже есть"
fi

for pkg in git curl ca-certificates; do
    command -v "$pkg" >/dev/null 2>&1 || apt-get install -y -qq "$pkg"
done

# ─── Код ─────────────────────────────────────────────────────────────────────
say "Забираю код в $APP_DIR"
if [[ -d "$APP_DIR/.git" ]]; then
    git -C "$APP_DIR" fetch --depth 1 origin main
    git -C "$APP_DIR" reset --hard origin/main
else
    git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi
git -C "$APP_DIR" log --oneline -1 | sed 's/^/    /'

# ─── .env ────────────────────────────────────────────────────────────────────
say "Готовлю .env"
cd "$APP_DIR"
if [[ -f .env ]]; then
    echo "    .env уже есть, не перезаписываю"
else
    cp .env.example .env
    sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|" .env
    chmod 600 .env
    echo "    создан $APP_DIR/.env — заполните WB_TOKEN, PUBLIC_URL, MCP_DOMAIN, ACME_EMAIL"
fi

say "Готово"
cat <<'NEXT'
    Дальше:
      1. заполнить /opt/mcp-wb/.env
      2. cd /opt/mcp-wb && docker compose up -d --build
      3. curl https://<домен>/.well-known/oauth-protected-resource/mcp
NEXT
