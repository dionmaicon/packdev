# Integration image for exercising packdev's stateful, environment-dependent
# behavior — the long-running `watch` process and real npm/git installs — in an
# isolated, disposable container.
FROM node:20-alpine

# git is needed for the git-URL dependency integration test; pnpm for the
# multi-package-manager integration test (yarn ships with the base image).
RUN apk add --no-cache git \
    && npm install -g pnpm@9

WORKDIR /packdev

# Install deps without running the "prepare" build (src isn't copied yet).
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts

# Build the CLI from source.
COPY src ./src
RUN npm run build

# Expose `packdev` on PATH without a global npm link.
RUN printf '#!/bin/sh\nexec node /packdev/dist/index.js "$@"\n' > /usr/local/bin/packdev \
    && chmod +x /usr/local/bin/packdev

COPY test/docker/watch-integration.sh /usr/local/bin/watch-integration.sh
COPY test/docker/git-integration.sh /usr/local/bin/git-integration.sh
COPY test/docker/pm-integration.sh /usr/local/bin/pm-integration.sh
COPY test/docker/finish-integration.sh /usr/local/bin/finish-integration.sh
COPY test/docker/storm-integration.sh /usr/local/bin/storm-integration.sh
RUN chmod +x /usr/local/bin/watch-integration.sh \
    /usr/local/bin/git-integration.sh \
    /usr/local/bin/pm-integration.sh \
    /usr/local/bin/finish-integration.sh \
    /usr/local/bin/storm-integration.sh

WORKDIR /work
# Default entrypoint; run.sh overrides it per test with --entrypoint.
ENTRYPOINT ["/usr/local/bin/watch-integration.sh"]
