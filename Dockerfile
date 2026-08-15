# A container for anywhere that takes one: Fly.io, Railway, a VPS, Cloud Run.
#
#   docker build -t arqueros .
#   docker run -p 3000:3000 \
#     -e ADMIN_PASSWORD='...' -e SESSION_SECRET='...' \
#     -e DB_PATH=/data/arquero.db \
#     -v arquero-data:/data \
#     arqueros

FROM node:22-slim

# better-sqlite3 compiles a native module, so the build stage needs a toolchain.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy manifests first so `npm ci` is cached until dependencies actually change.
COPY package*.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

# The database lives on a mounted volume, not in the image.
ENV DB_PATH=/data/arquero.db
ENV BACKUP_DIR=/data/backups
ENV NODE_ENV=production
ENV PORT=3000
RUN mkdir -p /data && chown -R node:node /data /app

# Don't run as root.
USER node

EXPOSE 3000

# Seed on first boot (safe to re-run — it updates rather than duplicates),
# then start. Node handles SIGTERM itself, so no init shim is needed.
CMD ["sh", "-c", "node server/seed.js && node server/index.js"]

HEALTHCHECK --interval=30s --timeout=4s --start-period=15s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
