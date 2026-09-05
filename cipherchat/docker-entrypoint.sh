#!/bin/sh
# CipherChat v1.7.1 容器入口：尽力初始化数据库 → 单命令同时拉起 relay 与 web（任一退出即整体退出）
# 注：v1.7.1 起 relay/web 进程内含数据库自举（缺表自动 prisma db push），
#     此处的 db push 仅作为提前失败的显式信号，失败不阻塞启动。
echo "[entrypoint] 初始化数据库 schema（尽力而为，失败由进程内自举兜底）..."
bunx --yes prisma@6 db push --skip-generate --accept-data-loss || echo "[entrypoint] db push 失败（离线环境属预期），交由进程内自举"

echo "[entrypoint] 启动 relay (:${WS_PORT}) + web (:${PORT}) ..."
exec bun scripts/start-all.ts
