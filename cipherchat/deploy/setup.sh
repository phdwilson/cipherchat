#!/usr/bin/env bash
# 若被 sh/dash 执行则自动切换到 bash（本脚本使用了 bash 专属语法）
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi

#===============================================================================
# 密讯 CipherChat · Debian 12 一键安装脚本 v1.0.1
#
# 用法（在解压后的项目根目录内执行）：
#   sudo bash deploy/setup.sh
#   # 国内网络慢可走镜像源：
#   sudo env NPM_REGISTRY=https://registry.npmmirror.com bash deploy/setup.sh
#
# 可选环境变量（一般无需设置）：
#   APP_DIR=/opt/cipherchat     安装目录
#   GATEWAY_PORT=2053           对外网关端口（80/443 留给 Reality，本系统不占用）
#   WEB_PORT=13000              Web 内部端口（仅本机回环）
#   WS_PORT=13003               WebSocket 中继端口（仅本机回环）
#   NPM_REGISTRY=<url>          依赖安装镜像源
#   REGISTER_SERVICES=0         跳过 systemd/Caddy 注册（排障模式）
#   INSTALL_CADDY=0             不安装/配置 Caddy 网关
#   LOG_FILE=<path>             安装日志位置（默认 /var/log/cipherchat-setup.log）
#
# v1.0.1 修复：
#   ① 目录属主先修正（chown）再以低权限用户执行 install/构建，杜绝 EACCES
#   ② rsync 不再使用 --delete，且显式排除 db/data/logs/.env —— 重复执行绝不误删数据
#   ③ 任何一步失败都会打印出错行号与日志路径，不再无声退出
#   ④ 依赖安装/建库/构建全程落日志，失败时自动展示输出末尾
#   ⑤ 健康检查改为最长 30 秒重试；Caddy 依赖补齐 gnupg；已配置 .env 不被覆盖
#===============================================================================
set -euo pipefail
set -o errtrace

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[密讯]${NC} $1"; }
ok()    { echo -e "${GREEN}[ 成功 ]${NC} $1"; }
warn()  { echo -e "${YELLOW}[ 提示 ]${NC} $1"; }
die()   { echo -e "${RED}[ 错误 ]${NC} $1" >&2; exit 1; }

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${APP_DIR:-/opt/cipherchat}"
RUN_USER="${RUN_USER:-cipherchat}"
APP_HOME="${APP_HOME:-/var/lib/${RUN_USER}}"
GATEWAY_PORT="${GATEWAY_PORT:-2053}"
WEB_PORT="${WEB_PORT:-13000}"
WS_PORT="${WS_PORT:-13003}"
REGISTER_SERVICES="${REGISTER_SERVICES:-1}"
INSTALL_CADDY="${INSTALL_CADDY:-1}"
LOG_FILE="${LOG_FILE:-/var/log/cipherchat-setup.log}"

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}   密讯 CipherChat · 端到端加密中继 · Debian 12 安装器 v1.0.1${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo ""

[[ $EUID -eq 0 ]] || die "请用 root 运行：sudo bash deploy/setup.sh"
[[ -f "${SRC_DIR}/package.json" ]] || die "未找到 ${SRC_DIR}/package.json —— 请在解压后的项目根目录内执行本脚本"

# 全部输出同时写入日志文件，便于事后排障
mkdir -p "$(dirname "${LOG_FILE}")" 2>/dev/null || true
exec > >(tee -a "${LOG_FILE}") 2>&1

# 兜底：任何未显式处理的失败，都打印出错位置与日志路径后再退出（绝不无声退出）
trap 'code=$?; echo ""; echo -e "${RED}[ 错误 ]${NC} 安装脚本在第 ${LINENO} 行意外中止（退出码 ${code}）" >&2; echo -e "${RED}[ 错误 ]${NC} 完整日志：${LOG_FILE} —— 可将末尾 50 行提供给维护者排查" >&2; exit "${code}"' ERR

info "源码目录 : ${SRC_DIR}"
info "安装目录 : ${APP_DIR}"
info "端口规划 : 网关=:${GATEWAY_PORT}（对外） · Web=:${WEB_PORT} · 中继=:${WS_PORT}（仅本机）"
info "安装日志 : ${LOG_FILE}"
echo ""

# ---------------------------------------------------------------- 1/9 内存检查
MEM_MB=$(LC_ALL=C free -m | awk '/^Mem:/{print $2}')
SWAP_MB=$(LC_ALL=C free -m | awk '/^Swap:/{print $2}')
info "【1/9】环境检查（内存 ${MEM_MB}MB / Swap ${SWAP_MB}MB）..."

if (( MEM_MB < 1400 )) && (( SWAP_MB < 1024 )); then
  warn "内存不足 1.4GB 且 Swap 不足 1GB，构建阶段可能内存溢出"
  ANS=""
  if [[ -t 0 ]]; then
    read -r -p "是否自动创建 2GB swap 文件？[Y/n] " ANS || ANS=""
  fi
  if [[ ! "${ANS}" =~ ^[Nn] ]]; then
    if [[ ! -f /swapfile ]]; then
      fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
      chmod 600 /swapfile
      mkswap /swapfile >/dev/null
      swapon /swapfile
      grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
      ok "已创建并启用 2GB swap"
    else
      swapon /swapfile 2>/dev/null || true
      grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
      ok "已启用既有 swap 文件"
    fi
  fi
fi

# ---------------------------------------------------------------- 2/9 基础依赖
NEED_PKGS=()
for c in curl rsync tar unzip; do
  command -v "$c" >/dev/null 2>&1 || NEED_PKGS+=("$c")
done
if (( ${#NEED_PKGS[@]} > 0 )); then
  info "【2/9】安装基础依赖：${NEED_PKGS[*]}"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq || die "apt update 失败（请检查网络与软件源）"
  apt-get install -y -qq "${NEED_PKGS[@]}" || die "基础依赖安装失败"
else
  info "【2/9】基础依赖已就绪，跳过"
fi

# ---------------------------------------------------------------- 3/9 Bun 运行时
if ! command -v bun >/dev/null 2>&1; then
  info "【3/9】安装 Bun 运行时..."
  export BUN_INSTALL="/opt/bun"
  mkdir -p /opt/bun
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 \
    || die "Bun 安装失败（网络问题。可先参照 https://bun.sh/docs/installation 手动安装后重跑本脚本）"
  [[ -x /opt/bun/bin/bun ]] || die "Bun 安装异常：未找到 /opt/bun/bin/bun"
  ln -sf /opt/bun/bin/bun /usr/local/bin/bun
else
  info "【3/9】Bun 已安装，跳过"
fi
BUN_BIN="$(command -v bun)"
# 若 bun 位于用户家目录下，低权限服务用户将无法访问 —— 统一软链到 /usr/local/bin
case "${BUN_BIN}" in
  /home/*|/root/*)
    ln -sf "${BUN_BIN}" /usr/local/bin/bun
    BUN_BIN=/usr/local/bin/bun
    ;;
esac
BUN_VER="$("${BUN_BIN}" --version 2>/dev/null || echo '?')"
ok "Bun ${BUN_VER} 就绪（${BUN_BIN}）"

# ---------------------------------------------------------------- 4/9 运行用户
if ! id -u "${RUN_USER}" >/dev/null 2>&1; then
  info "【4/9】创建低权限运行用户 ${RUN_USER}..."
  useradd --system --home-dir "${APP_HOME}" --create-home --shell /usr/sbin/nologin "${RUN_USER}" \
    || die "创建运行用户失败"
else
  info "【4/9】运行用户 ${RUN_USER} 已存在"
fi
mkdir -p "${APP_HOME}"
chown "${RUN_USER}:${RUN_USER}" "${APP_HOME}" || die "设置 ${APP_HOME} 属主失败"

# ---------------------------------------------------------------- 5/9 部署代码
info "【5/9】部署代码到 ${APP_DIR} ..."
mkdir -p "${APP_DIR}"
# 重要：不使用 --delete，并显式排除数据目录与配置 —— 重复执行绝不误删数据库/已上传文件/.env
rsync -a \
  --exclude 'node_modules/' --exclude '.next/' \
  --exclude 'db/' --exclude 'data/' --exclude 'logs/' \
  --exclude '.env' --exclude '.env.*' \
  --exclude 'dev.log' --exclude 'server.log' --exclude 'nohup.out' \
  --exclude '.zscripts/' --exclude '.git/' --exclude 'download/' \
  --exclude 'skills/' --exclude 'examples/' --exclude 'tests/' --exclude 'agent-ctx/' \
  --exclude 'worklog.md' --exclude '*.tar.gz' \
  "${SRC_DIR}/" "${APP_DIR}/" || die "代码同步失败（rsync）"
ok "代码已就绪"

mkdir -p "${APP_DIR}/db" "${APP_DIR}/data" "${APP_DIR}/logs" || die "创建数据目录失败"

if [[ ! -f "${APP_DIR}/.env" ]]; then
  info "生成环境配置 .env ..."
  cat > "${APP_DIR}/.env" <<EOF
# ===== CipherChat 生产配置（由 setup.sh 生成）=====
DATABASE_URL=file:${APP_DIR}/db/custom.db
DATA_DIR=${APP_DIR}/data
WS_PORT=${WS_PORT}
GATEWAY_PORT=${GATEWAY_PORT}
# 单文件上限（字节）：聊天 1GB / 网盘 5GB
MAX_CHAT_FILE_BYTES=1073741824
MAX_DRIVE_FILE_BYTES=5368709120
# 每个网盘仓库默认配额 20GB
DRIVE_QUOTA_BYTES=21474836480
# 会话有效期 7 天（毫秒）
SESSION_TTL_MS=604800000
EOF
  ok ".env 已生成"
else
  warn "检测到已有 .env，保留现有配置（如需重置请先手动删除后重跑）"
fi

# ★ 关键修复：先修正整个目录属主，再以低权限用户执行后续所有构建操作
info "修正目录属主（后续 install/构建全部以 ${RUN_USER} 低权限用户执行）..."
chown -R "${RUN_USER}:${RUN_USER}" "${APP_DIR}" || die "chown ${APP_DIR} 失败"
chmod 700 "${APP_DIR}/db" "${APP_DIR}/data" || die "chmod 数据目录失败（目录不存在？）"
if [[ -f "${APP_DIR}/.env" ]]; then
  chmod 600 "${APP_DIR}/.env" || die "chmod .env 失败"
fi
ok "目录属主与权限就绪"

# ★ 健壮性修复：显式导出关键变量，屏蔽宿主 shell 可能残留的同名环境变量
#   （否则 prisma 会优先读取进程环境里的 DATABASE_URL，可能写错数据库位置）
export DATABASE_URL="file:${APP_DIR}/db/custom.db"
export DATA_DIR="${APP_DIR}/data"
export WS_PORT="${WS_PORT}"

cd "${APP_DIR}"

# 依赖安装/建库/构建统一以低权限用户执行的环境前缀
BUN_ENV=(env "HOME=${APP_HOME}")
if [[ -n "${NPM_REGISTRY:-}" ]]; then
  BUN_ENV+=("NPM_CONFIG_REGISTRY=${NPM_REGISTRY}")
fi

# ---------------------------------------------------------------- 6/9 HTTPS 证书（先于应用部署：保证全程无明文）
if [[ "${INSTALL_CADDY}" == "1" && "${REGISTER_SERVICES}" == "1" ]]; then
  if ! command -v caddy >/dev/null 2>&1; then
    info "【6/9】安装 Caddy 网关（官方软件源）..."
    export DEBIAN_FRONTEND=noninteractive
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null \
      || die "Caddy 前置依赖安装失败"
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
      || die "Caddy GPG 公钥获取失败（网络问题，稍后重试即可）"
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list \
      || die "Caddy 软件源写入失败"
    apt-get update -qq || die "apt update 失败（Caddy 源）"
    apt-get install -y -qq caddy || die "Caddy 安装失败"
  else
    info "【6/9】Caddy 已安装"
  fi

  # 证书优先：在构建/启动应用之前完成证书申请，网关全程仅 TLS，不存在任何明文阶段
  info "【6/9】配置 HTTPS 证书（先于应用部署，拒绝一切明文）..."
  if [[ -f /etc/caddy/Caddyfile ]] && ! grep -q "CipherChat" /etc/caddy/Caddyfile 2>/dev/null; then
    cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%Y%m%d%H%M%S)"
    warn "检测到既有 Caddyfile，已自动备份"
  fi
  # 若已配置过（https-meta.json 存在）则跳过向导，避免重复交互
  if [[ -f "${APP_DIR}/https-meta.json" ]]; then
    ok "已存在 HTTPS 配置，跳过向导（如需重配：sudo bash ${APP_DIR}/deploy/https.sh）"
    systemctl restart caddy || true
  else
    bash "${SRC_DIR}/deploy/https.sh" || die "HTTPS 配置失败 —— 这是必需步骤（无 HTTPS 浏览器将禁用加密 API）"
  fi
elif [[ "${REGISTER_SERVICES}" != "1" ]]; then
  warn "【6/9】排障模式，跳过 HTTPS 配置"
else
  warn "【6/9】INSTALL_CADDY=0 —— 跳过 Caddy/HTTPS（请自行以 TLS 反代 ${WEB_PORT} 与 WebSocket）"
fi

# ---------------------------------------------------------------- 7/9 依赖 + 数据库
INSTALL_LOG="${APP_DIR}/logs/bun-install.log"
DB_LOG="${APP_DIR}/logs/db-push.log"
: > "${INSTALL_LOG}"; : > "${DB_LOG}"
chown "${RUN_USER}:${RUN_USER}" "${INSTALL_LOG}" "${DB_LOG}"

if [[ -n "${NPM_REGISTRY:-}" ]]; then
  info "【7/9】使用镜像源安装项目依赖：${NPM_REGISTRY}"
  if ! grep -q '^registry=' "${APP_DIR}/.npmrc" 2>/dev/null; then
    printf 'registry=%s\n' "${NPM_REGISTRY}" >> "${APP_DIR}/.npmrc"
  fi
  chown "${RUN_USER}:${RUN_USER}" "${APP_DIR}/.npmrc" 2>/dev/null || true
else
  info "【7/9】安装项目依赖（以 ${RUN_USER} 用户执行）..."
fi

if ! runuser -u "${RUN_USER}" -- "${BUN_ENV[@]}" "${BUN_BIN}" install --frozen-lockfile >>"${INSTALL_LOG}" 2>&1; then
  warn "按锁定版本安装失败，回退为常规安装（多为网络波动，详见 ${INSTALL_LOG}）"
  runuser -u "${RUN_USER}" -- "${BUN_ENV[@]}" "${BUN_BIN}" install >>"${INSTALL_LOG}" 2>&1 \
    || { echo "---- bun install 输出末尾 ----"; tail -n 30 "${INSTALL_LOG}"; \
         die "依赖安装失败（国内网络可执行：sudo env NPM_REGISTRY=https://registry.npmmirror.com bash deploy/setup.sh）"; }
fi
[[ -d "${APP_DIR}/node_modules" ]] || die "依赖安装异常：node_modules 不存在（详见 ${INSTALL_LOG}）"
ok "依赖安装完成"

info "初始化数据库结构（SQLite）..."
runuser -u "${RUN_USER}" -- env "HOME=${APP_HOME}" "${BUN_BIN}" run db:push >>"${DB_LOG}" 2>&1 \
  || { echo "---- prisma 输出末尾 ----"; tail -n 30 "${DB_LOG}"; die "数据库初始化失败"; }
[[ -s "${APP_DIR}/db/custom.db" ]] || die "数据库文件未生成：${APP_DIR}/db/custom.db（详见 ${DB_LOG}）"
ok "数据库就绪"

# ---------------------------------------------------------------- 7/9 生产构建
BUILD_LOG="${APP_DIR}/logs/build.log"
: > "${BUILD_LOG}"
chown "${RUN_USER}:${RUN_USER}" "${BUILD_LOG}"
info "【8/9】生产构建（约 1-3 分钟，日志：${BUILD_LOG}）..."
runuser -u "${RUN_USER}" -- env "HOME=${APP_HOME}" "NODE_ENV=production" "${BUN_BIN}" run build >>"${BUILD_LOG}" 2>&1 \
  || { echo "---- 构建输出末尾 ----"; tail -n 40 "${BUILD_LOG}"; \
       die "构建失败（常见原因：内存不足 —— 见步骤 1 的 swap 提示）"; }
[[ -f "${APP_DIR}/.next/standalone/server.js" ]] || die "构建产物缺失：.next/standalone/server.js"
if [[ -d "${APP_DIR}/.next/standalone/node_modules/.prisma" ]]; then
  ok "构建完成（含 Prisma 引擎）"
else
  warn "构建完成，但 standalone 缺少 .prisma 引擎目录 —— 如服务启动报数据库错误请反馈"
fi

# ---------------------------------------------------------------- 8/9 systemd 服务
if [[ "${REGISTER_SERVICES}" == "1" ]]; then
  info "【9/9】注册 systemd 服务..."
  sed -e "s#/opt/cipherchat#${APP_DIR}#g" \
      -e "s#/usr/local/bin/bun#${BUN_BIN}#g" \
      -e "s/^Environment=PORT=.*/Environment=PORT=${WEB_PORT}/" \
      "${APP_DIR}/deploy/cipherchat-web.service" > /etc/systemd/system/cipherchat-web.service \
      || die "生成 cipherchat-web.service 失败"
  sed -e "s#/opt/cipherchat#${APP_DIR}#g" \
      -e "s#/usr/local/bin/bun#${BUN_BIN}#g" \
      "${APP_DIR}/deploy/cipherchat-relay.service" > /etc/systemd/system/cipherchat-relay.service \
      || die "生成 cipherchat-relay.service 失败"

  systemctl daemon-reload || die "systemctl daemon-reload 失败"
  systemctl enable --now cipherchat-web.service cipherchat-relay.service \
    || die "服务启用失败（可执行 journalctl -u cipherchat-web -n 30 --no-pager 排查）"
  sleep 2
  systemctl is-active --quiet cipherchat-web.service \
    || { journalctl -u cipherchat-web -n 20 --no-pager || true; die "cipherchat-web 未运行（上方为日志末尾）"; }
  systemctl is-active --quiet cipherchat-relay.service \
    || { journalctl -u cipherchat-relay -n 20 --no-pager || true; die "cipherchat-relay 未运行（上方为日志末尾）"; }
  ok "cipherchat-web / cipherchat-relay 已启动，并设为开机自启"
else
  warn "【9/9】REGISTER_SERVICES=0 —— 排障模式，跳过 systemd 注册"
fi

# ---------------------------------------------------------------- 健康检查（带重试）
wait_http() {
  local url="$1" name="$2" tries="${3:-30}" i
  for ((i = 1; i <= tries; i = i + 1)); do
    if curl -sfk --max-time 2 "${url}" >/dev/null 2>&1; then
      ok "${name} 就绪"
      return 0
    fi
    sleep 1
  done
  return 1
}

echo ""
info "健康检查（服务冷启动最长等待 30 秒）..."
FAIL=0
if [[ "${REGISTER_SERVICES}" == "1" ]]; then
  wait_http "http://127.0.0.1:${WEB_PORT}/api/health" "Web 服务(:${WEB_PORT})" 30 \
    || { warn "Web 服务未响应"; journalctl -u cipherchat-web -n 20 --no-pager || true; FAIL=1; }
  wait_http "http://127.0.0.1:${WS_PORT}/?EIO=4&transport=polling" "WebSocket 中继(:${WS_PORT})" 20 \
    || { warn "中继服务未响应"; journalctl -u cipherchat-relay -n 20 --no-pager || true; FAIL=1; }
  if [[ "${INSTALL_CADDY}" == "1" ]]; then
    wait_http "https://127.0.0.1:${GATEWAY_PORT}/api/health" "HTTPS 网关(:${GATEWAY_PORT})" 20 \
      || { warn "网关未响应"; journalctl -u caddy -n 20 --no-pager || true; FAIL=1; }
  fi
else
  info "排障模式，跳过健康检查"
fi

# ---------------------------------------------------------------- coturn 语音中继一键安装提示
# 用户可选安装 coturn：未配置 TURN 时语音在 CGNAT/对称 NAT 下大概率失败
echo ""
info "语音中继检查..."
if [[ -f /etc/turnserver.conf ]] && systemctl is-active --quiet coturn 2>/dev/null; then
  ok "coturn 已运行"
elif [[ -f /etc/turnserver.conf ]] && systemctl is-active --quiet turnserver 2>/dev/null; then
  ok "turnserver 已运行"
else
  warn "未检测到 coturn —— 语音功能在 STUN-only 模式下，运营商 CGNAT/对称 NAT 用户大概率无法通话"
  warn "强烈建议安装 coturn（约 1 分钟），实现真正的端到端语音中继"
  if [[ -t 0 ]]; then
    read -r -p "是否现在一键安装 coturn？[Y/n] " ANS_TURN || ANS_TURN=""
    if [[ ! "${ANS_TURN}" =~ ^[Nn] ]]; then
      bash "${SRC_DIR}/deploy/turn-install.sh" || warn "coturn 安装未完成，可稍后运行：sudo bash ${APP_DIR}/deploy/turn-install.sh"
    else
      warn "已跳过。稍后可随时运行：sudo bash ${APP_DIR}/deploy/turn-install.sh"
    fi
  else
    warn "非交互环境跳过自动安装。请在终端执行：sudo bash ${APP_DIR}/deploy/turn-install.sh"
  fi
fi

IP="$(curl -s4 --max-time 3 ifconfig.me 2>/dev/null || true)"
if [[ -z "${IP}" ]]; then IP="$(hostname -I 2>/dev/null | awk '{print $1}')"; fi
if [[ -z "${IP}" ]]; then IP="你的服务器IP"; fi

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
if [[ ${FAIL} -eq 0 && "${REGISTER_SERVICES}" == "1" ]]; then
  ok "全部服务运行正常！"
elif [[ "${REGISTER_SERVICES}" != "1" ]]; then
  warn "排障模式完成（未注册服务）"
else
  warn "部分服务异常，请按下方命令排查后重试"
fi
echo ""
if [[ "${REGISTER_SERVICES}" == "1" ]]; then
  DOMAIN_SET=""
  [[ -f "${APP_DIR}/https-meta.json" ]] && DOMAIN_SET="$(grep -oP '"domain":\s*"\K[^"]+' "${APP_DIR}/https-meta.json" 2>/dev/null | head -1)"
  ACCESS_HOST="${DOMAIN_SET:-${IP}}"
  echo -e "  ${GREEN}访问地址${NC}  https://${ACCESS_HOST}:${GATEWAY_PORT}/"
  echo -e "             （记得在云安全组放行 TCP ${GATEWAY_PORT}）"
  if [[ -n "${DOMAIN_SET}" ]]; then
    echo -e "  ${GREEN}HTTPS    ${NC}  域名证书已配置（${DOMAIN_SET}）"
  else
    echo -e "  ${GREEN}HTTPS    ${NC}  自签名证书（浏览器首次访问需点击「高级→继续访问」）"
  fi
fi
echo -e "  ${GREEN}服务管理${NC}"
echo "    systemctl status  cipherchat-web cipherchat-relay caddy"
echo "    systemctl restart cipherchat-web cipherchat-relay"
echo "    journalctl -u cipherchat-web -f        # 实时日志（不含任何 token）"
echo ""
echo -e "  ${GREEN}数据与排障${NC}"
echo "    数据库      ${APP_DIR}/db/custom.db"
echo "    密文文件    ${APP_DIR}/data/"
echo "    备份命令    bash ${APP_DIR}/deploy/backup.sh"
echo "    安装日志    ${LOG_FILE}"
echo ""
echo -e "  ${YELLOW}语音中继${NC}：若未安装 coturn，跨网络通话大概率失败"
echo "    一键安装    sudo bash ${APP_DIR}/deploy/turn-install.sh"
echo "    管理后台    首页 → 管理员 → 语音中继"
echo ""
echo -e "  ${YELLOW}首次使用：打开网站 → 「隐私网盘」→ 新建仓库 → 立即抄写 ID 与密钥！${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo ""
