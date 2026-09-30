
FROM node:26-bookworm-slim AS build
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Corepack is no longer bundled with Node.js 25+.
RUN npm install --global corepack@0.35.0 && corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# pnpm-workspace.yaml keeps the store inside the project for local work; in Docker the store
# lives in a BuildKit cache mount so rebuilds (even with --no-cache) reuse downloaded packages.
# The lockfile is checked against the supply-chain policy of pnpm-workspace.yaml
# (minimumReleaseAge) on developer machines and in CI; the image installs exactly that lockfile
# with integrity hashes, so the re-check (hundreds of registry metadata requests) is skipped here.
RUN --mount=type=cache,id=olympus-pnpm-store,target=/pnpm-store \
    corepack pnpm install --frozen-lockfile --store-dir /pnpm-store --config.trust-lockfile=true
COPY . .
RUN corepack pnpm build
RUN --mount=type=cache,id=olympus-pnpm-store,target=/pnpm-store \
    corepack pnpm prune --prod --config.store-dir=/pnpm-store --config.trust-lockfile=true

FROM node:26-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/lib/seed.json ./lib/seed.json
# Shared content validation, used by scripts/sync-content.mjs inside the container.
COPY --from=build /app/lib/content ./lib/content
# MAX chat-bot (same image, started with `node bot/server.mjs`); includes the
# «Russian Trusted Root CA» used via NODE_EXTRA_CA_CERTS for platform-api2.max.ru.
COPY --from=build /app/bot ./bot
# Shared plain-ESM rules the bot imports at runtime.
COPY --from=build /app/lib/domain/achievements.mjs ./lib/domain/achievements.mjs
EXPOSE 3000
CMD ["node", "scripts/docker-start.mjs"]
