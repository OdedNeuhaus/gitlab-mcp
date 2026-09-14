# HolmesGPT customization: `holmes-*` branch write policy

This checkout is `zereight/gitlab-mcp` **v2.1.61** (commit `0d242f54e420c27fbb2106ab375a874099319671`, 2026-09-13) plus a small, opt-in
server-side policy that lets HolmesGPT investigate repositories, create `holmes-*` branches, commit to them, and open
merge requests, while every other mutation is refused.

## Policy

> Repository content writes are permitted only to branches whose names start with the literal, case-sensitive prefix `holmes-`.

Accepted consequences: Holmes may write to **any** matching branch, including pre-existing ones, whoever created them,
and regardless of any MR's state. There is no ownership tracking, database, or MR lifecycle state.

Enabled with `HOLMES_WRITE_POLICY=true` (or `--holmes-write-policy=true`). The custom image sets it by default and the
startup log prints `holmes-write-policy: enabled`. Without the flag the server behaves exactly like upstream, which keeps
upstream's own test suite green.

### What is enforced (server side, at execution time)

| Tool | Check before any GitLab request |
| --- | --- |
| `create_branch` | new `branch` must be `holmes-<suffix>` and a valid git ref name; `ref` (source) may be anything, defaults to the project default branch (read only) |
| `push_files` | `branch` must be `holmes-<suffix>`; every file action must be `create` or `update` (`delete`/`move`/`previous_path` rejected, also when mixed into a batch) |
| `create_or_update_file` | `branch` must be `holmes-<suffix>`; `previous_path` (move/rename) rejected |
| `create_merge_request` | `source_branch` must be `holmes-<suffix>`; `target_branch` may be anything; description lines starting with `/` (GitLab quick actions such as `/merge`, `/target_branch`) rejected; `remove_source_branch: true` rejected. Opening never merges. |
| every other tool | rejected with `... is not allowed by the Holmes write policy` unless it is on the read allowlist |

