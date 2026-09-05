#!/usr/bin/env bash
# 全自动验证：构建 + 单元/E2E + CLI 真实用户流程模拟
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==== 1. npm install ===="
npm install

echo "==== 2. build shared + core ===="
npm run build -w @cipherzip/shared
npm run build -w @cipherzip/core
npm run build -w @cipherzip/cli

echo "==== 3. vitest e2e ===="
npm run test -w @cipherzip/core

echo "==== 4. CLI 真实流程 ===="
TMP=$(mktemp -d)
mkdir -p "$TMP/in" "$TMP/out"
echo "你好 CipherZip 验证 $(date -Iseconds)" > "$TMP/in/hello.txt"
dd if=/dev/urandom of="$TMP/in/blob.bin" bs=1024 count=64 status=none
# 伪密钥文件
dd if=/dev/urandom of="$TMP/key.mp3" bs=1024 count=20 status=none

node cipherzip/cli/dist/cli.js pack "$TMP/in" -o "$TMP/a.ccz" -p 'Verify#Passw0rd'
node cipherzip/cli/dist/cli.js list "$TMP/a.ccz" -p 'Verify#Passw0rd'
node cipherzip/cli/dist/cli.js unpack "$TMP/a.ccz" -d "$TMP/out" -p 'Verify#Passw0rd'
grep -q 'CipherZip' "$TMP/out/hello.txt" || grep -q 'CipherZip' "$TMP/out/in/hello.txt"

# 错误密码应失败
if node cipherzip/cli/dist/cli.js unpack "$TMP/a.ccz" -d "$TMP/bad" -p 'wrong' 2>/dev/null; then
  echo "错误: 错误密码不应成功"; exit 1
else
  echo "OK: 错误密码被拒绝"
fi

# 密钥文件
node cipherzip/cli/dist/cli.js pack "$TMP/in/hello.txt" -o "$TMP/b.ccz" -k "$TMP/key.mp3"
node cipherzip/cli/dist/cli.js unpack "$TMP/b.ccz" -d "$TMP/out2" -k "$TMP/key.mp3"

# zip
node cipherzip/cli/dist/cli.js pack "$TMP/in/hello.txt" -o "$TMP/c.zip" --format zip
node cipherzip/cli/dist/cli.js unpack "$TMP/c.zip" -d "$TMP/out3"

echo "==== 5. build desktop UI ===="
npm run build -w @cipherzip/desktop

rm -rf "$TMP"
echo "==== 全部验证通过 ===="
