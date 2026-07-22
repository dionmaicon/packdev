# Integration image for exercising `packdev watch` — a long-running process
# that reacts to real filesystem events — in an isolated, disposable container.
FROM node:20-alpine

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
RUN chmod +x /usr/local/bin/watch-integration.sh

WORKDIR /work
ENTRYPOINT ["/usr/local/bin/watch-integration.sh"]
