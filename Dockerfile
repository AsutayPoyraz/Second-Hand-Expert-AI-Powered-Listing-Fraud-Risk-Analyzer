# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Root olmayan kullanıcı
RUN addgroup -S app && adduser -S app -G app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY backend ./backend
COPY frontend ./frontend

# Arayüzden girilen API anahtarı burada saklanır. Compose'da adlandırılmış
# volume bağlanır; read_only kök dosya sistemiyle de yazılabilir kalır.
RUN mkdir -p /app/data && chown -R app:app /app/data

USER app
VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "backend/server.js"]
