#!/usr/bin/env bash
# CipherChat 备份脚本：打包数据库 + 密文文件到 tar.gz
# 用法：sudo bash /opt/cipherchat/deploy/backup.sh [备份目录]
set -euo pipefail
APP_DIR="/opt/cipherchat"
OUT_DIR="${1:-/opt/cipherchat-backups}"
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "${OUT_DIR}"
tar -czf "${OUT_DIR}/cipherchat-backup-${STAMP}.tar.gz" -C "${APP_DIR}" db data .env
echo "已备份到 ${OUT_DIR}/cipherchat-backup-${STAMP}.tar.gz"
echo "恢复方法："
echo "  systemctl stop cipherchat-web cipherchat-relay"
echo "  tar -xzf ${OUT_DIR}/cipherchat-backup-${STAMP}.tar.gz -C ${APP_DIR}"
echo "  chown -R cipherchat:cipherchat ${APP_DIR}"
echo "  systemctl start cipherchat-web cipherchat-relay"
