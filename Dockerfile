ARG SOURCE_REVISION=unknown

FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN chown node:node /app
USER node
COPY package.json package-lock.json ./
# Keep npm's download cache out of the layer shared by the builder and runner.
RUN --mount=type=cache,target=/home/node/.npm,uid=1000,gid=1000 npm ci --no-audit --no-fund

FROM dependencies AS builder
USER root
ARG SOURCE_REVISION=unknown
WORKDIR /app
ENV NEXT_PUBLIC_NYXDOC_BUILD_SHA=${SOURCE_REVISION}
COPY . .
RUN npm run build

FROM dependencies AS runner
USER root
RUN chown root:root /app \
    && apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*

ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NYXDOC_DB_PATH=/data/nyxdoc.db \
    NYXDOC_MEDIA_ROOT=/data/media \
    NYXDOC_BACKUP_ROOT=/data/backups \
    NYXDOC_SOURCE_REVISION=${SOURCE_REVISION}

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/package.json /app/tsconfig.json ./
COPY --from=builder --chown=node:node /app/LICENSE /app/NOTICE ./
COPY --from=builder --chown=node:node /app/LICENSING.md /app/SUPPORT.md /app/TRADEMARKS.md ./
COPY --from=builder --chown=node:node /app/scripts ./scripts
COPY --from=builder --chown=node:node /app/src ./src
COPY --from=builder --chown=root:root /app/scripts/container-entrypoint.sh /usr/local/bin/nyxdoc-entrypoint

USER root
RUN sed -i 's/\r$//' /usr/local/bin/nyxdoc-entrypoint \
    && chmod 0755 /usr/local/bin/nyxdoc-entrypoint \
    && mkdir -p /data/media /data/backups \
    && chown -R node:node /data

EXPOSE 3000
ENTRYPOINT ["nyxdoc-entrypoint"]
CMD ["npm", "run", "start:container"]
