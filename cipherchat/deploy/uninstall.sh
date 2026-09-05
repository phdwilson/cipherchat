#!/usr/bin/env bash
# 密讯 CipherChat 卸载脚本 v1.2.0（先自动备份，可随时反悔）
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/cipherchat}"

echo ""
read -r -p "将停止并删除 CipherChat 全部服务与数据（不可恢复），确认？输入 YES 继续: " A
[[ "${A}" == "YES" ]] || { echo "已取消"; exit 0; }

# 卸载前自动备份一份到 /opt（防止误删）
if [[ -d "${APP_DIR}/db" || -d "${APP_DIR}/data" ]]; then
  STAMP="$(date +%Y%m%d-%H%M%S)"
  if tar -czf "/opt/cipherchat-final-backup-${STAMP}.tar.gz" -C "${APP_DIR}" db data .env https-meta.json 2>/dev/null; then
    echo "[ OK ] 已自动备份到 /opt/cipherchat-final-backup-${STAMP}.tar.gz（确认不再需要后可删除）"
  fi
fi

systemctl disable --now cipherchat-web cipherchat-relay cipherchat-cert-renew.timer >/dev/null 2>&1 || true
rm -f /etc/systemd/system/cipherchat-web.service \
      /etc/systemd/system/cipherchat-relay.service \
      /etc/systemd/system/cipherchat-cert-renew.service \
      /etc/systemd/system/cipherchat-cert-renew.timer \
      /etc/systemd/system/caddy.service.d/cipherchat-https.conf
rmdir /etc/systemd/system/caddy.service.d 2>/dev/null || true
systemctl daemon-reload
rm -rf "${APP_DIR}"
userdel cipherchat >/dev/null 2>&1 || true

echo "[ OK ] 已卸载"
echo "       · 备份文件保留在 /opt/cipherchat-final-backup-*.tar.gz"
echo "       · Caddy 与 Bun 已保留；如需彻底清除："
echo "         apt remove --purge caddy && rm -rf /opt/bun /usr/local/bin/bun /var/lib/caddy"
echo "       · HTTPS 证书（Caddy 自动管理）已保留在 /var/lib/caddy"
