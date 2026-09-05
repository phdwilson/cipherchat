#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi

#===============================================================================
# 密讯 CipherChat · TURN (coturn) 一键安装脚本 v1.0.0
#
# 用法（root）：
#   sudo bash deploy/turn-install.sh
#
# 功能：
#   ① apt install coturn
#   ② 生成 32 字节随机静态凭证与长期用户名
#   ③ 写入 /etc/turnserver.conf（含 use-auth-secret + listening-port=3478）
#   ④ 启用 systemd coturn 服务
#   ⑤ 把凭证写入数据库 AdminConfig 表（turnEnabled=true）
#   ⑥ 防火墙端口提示
#
# 设计：与项目自托管理念一致 —— 音频不经过任何第三方服务器。
#       coturn 监听 3478/UDP+TCP；relay 端口范围 49152-65535（默认）。
#===============================================================================
set -euo pipefail
set -o errtrace

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[密讯TURN]${NC} $1"; }
ok()    { echo -e "${GREEN}[ 成功 ]${NC} $1"; }
warn()  { echo -e "${YELLOW}[ 提示 ]${NC} $1"; }
die()   { echo -e "${RED}[ 错误 ]${NC} $1" >&2; exit 1; }

APP_DIR="${APP_DIR:-/opt/cipherchat}"
RUN_USER="${RUN_USER:-cipherchat}"
APP_HOME="${APP_HOME:-/var/lib/${RUN_USER}}"
LOG_FILE="${LOG_FILE:-/var/log/cipherchat-turn-install.log}"

