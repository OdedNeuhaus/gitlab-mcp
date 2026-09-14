# Second stage for the HolmesGPT-restricted GitLab MCP image.
#
# Build the upstream image from this (patched) checkout first, then layer the
# policy default and provenance labels on top:
#
#   docker build -t gitlab-mcp-holmes:base -f Dockerfile .
#   docker build -t <registry>/gitlab-mcp-holmes:<tag> -f holmes/Dockerfile \
#       --build-arg BASE_IMAGE=gitlab-mcp-holmes:base \
#       --build-arg UPSTREAM_COMMIT=$(git rev-parse HEAD) holmes/
#
# holmes/build-image.sh does all of this and prints the pushed digest.
# The upstream Dockerfile is left untouched so upstream merges stay trivial.
ARG BASE_IMAGE=gitlab-mcp-holmes:base
FROM ${BASE_IMAGE}

ARG UPSTREAM_COMMIT=unknown
ARG UPSTREAM_VERSION=unknown

# Policy on by default. Helm sets it again explicitly; the startup log line
# "holmes-write-policy: enabled" confirms the effective value.
ENV HOLMES_WRITE_POLICY=true

LABEL org.opencontainers.image.title="gitlab-mcp-holmes" \
      org.opencontainers.image.description="zereight/gitlab-mcp with the HolmesGPT holmes-* branch write policy" \
      org.opencontainers.image.revision="${UPSTREAM_COMMIT}" \
      org.opencontainers.image.version="${UPSTREAM_VERSION}" \
      io.holmesgpt.gitlab-mcp.write-policy="holmes-branch-prefix"
