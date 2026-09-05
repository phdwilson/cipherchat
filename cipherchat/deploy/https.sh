#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi

#===============================================================================
# 密讯 CipherChat · HTTPS 证书配置向导 v1.2.0
#
# 用法（root）：
#   sudo bash deploy/https.sh                 # 交互式向导
#   sudo bash deploy/https.sh --apply-pending # 应用后台提交的待应用配置（非交互）
#
# 证书模式：
#   [1] 自签名证书      —— 无需域名，立即可用；浏览器首次访问需手动信任
#   [2] 域名+Cloudflare —— Let's Encrypt + DNS-01 验证（需 CF API Token），
#                          全自动签发续期，完全不占用 80/443（推荐有域名者）
#   [3] 域名+临时80端口 —— Let's Encrypt + HTTP-01；签发时临时停掉占用 80 的
#                          服务（如 Reality），完成后自动恢复；自动安装每周
#                          续期检查定时器（仅在证书临期时才短暂停用占用服务）
#   [4] 自备证书        —— 已有证书文件（fullchain + key）直接绑定
#
# 设计原则：证书在应用程序部署/升级之前配置；网关全程仅 TLS 监听，
#           不提供任何明文 HTTP 入口；响应带 HSTS 头。
#===============================================================================
set -euo pipefail
set -o errtrace

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[密讯HTTPS]${NC} $1"; }
ok()    { echo -e "${GREEN}[ 成功 ]${NC} $1"; }
warn()  { echo -e "${YELLOW}[ 提示 ]${NC} $1"; }
die()   { echo -e "${RED}[ 错误 ]${NC} $1" >&2; exit 1; }

APP_DIR="${APP_DIR:-/opt/cipherchat}"
GATEWAY_PORT="${GATEWAY_PORT:-2053}"
CADDYFILE=/etc/caddy/Caddyfile
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[[ $EUID -eq 0 ]] || die "请用 root 运行：sudo bash deploy/https.sh"
command -v caddy >/dev/null 2>&1 || die "未安装 Caddy，请先运行 setup.sh 或安装 Caddy"
command -v openssl >/dev/null 2>&1 || die "缺少 openssl（apt install openssl）"
[[ -d "${APP_DIR}" ]] || warn "应用目录 ${APP_DIR} 尚不存在（首次安装流程中正常）"

# 待应用配置（后台提交）？
PENDING_FILE="${APP_DIR}/https-pending.json"
APPLY_PENDING=0
[[ "${1:-}" == "--apply-pending" ]] && APPLY_PENDING=1

detect_ip() {
  local ip
  ip="$(curl -s4 --max-time 3 ifconfig.me 2>/dev/null || true)"
  [[ -z "${ip}" ]] && ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [[ -z "${ip}" ]] && ip="127.0.0.1"
  echo "${ip}"
}

probe_tls() { # probe_tls <sni> → 输出证书信息（成功返回0）
  echo | openssl s_client -connect "127.0.0.1:${GATEWAY_PORT}" -servername "$1" 2>/dev/null | openssl x509 -noout -subject -enddate 2>/dev/null || return 1
}

write_caddyfile() { # write_caddyfile <site> <tls_directive...> <extra_global>
  local site="$1"; shift
  local tls_args="$1"; shift || true
  local global_block="$1"; shift || true

  cat > "${CADDYFILE}" <<EOF
# 密讯 CipherChat 网关 —— 由 deploy/https.sh 生成（仅 TLS，无明文入口）
${global_block}

${site} {
	# 强制安全响应头
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
		X-Frame-Options DENY
	}

	tls ${tls_args}

	# WebSocket 中继（XTransformPort 查询参数路由）
	@transform_port_query {
		query XTransformPort=*
	}
	handle @transform_port_query {
		reverse_proxy localhost:{query.XTransformPort} {
			header_up Host {host}
			header_up X-Forwarded-For {remote_host}
			header_up X-Forwarded-Proto {scheme}
			header_up X-Real-IP {remote_host}
		}
	}

	# Web 主应用
	handle {
		reverse_proxy localhost:13000 {
			header_up Host {host}
			header_up X-Forwarded-For {remote_host}
			header_up X-Forwarded-Proto {scheme}
			header_up X-Real-IP {remote_host}
		}
	}
}
EOF
}

