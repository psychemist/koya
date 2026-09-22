# One image, two services. `web` and `worker` differ only in their start
# command, so building them from one Dockerfile keeps them on identical
# dependency trees and removes the class of bug where the worker resolves a
# different SDK version than the app it reports into.
FROM node:20-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# The Agent SDK ships its native binary through npm OPTIONAL dependencies.
# `--omit=optional` here leaves the worker with nothing to spawn, which fails
# at the first query() rather than at build time.
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --include=optional

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The build needs these present, not correct: Next evaluates route modules
# during prerendering, and config.ts throws on a missing key.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build \
    SESSION_SECRET=build-time-placeholder \
    npm run build

FROM base AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY package.json tsconfig.json next.config.ts postcss.config.mjs ./
COPY lib ./lib
COPY app ./app
COPY worker ./worker
COPY scripts ./scripts
COPY db ./db
# The agent's working directory. It holds .claude/skills and nothing else, so
# there is no secret under the path the agent may Read.
COPY agent-workspace ./agent-workspace

# Neither service runs as root. The worker spawns a subprocess, which is the
# one place this matters most.
USER node

EXPOSE 3000
CMD ["npm", "start"]
