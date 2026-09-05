#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi

#===============================================================================
# 密讯 CipherChat · 数据保留式升级脚本 v1.2.0
#
# 用法（在解压后的新版项目根目录内执行）：
#   sudo bash deploy/upgrade.sh
#
# 说明：
#   - 数据库 / 密文文件 / .env 配置 / 备份目录 全部保留，绝不丢失
#   - 同步新代码 → 依赖安装（增量）→ 数据库结构演进（无损）→ 生产构建 → 重启服务
#   - 若检测到尚未配置 HTTPS（v1.1.2 及更早版本安装的典型状态），自动引导进入
#     https.sh 完成证书配置（这正是旧版「Cannot read properties of undefined
#     (reading 'importKey')」报错的根因 —— 非 HTTPS 下浏览器禁用 WebCrypto）
#===============================================================================
set -euo pipefail
set -o errtrace

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[密讯升级]${NC} $1"; }
ok()    { echo -e "${GREEN}[ 成功 ]${NC} $1"; }
warn()  { echo -e "${YELLOW}[ 提示 ]${NC} $1"; }
die()   { echo -e "${RED}[ 错误 ]${NC} $1" >&2; exit 1; }

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${APP_DIR:-/opt/cipherchat}"
RUN_USER="${RUN_USER:-cipherchat}"
APP_HOME="${APP_HOME:-/var/lib/${RUN_USER}}"
LOG_FILE="${LOG_FILE:-/var/log/cipherchat-upgrade.log}"

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}      密讯 CipherChat · 数据保留式升级器 v1.2.0${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo ""

[[ $EUID -eq 0 ]] || die "请用 root 运行：sudo bash deploy/upgrade.sh"
[[ -f "${SRC_DIR}/package.json" ]] || die "未找到 ${SRC_DIR}/package.json —— 请在新版解压目录内执行"
[[ -d "${APP_DIR}" ]] || die "未检测到已安装的 ${APP_DIR}，请改用 sudo bash deploy/setup.sh 全新安装"

mkdir -p "$(dirname "${LOG_FILE}")" 2>/dev/null || true
exec > >(tee -a "${LOG_FILE}") 2>&1
trap 'code=$?; echo ""; echo -e "${RED}[ 错误 ]${NC} 升级在第 ${LINENO} 行中止（退出码 ${code}）" >&2; echo -e "${RED}[ 错误 ]${NC} 完整日志：${LOG_FILE}" >&2; exit "${code}"' ERR

info "源码目录 : ${SRC_DIR}"
info "安装目录 : ${APP_DIR}"
info "升级日志 : ${LOG_FILE}"
info "保留数据 : 数据库 / 密文文件 / .env / 备份 —— 全部不动"
echo ""

# 0) 升级前自动备份（保险）
info "【0/5】升级前自动备份…"
BACKUP_STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "${APP_DIR}/backups"
if tar -czf "${APP_DIR}/backups/pre-upgrade-${BACKUP_STAMP}.tar.gz" -C "${APP_DIR}" db data .env 2>/dev/null; then
  ok "已备份到 ${APP_DIR}/backups/pre-upgrade-${BACKUP_STAMP}.tar.gz"
else
  warn "备份部分内容缺失（可能为空目录），继续升级"
fi

# 1) 同步新代码（绝不触碰数据与配置）
info "【1/5】同步新代码…"
rsync -a \
  --exclude 'node_modules/' --exclude '.next/' \
  --exclude 'db/' --exclude 'data/' --exclude 'logs/' --exclude 'backups/' \
  --exclude '.env' --exclude '.env.*' --exclude 'https-meta.json' --exclude 'https-pending.json' \
  --exclude 'dev.log' --exclude 'server.log' --exclude 'nohup.out' \
  --exclude '.zscripts/' --exclude '.git/' --exclude 'download/' \
  --exclude 'skills/' --exclude 'examples/' --exclude 'tests/' --exclude 'agent-ctx/' \
  --exclude 'worklog.md' --exclude '*.tar.gz' --exclude 'upload/' \
  "${SRC_DIR}/" "${APP_DIR}/" || die "代码同步失败"
ok "代码已同步（数据与配置未动）"

# 2) 属主与依赖
info "【2/5】安装依赖（增量）…"
chown -R "${RUN_USER}:${RUN_USER}" "${APP_DIR}" || die "chown 失败"
BUN_BIN="$(command -v bun || echo /usr/local/bin/bun)"
[[ -x "${BUN_BIN}" ]] || die "未找到 bun，请先安装"
INSTALL_LOG="${APP_DIR}/logs/upgrade-install.log"
: > "${INSTALL_LOG}"; chown "${RUN_USER}" "${INSTALL_LOG}" 2>/dev/null || true
if ! runuser -u "${RUN_USER}" -- env "HOME=${APP_HOME}" "${BUN_BIN}" install --frozen-lockfile >>"${INSTALL_LOG}" 2>&1; then
  warn "锁定版本安装失败，回退常规安装"
  runuser -u "${RUN_USER}" -- env "HOME=${APP_HOME}" "${BUN_BIN}" install >>"${INSTALL_LOG}" 2>&1 \
    || { tail -n 30 "${INSTALL_LOG}"; die "依赖安装失败（国内网络：sudo env NPM_REGISTRY=https://registry.npmmirror.com bash deploy/upgrade.sh）"; }
fi
ok "依赖就绪"

export DATABASE_URL="file:${APP_DIR}/db/custom.db"
export DATA_DIR="${APP_DIR}/data"

# 3) 数据库结构演进（无损，保留全部数据）
info "【3/5】数据库结构演进（无损）…"
DB_LOG="${APP_DIR}/logs/upgrade-db.log"
: > "${DB_LOG}"; chown "${RUN_USER}" "${DB_LOG}" 2>/dev/null || true
runuser -u "${RUN_USER}" -- env "HOME=${APP_HOME}" "${BUN_BIN}" run db:push >>"${DB_LOG}" 2>&1 \
  || { tail -n 30 "${DB_LOG}"; die "数据库演进失败"; }
ok "数据库结构已更新（数据完整保留）"

# 4) 生产构建
info "【4/5】生产构建…"
BUILD_LOG="${APP_DIR}/logs/upgrade-build.log"
: > "${BUILD_LOG}"; chown "${RUN_USER}" "${BUILD_LOG}" 2>/dev/null || true
runuser -u "${RUN_USER}" -- env "HOME=${APP_HOME}" "NODE_ENV=production" "${BUN_BIN}" run build >>"${BUILD_LOG}" 2>&1 \
  || { tail -n 40 "${BUILD_LOG}"; die "构建失败"; }
[[ -f "${APP_DIR}/.next/standalone/server.js" ]] || die "构建产物缺失"
ok "构建完成"

# 5) 重启服务
info "【5/5】重启服务…"
systemctl restart cipherchat-web.service cipherchat-relay.service || die "服务重启失败"
sleep 3
systemctl is-active --quiet cipherchat-web.service || { journalctl -u cipherchat-web -n 20 --no-pager || true; die "cipherchat-web 未运行"; }
systemctl is-active --quiet cipherchat-relay.service || { journalctl -u cipherchat-relay -n 20 --no-pager || true; die "cipherchat-relay 未运行"; }
ok "服务已重启并运行"

# HTTPS 检测：旧版本（≤1.1.2）未配置证书 → 自动引导
if [[ ! -f "${APP_DIR}/https-meta.json" ]]; then
  echo ""
  warn "检测到尚未配置 HTTPS（v1.1.2 及更早版本的典型状态）"
  warn "没有 HTTPS 时浏览器会禁用加密 API，导致「无法进入频道 / importKey 报错」且通信可被窃听"
  read -r -p "是否现在运行证书配置向导？[Y/n]: " ANS
  if [[ ! "${ANS}" =~ ^[Nn] ]]; then
    bash "${SRC_DIR}/deploy/https.sh" || warn "HTTPS 配置未完成，可稍后运行：sudo bash ${APP_DIR}/deploy/https.sh"
  else
    warn "已跳过。稍后请务必运行：sudo bash ${APP_DIR}/deploy/https.sh"
  fi
fi

# TURN 检测：v1.3.0 及更早版本未配置 coturn → 提示安装
echo ""
if [[ -f /etc/turnserver.conf ]] && (systemctl is-active --quiet coturn 2>/dev/null || systemctl is-active --quiet turnserver 2>/dev/null); then
  ok "coturn 已运行"
else
  warn "检测到尚未安装 coturn TURN 中继"
  warn "未配置 TURN 时：跨运营商 / CGNAT / 对称 NAT 用户的语音通话大概率失败，且失败时无任何提示"
  if [[ -t 0 ]]; then
    read -r -p "是否现在一键安装 coturn？[Y/n]: " ANS_TURN
    if [[ ! "${ANS_TURN}" =~ ^[Nn] ]]; then
      bash "${SRC_DIR}/deploy/turn-install.sh" || warn "coturn 安装未完成，可稍后运行：sudo bash ${APP_DIR}/deploy/turn-install.sh"
    else
      warn "已跳过。可稍后运行：sudo bash ${APP_DIR}/deploy/turn-install.sh"
    fi
  else
    warn "非交互环境跳过。请稍后运行：sudo bash ${APP_DIR}/deploy/turn-install.sh"
  fi
fi

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
ok "升级完成！聊天记录、文件与网盘数据已全部保留"
echo ""
echo -e "  服务状态：systemctl status cipherchat-web cipherchat-relay"
echo -e "  升级日志：${LOG_FILE}"
[[ -f "${APP_DIR}/https-meta.json" ]] && echo -e "  HTTPS   ：已配置（$(grep -oP '"domain":\s*"\K[^"]+' "${APP_DIR}/https-meta.json" || echo '已启用')）"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo ""