write_meta() { # write_meta <domain> <mode>
  cat > "${APP_DIR}/https-meta.json" <<EOF
{
  "domain": "$1",
  "mode": "$2",
  "configuredAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "gatewayPort": ${GATEWAY_PORT}
}
EOF
  [[ -d "${APP_DIR}" ]] && chown "${RUN_USER:-cipherchat}:$(id -gn "${RUN_USER:-cipherchat}" 2>/dev/null || echo cipherchat)" "${APP_DIR}/https-meta.json" 2>/dev/null || true
}

wait_for_cert() { # wait_for_cert <sni> <seconds>；期间轮询 TLS 探测
  local sni="$1" secs="$2" i
  for ((i = 1; i <= secs; i++)); do
    if probe_tls "${sni}" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

install_renew_timer() { # install_renew_timer <unit_name>；每周检查，临期才执行停用-续期-恢复
  local unit="$1"
  cat > /etc/systemd/system/cipherchat-cert-renew.service <<'EOF'
[Unit]
Description=CipherChat cert renewal (stop port-80 holder briefly, renew, restore)

[Service]
Type=oneshot
Environment=APP_DIR=/opt/cipherchat
ExecStart=/bin/bash /opt/cipherchat/deploy/cert-renew.sh
EOF
  cat > /etc/systemd/system/cipherchat-cert-renew.timer <<'EOF'
[Unit]
Description=CipherChat weekly cert renewal check

[Timer]
OnCalendar=weekly
Persistent=true

[Install]
WantedBy=timers.target
EOF
  # 续期脚本（由 timer 触发；记录占用 80 的服务名）
  cat > "${APP_DIR}/deploy/cert-renew.sh" <<EOF
#!/usr/bin/env bash
# 每周定时器调用：仅当证书剩余 < 30 天时，短暂停用占用 80 端口的服务并重启 Caddy 完成续期
set -uo pipefail
PORT80_UNIT="\${PORT80_UNIT:-${unit}}"
META="/opt/cipherchat/https-meta.json"
DOMAIN="\$(grep -oP '"domain":\s*"\K[^"]+' "\$META" 2>/dev/null | head -1)"
LOG_TAG="[cipherchat-cert-renew]"
if [[ -z "\$DOMAIN" ]]; then echo "\$LOG_TAG 无域名配置，跳过"; exit 0; fi
NOTAFTER=\$(echo | openssl s_client -connect 127.0.0.1:${GATEWAY_PORT} -servername "\$DOMAIN" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | grep -oP 'notAfter=\K.*')
if [[ -z "\$NOTAFTER" ]]; then echo "\$LOG_TAG 探测失败，跳过"; exit 0; fi
DAYS=\$(python3 -c "import ssl,datetime,sys;print(int((datetime.datetime.strptime('''\$NOTAFTER''','%b %d %H:%M:%S %Y %Z')-datetime.datetime.utcnow()).days))" 2>/dev/null || echo 999)
if (( DAYS > 30 )); then echo "\$LOG_TAG 证书剩余 \${DAYS} 天，无需续期"; exit 0; fi
echo "\$LOG_TAG 证书剩余 \${DAYS} 天，开始续期（短暂停用 \${PORT80_UNIT}）"
systemctl stop "\${PORT80_UNIT}" 2>/dev/null || true
systemctl restart caddy
for i in \$(seq 1 45); do
  if echo | openssl s_client -connect 127.0.0.1:${GATEWAY_PORT} -servername "\$DOMAIN" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | grep -q notAfter; then
    NEWDAYS=\$(python3 -c "import ssl,datetime;import subprocess;d=subprocess.run(['openssl','s_client','-connect','127.0.0.1:${GATEWAY_PORT}','-servername','\$DOMAIN'],input=b'\\n',capture_output=True).stdout.decode();print(0)" 2>/dev/null || echo 0)
    break
  fi
  sleep 2
done
systemctl start "\${PORT80_UNIT}" 2>/dev/null || true
echo "\$LOG_TAG 续期流程完成，\${PORT80_UNIT} 已恢复"
EOF
  chmod +x "${APP_DIR}/deploy/cert-renew.sh"
  [[ -d "${APP_DIR}" ]] && chown -R "${RUN_USER:-cipherchat}" "${APP_DIR}/deploy/cert-renew.sh" 2>/dev/null || true
  systemctl daemon-reload
  systemctl enable --now cipherchat-cert-renew.timer >/dev/null 2>&1 || true
  ok "已安装每周续期检查定时器（cipherchat-cert-renew.timer）"
}

restart_caddy_and_wait() { # restart_caddy_and_wait <sni> <max_seconds>
  local sni="$1" secs="$2"
  systemctl restart caddy || { journalctl -u caddy -n 20 --no-pager || true; die "Caddy 重启失败（上方为日志末尾）"; }
  info "等待 TLS 证书生效（最长 ${secs} 秒）…"
  if wait_for_cert "${sni}" "$((secs / 2))"; then
    ok "HTTPS 已生效：$(probe_tls "${sni}" | tr '\n' ' ')"
    return 0
  fi
  warn "证书尚未就绪（DNS 传播或验证可能需要更长时间）"
  journalctl -u caddy -n 20 --no-pager || true
  return 1
}

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}   密讯 CipherChat · HTTPS 证书配置向导（仅 TLS，拒绝明文）${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo ""

DOMAIN="" MODE=""

if [[ ${APPLY_PENDING} -eq 1 ]]; then
  # —— 后台提交的待应用配置（非交互） ——
  [[ -f "${PENDING_FILE}" ]] || die "没有待应用的 HTTPS 配置（后台未提交）"
  DOMAIN="$(grep -oP '"domain":\s*"\K[^"]*' "${PENDING_FILE}" | head -1)"
  MODE="$(grep -oP '"mode":\s*"\K[^"]*' "${PENDING_FILE}" | head -1)"
  info "应用后台提交的配置：域名=${DOMAIN:-（自签）} 模式=${MODE}"
else
  # —— 交互式选择 ——
  CF_OK=0
  if caddy list-modules 2>/dev/null | grep -q 'dns.providers.cloudflare'; then CF_OK=1; fi

  echo "请选择证书模式："
  echo "  [1] 自签名证书        —— 无需域名立即可用；浏览器首次访问需手动信任一次"
  if [[ ${CF_OK} -eq 1 ]]; then
    echo "  [2] 域名+Cloudflare   —— Let's Encrypt + DNS-01（需 CF API Token）；全自动续期，不占用 80/443【推荐】"
  else
    echo "  [2] 域名+Cloudflare   —— 不可用（当前 Caddy 未内置 Cloudflare DNS 模块）"
  fi
  echo "  [3] 域名+临时80端口    —— Let's Encrypt + HTTP-01；签发时短暂停用占用 80 的服务后自动恢复"
  echo "  [4] 自备证书          —— 已有 fullchain.pem / privkey.pem 直接绑定"
  echo ""
  read -r -p "选择 [1-4，默认 1]: " CHOICE
  CHOICE="${CHOICE:-1}"
  case "${CHOICE}" in
    1) MODE="self-signed" ;;
    2) [[ ${CF_OK} -eq 1 ]] || die "当前 Caddy 不支持 Cloudflare DNS 验证，请选 1 / 3 / 4"; MODE="acme-dns" ;;
    3) MODE="acme-http01" ;;
    4) MODE="custom" ;;
    *) die "无效选择" ;;
  esac
