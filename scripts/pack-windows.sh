#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export CSC_IDENTITY_AUTO_DISCOVERY=false

echo "==> install & build"
npm install
npm run build -w @cipherzip/shared
npm run build -w @cipherzip/core
npm run build -w @cipherzip/cli || true
npm run build -w @cipherzip/desktop

OUT="$ROOT/cipherzip/desktop/release"
mkdir -p "$OUT"

echo "==> electron-builder Windows portable + zip"
cd cipherzip/desktop
npx electron-builder --win portable zip --x64 --publish never -c.win.signAndEditExecutable=false

cp -f "$OUT/CipherZip-Portable-"*.exe "$OUT/" 2>/dev/null || true
cat > "$OUT/README-安装说明.txt" << 'TXT'
CipherZip 密匣 — Windows 11
双击 CipherZip-Portable-*.exe 即可使用（绿色便携版）。
完整源码与模块说明见仓库 README.md
TXT

echo "==> done: $OUT"
ls -lah "$OUT"