# 公网 IP 探测（用作 TURN 监听的外部地址）
detect_ip() {
  local ip
  ip="$(curl -s4 --max-time 3 ifconfig.me 2>/dev/null || true)"
  [[ -z "${ip}" ]] && ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [[ -z "${ip}" ]] && ip="127.0.0.1"
  echo "${ip}"
}

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}   密讯 CipherChat · coturn TURN 一键安装器 v1.0.0${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo ""

[[ $EUID -eq 0 ]] || die "请用 root 运行：sudo bash deploy/turn-install.sh"
[[ -d "${APP_DIR}" ]] || die "未检测到已安装的 ${APP_DIR}，请先运行 deploy/setup.sh 安装主程序"

mkdir -p "$(dirname "${LOG_FILE}")" 2>/dev/null || true
exec > >(tee -a "${LOG_FILE}") 2>&1
trap 'code=$?; echo ""; echo -e "${RED}[ 错误 ]${NC} 安装在第 ${LINENO} 行中止（退出码 ${code}）" >&2; echo -e "${RED}[ 错误 ]${NC} 完整日志：${LOG_FILE}" >&2; exit "${code}"' ERR

info "应用目录 : ${APP_DIR}"
info "安装日志 : ${LOG_FILE}"
echo ""

# ---------------------------------------------------------------- 1/5 安装 coturn
if ! command -v turnserver >/dev/null 2>&1; then
  info "【1/5】安装 coturn..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq || die "apt update 失败"
  apt-get install -y -qq coturn >/dev/null 2>&1 || die "coturn 安装失败"
  ok "coturn 已安装"
else
  info "【1/5】coturn 已安装，跳过"
fi
TURN_BIN="$(command -v turnserver)"
TURN_VER="$("${TURN_BIN}" --version 2>&1 | head -1 || echo '?')"
ok "coturn ${TURN_VER}"

# ---------------------------------------------------------------- 2/5 生成凭证
info "【2/5】生成随机长期凭证..."
# 32 字节随机 hex 作为 HMAC 共享密钥（time-limited 模式用）
TURN_SECRET="$(head -c 32 /dev/urandom | xxd -p -c 64)"
# 16 字节随机 base64 作为长期用户名密码
TURN_PASS="$(head -c 16 /dev/urandom | base64 | tr -d '/+=' | head -c 22)"
TURN_USER="cipherchat-$(date +%s | tail -c 5)"
info "用户名 : ${TURN_USER}"
info "HMAC 密钥 : （隐藏，已写入 /etc/turnserver.conf 与数据库）"
info "长期凭证密码 : （隐藏，已写入 /etc/turnserver.conf 与数据库）"

# 外部 IP（TURN server 用于 external-ip 字段）
EXT_IP="$(detect_ip)"
info "外部 IP : ${EXT_IP}"

# ---------------------------------------------------------------- 3/5 写入 /etc/turnserver.conf
info "【3/5】写入 /etc/turnserver.conf..."
# 备份既有配置
if [[ -f /etc/turnserver.conf ]]; then
  cp /etc/turnserver.conf "/etc/turnserver.conf.bak.$(date +%Y%m%d%H%M%S)"
  warn "已备份既有 /etc/turnserver.conf"
fi

cat > /etc/turnserver.conf <<EOF
# ===== CipherChat TURN 配置（由 turn-install.sh 生成）=====
listening-port=3478
# TLS over TCP 监听端口（如不需要 TLS 可注释掉）
tls-listening-port=5349
# 监听所有接口（如需绑定特定 IP 改为具体 IP）
listening-ip=0.0.0.0
# 外部 IP（NAT 后必备：告诉客户端真实的公网地址）
external-ip=${EXT_IP}
# relay 端口范围
min-port=49152
max-port=65535
# ===== 鉴权配置 =====
# 长期凭证模式：user=<user>:<realm>:<password>
user=${TURN_USER}:cipherchat:${TURN_PASS}
realm=cipherchat
# 短期凭证模式：HMAC-SHA1 + 时间窗口
use-auth-secret
static-auth-secret=${TURN_SECRET}
# 关键安全设置
no-cli
no-tcp-relay
no-multicast-peers
# 禁止非 TLS 监听 5349 上额外走明文（5349 仅 TLS over TCP）
# 不允许 TLS 自签证书自动生成（推荐手动配置）
# cert=/etc/letsencrypt/live/${EXT_IP}/fullchain.pem
# pkey=/etc/letsencrypt/live/${EXT_IP}/privkey.pem
# 总连接数限制
total-quota=100
# 单 IP 连接限制（防滥用）
per-user-quota=10
# 日志
log-file=/var/log/turnserver.log
simple-log
EOF
chmod 600 /etc/turnserver.conf
ok "/etc/turnserver.conf 已写入"

# 让 systemd 启用 coturn（默认 Debian 包会写 /etc/default/coturn 控制）
if ! grep -q 'TURNSERVER_ENABLED=1' /etc/default/coturn 2>/dev/null; then
  echo 'TURNSERVER_ENABLED=1' >> /etc/default/coturn
fi
ok "systemd 启用标志已设置"

# ---------------------------------------------------------------- 4/5 启动 coturn 服务
info "【4/5】启动 coturn systemd 服务..."
systemctl daemon-reload || true
systemctl enable --now coturn >/dev/null 2>&1 || {
  # 某些系统包名为 turnserver.service
  systemctl enable --now turnserver >/dev/null 2>&1 || die "coturn 启动失败（请检查 journalctl -u coturn 或 -u turnserver）"
}
sleep 2
# 验证服务运行
if systemctl is-active --quiet coturn 2>/dev/null || systemctl is-active --quiet turnserver 2>/dev/null; then
  ok "coturn 已启动并设为开机自启"
else
  die "coturn 启动失败：请检查 journalctl -u coturn -n 30"
fi

# ---------------------------------------------------------------- 5/5 写入数据库 + 防火墙提示
info "【5/5】写入 TURN 配置到数据库 AdminConfig 表..."
BUN_BIN="$(command -v bun || echo /usr/local/bin/bun)"
[[ -x "${BUN_BIN}" ]] || die "未找到 bun"

# 构造 TURN URL 列表（按外部 IP）
TURN_URLS="turn:${EXT_IP}:3478?transport=udp
turn:${EXT_IP}:3478?transport=tcp
turns:${EXT_IP}:5349?transport=tcp"

# 通过 bun 直接执行数据库写入
DATABASE_URL="file:${APP_DIR}/db/custom.db" runuser -u "${RUN_USER}" -- env "HOME=${APP_HOME}" "${BUN_BIN}" -e "
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
(async () => {
  const cfg = await db.adminConfig.findFirst();
  if (!cfg) {
    console.error('[密讯TURN] 管理员配置未初始化 —— 请先在前端网盘页设置超级密钥');
    process.exit(2);
  }
  await db.adminConfig.updateMany({
    where: { id: cfg.id },
    data: {
      turnEnabled: true,
      turnUrls: process.env.TURN_URLS,
      turnUsername: '${TURN_USER}',
      turnCredential: '${TURN_PASS}',
      turnSecretMode: 'static',
    },
  });
  console.log('[密讯TURN] 数据库已更新：turnEnabled=true, mode=static');
})();
" TURN_URLS="${TURN_URLS}" 2>&1 | tee -a "${LOG_FILE}" || die "数据库写入失败（请检查日志）"

ok "TURN 配置已写入数据库"

# ---------------------------------------------------------------- 完成提示
echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
ok "coturn TURN 安装完成！"
echo ""
echo -e "  ${GREEN}服务状态${NC}"
echo "    systemctl status coturn"
echo "    systemctl restart coturn"
echo "    journalctl -u coturn -f          # 实时日志"
echo ""
echo -e "  ${YELLOW}防火墙端口${NC}（必须开放才能被外网访问）"
echo "    3478/UDP  + 3478/TCP   # TURN 主端口（必开）"
echo "    5349/UDP  + 5349/TCP   # TURN over TLS（可选）"
echo "    49152-65535/UDP        # relay 端口范围（必开）"
echo ""
echo -e "  ${GREEN}云安全组放行${NC}：在云厂商控制台（AWS / 阿里云 / 腾讯云）的"
echo "    安全组规则中放行上述端口；本地防火墙放行命令："
echo "    ufw allow 3478/tcp && ufw allow 3478/udp"
echo "    ufw allow 5349/tcp && ufw allow 5349/udp"
echo "    ufw allow 49152:65535/udp"
echo ""
echo -e "  ${GREEN}凭证已自动写入${NC}：管理员后台 → 语音中继 → 已启用 ✓"
echo "    （客户端下次拉取 /api/config 自动获取）"
echo ""
echo -e "  ${GREEN}外部 IP${NC}：${EXT_IP}（coturn 的 external-ip 已配置）"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo ""
