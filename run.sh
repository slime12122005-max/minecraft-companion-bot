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

echo "========================================================"
echo "  BOT DONG HANH MINECRAFT - AUTO LAN & AUTO VERSION"
echo "========================================================"
echo " - Tu dong do cong Open to LAN & nhan dien phien ban (1.8.8 - 1.21.x+)"
echo " - Mo san Antigravity Desktop (bat Minecraft Bot Bridge - Gemini 4 Hydrogen Low) de chat tu nhien"
echo " - Co the go cong LAN (vd: 59251) hoac domain e4mc (vd: xxx.e4mc.link) trong terminal"
echo "========================================================"

exec node src/index.js --auto-lan --no-prompt