fi

case "${MODE}" in
  # ———————————— 自签名 ———————————— 
  self-signed)
    if [[ ${APPLY_PENDING} -eq 0 ]]; then
      DEF_IP="$(detect_ip)"
      read -r -p "自签证书的主机名（直接回车使用 ${DEF_IP}）: " DOMAIN
      DOMAIN="${DOMAIN:-${DEF_IP}}"
    fi
    [[ -z "${DOMAIN}" ]] && DOMAIN="$(detect_ip)"
    info "配置自签名证书（${DOMAIN}:${GATEWAY_PORT}）…"
    write_caddyfile "${DOMAIN}:${GATEWAY_PORT}" "internal" ""
    systemctl restart caddy || die "Caddy 重启失败"
    if wait_for_cert "${DOMAIN}" 20; then
      write_meta "${DOMAIN}" "self-signed"
      ok "自签证书已生效（浏览器访问 https://${DOMAIN}:${GATEWAY_PORT}/ 首次会提示不安全，点击「高级→继续访问」即可，之后加密功能全部可用）"
    else
      die "自签证书未生效，请查看 journalctl -u caddy -n 30"
    fi
    ;;

  # ———————————— Cloudflare DNS-01 ———————————— 
  acme-dns)
    if [[ ${APPLY_PENDING} -eq 0 ]]; then
      read -r -p "域名（如 chat.example.com，A 记录需已指向本服务器）: " DOMAIN
      read -r -p "Cloudflare API Token（需 Zone.DNS 编辑权限，仅写入本机 systemd 配置）: " CF_TOKEN
      read -r -p "ACME 联系邮箱（Let's Encrypt 到期提醒，可留空）: " ACME_EMAIL
    else
      CF_TOKEN="${CF_API_TOKEN:-}"
      ACME_EMAIL="${ACME_EMAIL:-}"
    fi
    [[ -z "${DOMAIN}" ]] && die "未提供域名"
    [[ -z "${CF_TOKEN}" ]] && die "未提供 Cloudflare API Token（可设置环境变量 CF_API_TOKEN 后重试）"

    # Token 写入 caddy systemd override（不出现在 Caddyfile、不进日志）
    mkdir -p /etc/systemd/system/caddy.service.d
    cat > /etc/systemd/system/caddy.service.d/cipherchat-https.conf <<EOF
