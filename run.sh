#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[!] Khong tim thay Node.js >= 22. Hay cai dat Node.js roi thu lai." >&2
  exit 1
fi

NODE_MAJOR=$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "[!] Can Node.js >= 22 (hien tai: $(node -v))." >&2
  exit 1
fi

if [ ! -f config.json ] && [ -f config.example.json ]; then
  cp config.example.json config.json
fi

if [ "$#" -gt 0 ]; then
  exec node src/index.js "$@"
fi

echo "========================================"
echo "  BOT DONG HANH MINECRAFT - JAVA 1.21.1"
echo "========================================"

if [ -t 0 ]; then
  printf "Nhap cong LAN Minecraft (bam Enter de dung cong trong config.json): "
  read -r LAN_PORT || LAN_PORT=""
  if [ -n "$LAN_PORT" ]; then
    exec node src/index.js --port "$LAN_PORT"
  fi
fi

exec node src/index.js --no-prompt