Branch checks use `value.startsWith("holmes-")` (no regex, no case folding) plus a subset of `git check-ref-format`
(no whitespace/control characters, `..`, `//`, `@{`, `~ ^ : ? * [ \`, leading/trailing `/`, `.lock`, dot-leading components,
max 255 chars). The bare prefix `holmes-` is rejected. A missing, empty or `null` branch is an error; nothing falls back to the
default branch.

The tool allowlist lives in `utils/holmes-write-policy.ts` (`HOLMES_WRITE_TOOLS`, `HOLMES_READ_TOOLS`). It is applied in
three places in `index.ts`: the `list_tools` result, the `discover_tools` activation loop, and the central `call_tool` guard,
so hiding is never the only defence. `execute_graphql`, `orbit_*`, `discover_tools`, merge/approve/update-MR, delete, protect,
default-branch, project settings, pipeline/deployment/environment mutations, webhooks, CI variables (secrets), downloads, and
issue/note writes are all off the list. Upstream `force`/`start_branch`/`start_sha` commit options are never sent by the
enabled code paths.

### Not covered (by design)

* The GitLab token's own permissions are unchanged. If the token can push to `main`, only this server stands in the way.
* `target_project_id` (cross-project MRs), labels, assignees, reviewers, `squash`, `draft`, and `allow_collaboration` are passed
  through; none of them merges or writes outside the source branch.
* The quick-action check is a line-start heuristic (`/word` at the start of a line, leading whitespace ignored). A
  description that legitimately needs a line starting with `/` must use a code span or indent it under a list item.
* Commit messages are not inspected. GitLab does not execute quick actions in commit messages, but `Closes #n` style
  trailers still take effect when a human merges the MR.

## Deployment requirements (security boundary)

The policy is only as strong as the isolation of the GitLab token:

1. **The GitLab token stays inside the MCP pod.** Holmes authenticates to the MCP service with a separate shared secret
   (`STREAMABLE_HTTP_AUTH_TOKEN`), never with the GitLab token. See `holmes/helm/gitlab-mcp-holmes.yaml`.
2. **Holmes must not be able to obtain the token elsewhere.** No Kubernetes toolset/RBAC that can read Secrets or `exec` in
   the MCP namespace, no shell tool with access to the MCP pod's environment, no other GitLab MCP/CLI integration configured
   with the same token. Any such path bypasses this server entirely.
3. **Restrict network access** to the MCP service (NetworkPolicy to the Holmes pods) so the shared client secret is the only
   way in, and keep `MCP_SERVER_URL`/`MCP_ALLOWED_HOSTS` set for the in-cluster hostname.
4. **Do not use the HolmesGPT chart's built-in `mcpAddons.gitlabMcp` addon.** It runs the unpatched upstream package via
   `npx` and exposes all tools. Use the generic `mcp_servers` entry (`holmes/helm/holmes-values.example.yaml`).
5. Use a dedicated bot/project access token with the minimum GitLab role (Developer) and `api` scope; audit its activity.

### CI and deployment side effects

* Creating a `holmes-*` branch, committing to it, and opening an MR **can trigger CI pipelines** (branch pipelines and MR
  pipelines) with whatever the project's `.gitlab-ci.yml` does on non-default branches. Review `rules:`/`only:` in
  projects Holmes may touch; consider `workflow: rules` that skip or gate jobs for `$CI_COMMIT_BRANCH =~ /^holmes-/`.
* `holmes-*` branches must **not** be configured as ArgoCD/CD sources (Application `targetRevision`, ApplicationSet git
  generators matching all branches, "deploy every branch" review-app jobs) if proposals are meant to stay isolated from
  deployment. The server cannot tell what a branch deploys; it only restricts the name.

## Building the pinned image

Requires Docker, Node 22 (`.nvmrc`) and npm for the test step.

```bash
# from the repository root
IMAGE=registry.example.com/platform/gitlab-mcp-holmes TAG=2.1.61-holmes.1 PUSH=true holmes/build-image.sh
```

The script checks that HEAD contains the pinned upstream commit and that all `holmes-write-policy` call sites are still in
`index.ts`, runs the policy test suites, builds the upstream `Dockerfile` unchanged, layers `holmes/Dockerfile` on top
(sets `HOLMES_WRITE_POLICY=true` and OCI labels with the upstream commit), smoke-tests that the startup log reports the policy
as enabled, and prints the digest to pin in Helm. Pin by digest, not tag.

## Helm

`holmes/chart/gitlab-mcp-holmes/` is a complete chart (Deployment, Service, optional chart-managed Secrets, optional
NetworkPolicy, `helm test` hook). Its values follow the common gitlab-mcp chart layout (`image`, `service`, `gitlab.*`), so an
existing values file needs only these edits:

| Old value | New value | Note |
| --- | --- | --- |
| `image.repository` / `image.tag: latest` | your registry + pinned tag, or `image.digest` | never `latest` |
| `gitlab.secretName` (key `personalAccessToken`) | unchanged (`gitlab.secretKey` configurable) | GitLab token stays in this pod |
| `gitlab.readOnlyMode`, `gitlab.permissionMode` | `gitlab.permissionMode: modify` | `readOnlyMode` removed (deprecated upstream) |
| `gitlab.streamableHttp`, `gitlab.useSse`, `gitlab.host` | removed | always streamable HTTP on 0.0.0.0:3002 |
| `gitlab.gitlabDeniedToolsRegex` | `gitlab.deniedToolsRegex` (optional) | policy allowlist makes it redundant |
| `NODE_TLS_REJECT_UNAUTHORIZED=0` (hard-coded) | `gitlab.tls.rejectUnauthorized: false` or, better, `gitlab.tls.caSecretName` | |
| (none) | `mcp.authSecretName` or `mcp.authToken` | **required**: shared bearer token Holmes presents; server refuses to start without it |
| (none) | `mcp.serverUrl` (defaults to the in-cluster Service URL) | Host-header allowlist |
| (none) | `holmes.writePolicy: true` | default |

```bash
kubectl -n holmes-system create secret generic gitlab-mcp-client-token --from-literal=authToken="$(openssl rand -hex 32)"
helm upgrade --install holmes-gitlab-mcp holmes/chart/gitlab-mcp-holmes -n holmes-system \
  --set image.repository=registry.internal/platform/gitlab-mcp-holmes --set image.digest=sha256:... \
  --set gitlab.apiUrl=https://gitlab.internal/api/v4 --set gitlab.secretName=gitlab-mcp \
  --set mcp.authSecretName=gitlab-mcp-client-token
helm test holmes-gitlab-mcp -n holmes-system
```

`holmes/helm/holmes-values.example.yaml` shows the matching HolmesGPT-side values (`mcp_servers` entry with the bearer
header, built-in `mcpAddons.gitlabMcp` disabled). `holmes/helm/gitlab-mcp-holmes.yaml` is the same deployment as plain
manifests for environments without Helm.

The Holmes chart keys were checked against `helm/holmes/values.yaml` on the `robusta-dev/holmesgpt` master branch in
September 2026; confirm `mcp_servers`, `headers` templating and `additionalEnvVars` against the chart version you run.

## Testing

```bash
npm ci && npm run build
node --import tsx/esm --test --experimental-test-isolation=none test/holmes-write-policy.test.ts
node --import tsx/esm --test --experimental-test-isolation=none --test-concurrency=1 test/test-holmes-write-policy.ts
```

* `test/holmes-write-policy.test.ts` (unit, 26 tests): branch validation matrix (`main`, `master`, `release/*`,
  `feature/holmes-fix`, `Holmes-fix`, missing/empty/null, malformed refs), quick-action detection, commit-action checks, and
  allowlist invariants against upstream's registry (every listed tool exists; every read tool is in upstream's
  `readOnlyTools`; no delete tools; bypass tools rejected). These invariants are what catch upstream renames on upgrade.
