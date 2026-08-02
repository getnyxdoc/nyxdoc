ARG SOURCE_REVISION=unknown

FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS builder
ARG SOURCE_REVISION=unknown
WORKDIR /app
ENV NEXT_PUBLIC_NYXDOC_BUILD_SHA=${SOURCE_REVISION}
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runner
ARG SOURCE_REVISION=unknown
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NYXDOC_DB_PATH=/data/nyxdoc.db \
    NYXDOC_MEDIA_ROOT=/data/media \
    NYXDOC_BACKUP_ROOT=/data/backups \
    NYXDOC_SOURCE_REVISION=${SOURCE_REVISION}

RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
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
