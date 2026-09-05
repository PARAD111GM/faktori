FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

ARG CODEX_VERSION=0.146.0

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --ignore-scripts "@openai/codex@${CODEX_VERSION}" \
    && codex --version

WORKDIR /workspace

CMD ["codex", "--version"]
