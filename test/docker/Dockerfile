# Integration image for exercising packdev's stateful, environment-dependent
# behavior — the long-running `watch` process and real npm/git installs — in an
# isolated, disposable container.
FROM node:20-alpine

# git is needed for the git-URL dependency integration test.
RUN apk add --no-cache git

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
RUN chmod +x /usr/local/bin/watch-integration.sh /usr/local/bin/git-integration.sh

WORKDIR /work
# Default entrypoint; run.sh overrides it per test with --entrypoint.
ENTRYPOINT ["/usr/local/bin/watch-integration.sh"]
