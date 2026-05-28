# ---- 工作動態回報系統 Dockerfile ----
# 多階段構建：減少最終映像大小

# Stage 1: 安裝依賴
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Stage 2: 生產映像
FROM node:20-alpine
WORKDIR /app

# 安全性：使用非 root 使用者
RUN addgroup -g 1001 appgroup && \
    adduser -u 1001 -G appgroup -s /bin/sh -D appuser

# 複製依賴和原始碼
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY database.js ./
COPY public/ ./public/

# 建立本地資料庫目錄（若未使用 Turso 雲端）
RUN mkdir -p /app/data && chown -R appuser:appgroup /app/data

# 環境變數
ENV NODE_ENV=production
ENV PORT=3000

# 切換為非 root 使用者
USER appuser

EXPOSE 3000

# 健康檢查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

CMD ["node", "server.js"]
