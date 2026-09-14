#!/usr/bin/env bash
# Build (and optionally push) the pinned HolmesGPT-restricted GitLab MCP image.
#
# Usage:
#   holmes/build-image.sh                       # build only
#   PUSH=true IMAGE=registry.example.com/platform/gitlab-mcp-holmes TAG=2.1.61-holmes.1 holmes/build-image.sh
#
# Environment:
#   IMAGE      image repository (default: gitlab-mcp-holmes)
#   TAG        image tag (default: <upstream version>-holmes.<short sha>)
#   PUSH       "true" to push and print the digest
#   SKIP_TESTS "true" to skip the policy test suites (not recommended)
set -euo pipefail

cd "$(dirname "$0")/.."

# Upstream base this customization was written and tested against.
# Update these two lines (and re-run the tests) when rebasing on a newer upstream.
PINNED_UPSTREAM_TAG="v2.1.61"
PINNED_UPSTREAM_COMMIT="0d242f54e420c27fbb2106ab375a874099319671"

HEAD_COMMIT="$(git rev-parse HEAD)"
UPSTREAM_VERSION="$(node -p "require('./package.json').version")"
IMAGE="${IMAGE:-gitlab-mcp-holmes}"
TAG="${TAG:-${UPSTREAM_VERSION}-holmes.$(git rev-parse --short HEAD)}"

echo "==> HEAD ${HEAD_COMMIT} (package version ${UPSTREAM_VERSION}; pinned upstream ${PINNED_UPSTREAM_TAG} / ${PINNED_UPSTREAM_COMMIT:0:12})"
if ! git merge-base --is-ancestor "${PINNED_UPSTREAM_COMMIT}" HEAD 2>/dev/null; then
  echo "!!  HEAD does not contain the pinned upstream commit. Re-validate the customization before building." >&2
  echo "    (update PINNED_UPSTREAM_* in this script after re-running the policy tests)" >&2
  exit 1
fi

# Sanity check: all enforcement call sites are present in index.ts.
CALL_SITES="$(grep -c 'holmes-write-policy' index.ts || true)"
if [ "${CALL_SITES}" -lt 9 ]; then
  echo "!!  Expected >= 9 'holmes-write-policy' call sites in index.ts, found ${CALL_SITES}. Patch is incomplete." >&2
  exit 1
fi

if [ "${SKIP_TESTS:-false}" != "true" ]; then
  echo "==> Running policy test suites"
  npm run build
  node --import tsx/esm --test --experimental-test-isolation=none test/holmes-write-policy.test.ts
  node --import tsx/esm --test --experimental-test-isolation=none --test-concurrency=1 test/test-holmes-write-policy.ts
fi

echo "==> Building upstream image from this checkout"
docker build -t "${IMAGE}:base" -f Dockerfile .

echo "==> Building ${IMAGE}:${TAG}"
docker build -t "${IMAGE}:${TAG}" -f holmes/Dockerfile \
  --build-arg "BASE_IMAGE=${IMAGE}:base" \
  --build-arg "UPSTREAM_COMMIT=${HEAD_COMMIT}" \
  --build-arg "UPSTREAM_VERSION=${UPSTREAM_VERSION}" \
  holmes/

echo "==> Smoke check: policy must be reported as enabled at startup"
docker run --rm \
  -e GITLAB_PERSONAL_ACCESS_TOKEN=glpat-smoke -e GITLAB_API_URL=http://127.0.0.1:9/api/v4 \
  -e GITLAB_DISABLE_VERSION_CHECK=true \
  "${IMAGE}:${TAG}" </dev/null 2>&1 | grep -q "holmes-write-policy: enabled" \
  && echo "    ok" || { echo "!!  startup log did not report the policy as enabled" >&2; exit 1; }

if [ "${PUSH:-false}" = "true" ]; then
  echo "==> Pushing ${IMAGE}:${TAG}"
  docker push "${IMAGE}:${TAG}"
  DIGEST="$(docker inspect --format='{{index .RepoDigests 0}}' "${IMAGE}:${TAG}")"
  echo "==> Pin this digest in Helm values:"
  echo "    ${DIGEST}"
fi
