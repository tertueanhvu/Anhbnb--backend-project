# Standard syntax uses BuildKit's bundled frontend, without a separate registry pull.
ARG NODE_IMAGE=node:22.23.2-bookworm-slim
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS development
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node docker ./docker
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node seeds ./seeds
COPY --chown=node:node tests ./tests
COPY --chown=node:node postman ./postman
COPY --chown=node:node knexfile.js vitest.config.js ./
USER node
CMD ["node", "--watch", "src/server.js"]

FROM ${NODE_IMAGE} AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS production
WORKDIR /app
ENV NODE_ENV=production
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json knexfile.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node docker ./docker
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node seeds ./seeds
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
