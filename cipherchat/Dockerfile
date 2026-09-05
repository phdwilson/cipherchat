# CipherChat v1.7.1 — 多阶段 Docker 构建
# 构建: docker build -t cipherchat .
# 运行: docker run -p 3000:3000 -p 3003:3003 -v cipherchat-data:/app/data cipherchat
#
# 容器内同时运行 Next.js standalone (web, :3000) 与 WebSocket 中继 (relay, :3003)。
# 数据（SQLite + 密文分块）挂载在 /app/data。

# ---------- 阶段 1：依赖 ----------
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile

# ---------- 阶段 2：构建 ----------
FROM oven/bun:1 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV DATABASE_URL="file:/tmp/build.db"
RUN bun run db:generate \
 && bun run build || (bunx next build && cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/ && cp -r node_modules/.prisma .next/standalone/node_modules/ 2>/dev/null; true)

# ---------- 阶段 3：运行时 ----------
FROM oven/bun:1-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    DATABASE_URL="file:/app/data/app.db" \
    DATA_DIR=/app/data \
    WS_PORT=3003 \
    PORT=3000

# 仅复制 standalone 产物 + prisma schema + relay 源码 + 启动脚本
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/prisma/schema.prisma ./prisma/schema.prisma
COPY --from=builder /app/mini-services/relay/index.ts ./mini-services/relay/index.ts
COPY --from=builder /app/src/lib/server ./src/lib/server
COPY --from=builder /app/src/lib/db.ts ./src/lib/db.ts
RUN mkdir -p /app/data /app/prisma

COPY scripts/start-all.ts ./scripts/start-all.ts
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000 3003
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD curl -sf http://127.0.0.1:3003/healthz >/dev/null || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
