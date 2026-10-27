# Mizar: one image, two roles.
#   docker run … mizar                      web app on :3000 (default command: serve; needs sign-in configured)
#   docker run … mizar collect --every 60   collector, a snapshot every hour
# Both read the same configuration (MIZAR_* env vars or /app/mizar.config.json) and must share the store.

FROM node:24-alpine AS build
WORKDIR /src
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm run build:cli

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    # Used with sign-in (auth.mode oidc) or MIZAR_AUTH_MODE=none; without sign-in `serve` binds 127.0.0.1.
    HOSTNAME=0.0.0.0

# Self-contained Next.js server with only the traced node_modules, plus its static assets.
COPY --from=build --chown=root:root /src/.next/standalone ./
COPY --from=build --chown=root:root /src/.next/static ./.next/static
COPY --from=build --chown=root:root /src/public ./public
# CLI bundled with its dependencies into one file.
COPY --from=build --chown=root:root /src/dist/cli ./cli
COPY --chown=root:root docker/entrypoint.sh /usr/local/bin/mizar

# The default file:// store (./data/snapshots) is the only writable path; mount a volume there to keep snapshots.
RUN chmod 755 /usr/local/bin/mizar && mkdir -p /app/data && chown node:node /app/data
USER node

EXPOSE 3000
ENTRYPOINT ["mizar"]
CMD ["serve"]

LABEL org.opencontainers.image.title="Mizar" \
      org.opencontainers.image.description="Sci-fi 2D/3D map of the AWS infrastructure across an AWS Organization" \
      org.opencontainers.image.licenses="Apache-2.0"
