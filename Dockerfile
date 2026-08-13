# syntax=docker/dockerfile:1

FROM node:24.19.0-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
ENV HUSKY=0
RUN --mount=type=cache,target=/root/.npm \
  npm ci \
  && (cd node_modules/nodejieba && ../.bin/node-pre-gyp rebuild)

COPY tsconfig.json ./
COPY src ./src
COPY assets ./assets
RUN npm run build \
  && npm prune --omit=dev

FROM node:24.19.0-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app/data \
  && chown node:node /app/data

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/assets ./assets

USER node

RUN node dist/scripts/container-smoke.js

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/app.js"]