[Service]
Environment=CF_API_TOKEN=${CF_TOKEN}
EOF
    chmod 600 /etc/systemd/system/caddy.service.d/cipherchat-https.conf
    systemctl daemon-reload

    GLOBAL="{\n\temail ${ACME_EMAIL:-admin@${DOMAIN}}\n\tacme_dns cloudflare {env.CF_API_TOKEN}\n}"
    if [[ -z "${ACME_EMAIL}" ]]; then GLOBAL="{\n\tacme_dns cloudflare {env.CF_API_TOKEN}\n}"; fi
    write_caddyfile "${DOMAIN}:${GATEWAY_PORT}" "${ACME_EMAIL:-}" "${GLOBAL}"
    # tls 指令为空时移除空 tls 行
    sed -i '/^\ttls $/d' "${CADDYFILE}"
    caddy validate --config "${CADDYFILE}" --adapter caddyfile >/dev/null 2>&1 || { caddy validate --config "${CADDYFILE}" --adapter caddyfile || die "Caddyfile 校验失败"; }
    info "向 Let's Encrypt 申请证书（DNS-01，无需占用 80/443）…"
    if restart_caddy_and_wait "${DOMAIN}" 180; then
      write_meta "${DOMAIN}" "acme-dns"
      ok "证书已签发并生效：https://${DOMAIN}:${GATEWAY_PORT}/（自动续期已由 Caddy 接管）"
    else
      write_meta "${DOMAIN}" "acme-dns"
      warn "请检查域名 A 记录 / CF Token 权限后重跑本脚本；journalctl -u caddy -n 40 查看详情"
    fi
    ;;

  # ———————————— HTTP-01（临时占用 80） ———————————— 
  acme-http01)
    if [[ ${APPLY_PENDING} -eq 0 ]]; then
      read -r -p "域名（如 chat.example.com，A 记录需已指向本服务器）: " DOMAIN
      read -r -p "ACME 联系邮箱（可留空）: " ACME_EMAIL
      read -r -p "当前占用 80 端口的服务 systemd 单元名（如 xray/reality/v2ray，将短暂停用后自动恢复）: " PORT80_UNIT
    else
      PORT80_UNIT="${PORT80_UNIT:-}"
    fi
    [[ -z "${DOMAIN}" ]] && die "未提供域名"

    if [[ -n "${PORT80_UNIT}" ]]; then
      info "短暂停用 ${PORT80_UNIT} 以释放 80 端口供证书验证…"
      systemctl stop "${PORT80_UNIT}" || warn "停止 ${PORT80_UNIT} 失败（若其未占用 80 可忽略）"
    else
      warn "未提供占用 80 的服务名：请确保 80 端口当前空闲，否则验证将失败"
    fi

    GLOBAL=""
    [[ -n "${ACME_EMAIL}" ]] && GLOBAL="{\n\temail ${ACME_EMAIL}\n}"
    write_caddyfile "${DOMAIN}:${GATEWAY_PORT}" "${ACME_EMAIL:-}" "${GLOBAL}"
    sed -i '/^\ttls $/d' "${CADDYFILE}"
    caddy validate --config "${CADDYFILE}" --adapter caddyfile >/dev/null 2>&1 || die "Caddyfile 校验失败"

    info "向 Let's Encrypt 申请证书（HTTP-01）…"
    systemctl restart caddy || true
    CERT_OK=0
    if wait_for_cert "${DOMAIN}" 90; then CERT_OK=1; fi

    if [[ -n "${PORT80_UNIT}" ]]; then
      systemctl start "${PORT80_UNIT}" && ok "${PORT80_UNIT} 已恢复运行" || warn "${PORT80_UNIT} 恢复失败，请手动 systemctl start ${PORT80_UNIT}"
    fi

    if [[ ${CERT_OK} -eq 1 ]]; then
      write_meta "${DOMAIN}" "acme-http01"
      ok "证书已签发并生效：https://${DOMAIN}:${GATEWAY_PORT}/"
      if [[ -n "${PORT80_UNIT}" ]]; then
        install_renew_timer "${PORT80_UNIT}"
        warn "续期说明：每周定时器会检查证书，剩余不足 30 天时才会再次短暂停用 ${PORT80_UNIT} 完成续期"
      else
        warn "未提供 80 端口服务名：证书约 60 天到期，届时需手动重跑本脚本续期（或改用模式 2/1）"
      fi
    else
      write_meta "${DOMAIN}" "acme-http01"
      die "证书签发失败：请确认域名 A 记录已指向本服务器且 80 端口在验证期间可达（journalctl -u caddy -n 40）"
    fi
    ;;

  # ———————————— 自备证书 ———————————— 
  custom)
    if [[ ${APPLY_PENDING} -eq 0 ]]; then
      read -r -p "域名: " DOMAIN
      read -r -p "fullchain.pem 路径: " CERT_PATH
      read -r -p "privkey.pem 路径: " KEY_PATH
    else
      CERT_PATH="${CUSTOM_CERT_PATH:-}"; KEY_PATH="${CUSTOM_KEY_PATH:-}"
    fi
    [[ -f "${CERT_PATH}" ]] || die "证书文件不存在：${CERT_PATH}"
    [[ -f "${KEY_PATH}" ]] || die "私钥文件不存在：${KEY_PATH}"
    openssl x509 -noout -in "${CERT_PATH}" 2>/dev/null || die "证书文件无法解析（openssl）"
    info "绑定自备证书（${DOMAIN:-默认}）…"
    write_caddyfile "${DOMAIN}:${GATEWAY_PORT}" "${CERT_PATH} ${KEY_PATH}" ""
    if restart_caddy_and_wait "${DOMAIN:-127.0.0.1}" 30; then
      write_meta "${DOMAIN}" "custom"
      ok "自备证书已生效；到期前请自行更换并重跑本脚本"
    fi
    ;;

  *) die "未知模式：${MODE}" ;;
esac

# 应用待应用配置后清理
[[ ${APPLY_PENDING} -eq 1 ]] && rm -f "${PENDING_FILE}"

# 附加：GATEWAY_PORT 写入应用 .env（供后台实时探测使用）
if [[ -f "${APP_DIR}/.env" ]]; then
  grep -q '^GATEWAY_PORT=' "${APP_DIR}/.env" && sed -i "s/^GATEWAY_PORT=.*/GATEWAY_PORT=${GATEWAY_PORT}/" "${APP_DIR}/.env" || echo "GATEWAY_PORT=${GATEWAY_PORT}" >> "${APP_DIR}/.env"
fi

echo ""
ok "HTTPS 配置完成 —— 网关现以 仅TLS 模式运行，拒绝一切明文请求"
echo -e "  访问地址：https://${DOMAIN:-<你的域名或IP>}:${GATEWAY_PORT}/"
echo -e "  记得在云安全组放行 TCP ${GATEWAY_PORT}"
echo ""
