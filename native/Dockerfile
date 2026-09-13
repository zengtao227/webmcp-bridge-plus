# syntax=docker/dockerfile:1
# Build with an immutable base, for example:
#   docker build --build-arg WEBMCP_NODE_IMAGE=node:22-bookworm-slim@sha256:<digest> ...
ARG WEBMCP_NODE_IMAGE
FROM ${WEBMCP_NODE_IMAGE}
ARG WEBMCP_SOURCE_SHA256
LABEL com.webmcp.native.source-sha256="${WEBMCP_SOURCE_SHA256}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    jq \
    openssh-client \
    python3 \
    python3-pip \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 65532 webmcp \
  && useradd --uid 65532 --gid 65532 --create-home --shell /bin/bash webmcp

WORKDIR /opt/webmcp
COPY package.json /opt/webmcp/package.json
COPY gateway/path-policy /opt/webmcp/gateway/path-policy
COPY native/src /opt/webmcp/native/src
COPY native/bin /opt/webmcp/native/bin

# The image is safe-by-default even when run without the trusted controller.
# Production may override this with the non-root host owner's UID:GID so Linux
# bind-mounted source files retain their ordinary owner permissions.
USER 65532:65532

CMD ["sleep", "infinity"]
