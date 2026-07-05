# FleetDeck — diskless Windows fleet manager for TrueNAS SCALE
# Multi-stage: builder has a compile toolchain so better-sqlite3 installs even
# when its prebuilt binary can't be downloaded; runtime stays slim.

FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public

# SQLite state lives on a mounted volume
ENV DB_PATH=/data/fleetdeck.sqlite \
    HTTP_PORT=8080 \
    BIND_ADDRESS=0.0.0.0
RUN mkdir -p /data && chown node:node /data /app
VOLUME /data

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