* `test/test-holmes-write-policy.ts` (end to end, 14 tests): spawns the built server against the repo's mock GitLab and
  asserts, with request counters, that `holmes-fix-timeout` can be created from `main`, committed to (new and pre-existing
  `holmes-*` branches, single and batch), and proposed as an MR to `main`; that reads from `main` work; that every write
  tool rejects forbidden branches **before any request reaches GitLab**; that embedded delete/move/quick-action/
  `remove_source_branch` are rejected; that disabled tools fail via direct calls and via `discover_tools`; and that with the
  flag unset upstream behaviour is unchanged.

Both files are picked up by upstream's `scripts/run-mock-tests.sh`, so `npm run test:mock` runs them too.

## Retaining the customization across upstream upgrades

The patch is intentionally small: one new module, ~30 added lines in `index.ts` (all marked `holmes-write-policy`), two
test files, and this directory.

1. `git fetch upstream && git merge <new tag>` (or rebase the `holmes` branch).
2. Resolve conflicts in `index.ts` only; every call site is a one-liner next to the corresponding `Schema.parse(...)`
   or filter step. `grep -n holmes-write-policy index.ts` should show the import, the `list_tools` filter, the
   `discover_tools` loop guard, the two `call_tool` guards, four write cases, and the startup log (11 lines).
3. Re-check upstream changes that matter to the policy:
   * new or renamed write tools in `tools/registry.ts` (the unit test fails if an allowlisted name disappears; new tools are
     denied by default, so only add them deliberately);
   * new parameters on `create_branch`, `push_files`, `create_or_update_file`, `create_merge_request` in `schemas.ts`
     (anything that changes the destination, forces history, deletes, or merges must be rejected in
     `utils/holmes-write-policy.ts`);
   * changes to `createCommit`/`createOrUpdateFile`/`createMergeRequest` request bodies in `index.ts`;
   * new generic pass-through tools (anything like `execute_graphql`, `orbit_*`, raw REST) stay off the allowlist.
4. Run the two test suites and `npm run test:mock`, update `PINNED_UPSTREAM_*` in `holmes/build-image.sh`, rebuild, pin the
   new digest.

## Assumptions to confirm

* Deployed base: this customization was built and tested on upstream v2.1.61 at the commit above. Confirm it matches the
  image tag/digest currently deployed, or rebase before building.
* GitLab server version: `16.0.8-ee` was mentioned but not confirmed. The four APIs used (branches, commits, repository
  files, merge requests) and quick-action semantics are unchanged across 16.x to 19.x; the version-dependent upstream
  features (draft-note bulk publish, work items) are not on the allowlist.
* HolmesGPT chart key names as noted above.
