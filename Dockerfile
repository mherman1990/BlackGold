# Black Gold runtime image. One image, role chosen by command (core or gateway).
# Built only in CI for linux/amd64 and linux/arm64. Never built on the Pi. Never tagged latest.

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY packages/core/package.json packages/core/tsconfig.json packages/core/
COPY packages/broker-gateway/package.json packages/broker-gateway/tsconfig.json packages/broker-gateway/
RUN npm ci --ignore-scripts
COPY packages/shared/src packages/shared/src
COPY packages/core/src packages/core/src
COPY packages/broker-gateway/src packages/broker-gateway/src
RUN npx tsc -b && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production TZ=UTC
WORKDIR /app
RUN groupadd -g 1000 blackgold 2>/dev/null || true \
 && useradd -u 1000 -g 1000 -m -s /usr/sbin/nologin blackgold 2>/dev/null || true \
 && mkdir -p /data && chown 1000:1000 /data
COPY --from=build --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/package.json ./package.json
COPY --from=build --chown=1000:1000 /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=1000:1000 /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=1000:1000 /app/packages/core/package.json ./packages/core/package.json
COPY --from=build --chown=1000:1000 /app/packages/core/dist ./packages/core/dist
COPY --from=build --chown=1000:1000 /app/packages/broker-gateway/package.json ./packages/broker-gateway/package.json
COPY --from=build --chown=1000:1000 /app/packages/broker-gateway/dist ./packages/broker-gateway/dist
COPY --chown=1000:1000 config/examples ./config/examples
USER 1000:1000
VOLUME ["/data"]
ENV BLACKGOLD_DATA_DIR=/data
# No default command: the compose file selects the role explicitly. An image started bare prints help and exits 2.
ENTRYPOINT ["node"]
CMD ["packages/core/dist/main.js", "help"]
