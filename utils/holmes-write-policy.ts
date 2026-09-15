/**
 * HolmesGPT write policy — local customization, not part of upstream.
 *
 * Activated with HOLMES_WRITE_POLICY=true (or --holmes-write-policy=true).
 * When active:
 *
 *   1. Only the tools in HOLMES_ALLOWED_TOOLS are listed AND executable.
 *      Everything else (merge, delete, protect, settings, pipelines,
 *      execute_graphql, orbit_*, discover_tools, ...) is rejected at
 *      call time even if a client bypasses list_tools.
 *   2. Repository content writes (create_branch, create_or_update_file,
 *      push_files) may only target branches whose name starts with the
 *      literal, case-sensitive prefix "holmes-" and is a valid git ref name.
 *   3. create_merge_request requires a "holmes-" source branch, rejects
 *      GitLab quick actions in the description, and rejects
 *      remove_source_branch (branch deletion is disabled).
 *   4. File delete/move actions are rejected (push_files actions and
 *      create_or_update_file previous_path).
 *
 * All checks run BEFORE any request is sent to GitLab. The policy does not
 * change what the GitLab token itself is permitted to do.
 *
 * This file is self-contained on purpose: upstream merges should only have
 * to re-apply the few one-line call sites in index.ts (grep for
 * "holmes-write-policy"). See holmes/README.md.
 */
import { getConfig } from "../config.js";

export const HOLMES_BRANCH_PREFIX = "holmes-";

export const HOLMES_WRITE_POLICY_ENABLED =
  getConfig("holmes-write-policy", "HOLMES_WRITE_POLICY") === "true";

/** The only tools that may mutate anything in GitLab. */
export const HOLMES_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "create_branch",
  "create_or_update_file",
  "push_files",
  "create_merge_request",
]);

/**
 * Read-only investigation tools. Every name here must be in upstream's
 * readOnlyTools set (asserted by test/holmes-write-policy.test.ts).
 * Deliberately excluded: CI/CD variables (secrets), webhooks, execute_graphql,
 * orbit_*, discover_tools, download_* (writes to disk / remote proxy), wiki,
 * milestones, work items, todos, dependency proxy, vulnerabilities.
 */
export const HOLMES_READ_TOOLS: ReadonlySet<string> = new Set([
  // identity / health
  "health_check",
  "whoami",
  "get_users",
  "get_user",
  // projects / namespaces
  "search_repositories",
  "list_projects",
  "get_project",
  "list_group_projects",
  "list_namespaces",
  "get_namespace",
  "list_project_members",
  // repository content
  "get_repository_tree",
  "get_file_contents",
  "get_file_blame",
  "search_code",
  "search_project_code",
  "search_group_code",
  // branches / commits / tags
  "list_branches",
  "get_branch",
  "get_branch_diffs",
  "list_protected_branches",
  "get_protected_branch",
  "list_commits",
  "get_commit",
  "get_commit_diff",
  "list_commit_statuses",
  "list_tags",
  "get_tag",
  // merge requests (read)
  "list_merge_requests",
  "list_group_merge_requests",
  "get_merge_request",
  "get_merge_request_diffs",
  "list_merge_request_diffs",
  "list_merge_request_changed_files",
  "get_merge_request_file_diff",
  "list_merge_request_versions",
  "get_merge_request_version",
  "mr_discussions",
  "get_merge_request_notes",
  "get_merge_request_note",
  "list_merge_request_pipelines",
  "get_merge_request_conflicts",
  "get_merge_request_approval_state",
  // issues (read)
  "list_issues",
  "my_issues",
  "get_issue",
  "list_issue_discussions",
  "list_issue_links",
  // CI/CD (read)
  "list_pipelines",
  "get_pipeline",
  "list_pipeline_jobs",
  "list_pipeline_trigger_jobs",
  "get_pipeline_job",
  "get_pipeline_job_output",
  "list_job_artifacts",
  "validate_ci_lint",
  "validate_project_ci_lint",
  // deployments / environments (read)
  "list_deployments",
  "get_deployment",
  "list_deployment_merge_requests",
  "list_environments",
  "get_environment",
  // misc read
  "list_releases",
  "get_release",
  "list_labels",
  "get_label",
  "list_events",
  "get_project_events",
]);

export function isHolmesAllowedTool(toolName: string): boolean {
  return HOLMES_READ_TOOLS.has(toolName) || HOLMES_WRITE_TOOLS.has(toolName);
}

// ---------------------------------------------------------------------------
// Pure validators (always enforce; unit-tested directly)
// ---------------------------------------------------------------------------

/** Characters git forbids anywhere in a ref name: control chars, space, DEL, ~ ^ : ? * [ \ */
// eslint-disable-next-line no-control-regex
const INVALID_REF_CHARS = /[\u0000-\u0020\u007f~^:?*[\\]/;
const MAX_BRANCH_NAME_LENGTH = 255;

/** Subset of `git check-ref-format --branch` sufficient to reject malformed names. */
export function isValidGitBranchName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_BRANCH_NAME_LENGTH) return false;
  if (INVALID_REF_CHARS.test(name)) return false;
  if (name.startsWith("/") || name.endsWith("/")) return false;
  if (name.endsWith(".") || name.endsWith(".lock")) return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
  if (name === "@") return false;
  return name.split("/").every(component => component.length > 0 && !component.startsWith("."));
}

/**
 * Validate a destination branch value. Returns the (unchanged) branch name or throws.
 * Never falls back to a default branch: a missing value is an error.
 */
export function validateHolmesBranch(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `${field} is required and must name a branch starting with "${HOLMES_BRANCH_PREFIX}" ` +
        `(for example "${HOLMES_BRANCH_PREFIX}fix-timeout"). There is no default: the request is not ` +
        `retried against the default branch.`
    );
  }
  if (!value.startsWith(HOLMES_BRANCH_PREFIX)) {
    throw new Error(
      `${field} "${value}" is not allowed: Holmes may only write to branches whose name starts with ` +
        `"${HOLMES_BRANCH_PREFIX}" (case-sensitive). Call create_branch with branch ` +
        `"${HOLMES_BRANCH_PREFIX}<short-description>" and ref "${value}", then retry this call against ` +
        `that branch. Do not retry against "${value}".`
    );
  }
  if (value.length === HOLMES_BRANCH_PREFIX.length || !isValidGitBranchName(value)) {
    throw new Error(
      `${field} "${value}" is not a valid branch name (expected "${HOLMES_BRANCH_PREFIX}<suffix>" with a valid git ref name)`
    );
  }
  return value;
}

/**
 * GitLab executes quick actions ("/merge", "/target_branch main", "/close", ...)
 * found on their own line in a merge request description. Reject any line that
 * looks like one rather than maintaining a list of dangerous commands.
 */
const QUICK_ACTION_LINE = /^\s*\/[A-Za-z]/;

export function validateNoQuickActions(text: string | null | undefined, field: string): void {
  if (!text) return;
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (QUICK_ACTION_LINE.test(line)) {
      const command = line.trim().split(/\s+/)[0];
      throw new Error(
        `${field} contains a GitLab quick action line ("${command}"); quick actions are not allowed by the Holmes write policy`
      );
    }
  }
}

type CommitFileLike = { action?: string; previous_path?: string };

/**
 * Agents routinely send null / "" / "  " to mean "I am not using this optional
 * field". Treat those as absent everywhere instead of rejecting them: a blank
 * previous_path is not a rename, so refusing it sends the model hunting for a
 * value that does not exist.
 */
export function isBlankArgument(value: unknown): boolean {
  return (
    value === null || value === undefined || (typeof value === "string" && value.trim() === "")
  );
}

/** Wording matters: say what to send instead, not only what is refused. */
const PREVIOUS_PATH_ERROR =
  "previous_path is not supported by the Holmes write policy (renames and moves are disabled). " +
  "Omit previous_path entirely — updating or creating a file in place does not need it.";

/** Only create/update commit actions are allowed; delete and move are rejected. */
export function validateHolmesCommitActions(files: ReadonlyArray<CommitFileLike>): void {
  for (const file of files) {
    const action = isBlankArgument(file.action) ? "create" : file.action;
    if (action !== "create" && action !== "update") {
      throw new Error(
        `push_files action "${action}" is not allowed by the Holmes write policy. ` +
          `Use action "create" for a new file or "update" for an existing one; ` +
          `"delete" and "move" are disabled.`
      );
    }
    if (!isBlankArgument(file.previous_path)) {
      throw new Error(`push_files: ${PREVIOUS_PATH_ERROR}`);
    }
  }
}

export function validateHolmesCreateBranch(args: { branch?: unknown }): void {
  validateHolmesBranch(args.branch, "branch");
}

export function validateHolmesCreateOrUpdateFile(args: {
  branch?: unknown;
  previous_path?: string;
}): void {
  validateHolmesBranch(args.branch, "branch");
  if (!isBlankArgument(args.previous_path)) {
    throw new Error(`create_or_update_file: ${PREVIOUS_PATH_ERROR}`);
  }
}

export function validateHolmesPushFiles(args: {
  branch?: unknown;
  files: ReadonlyArray<CommitFileLike>;
}): void {
  validateHolmesBranch(args.branch, "branch");
  validateHolmesCommitActions(args.files);
}

export function validateHolmesCreateMergeRequest(args: {
  source_branch?: unknown;
  description?: string | null;
  remove_source_branch?: boolean | null;
}): void {
  validateHolmesBranch(args.source_branch, "source_branch");
  validateNoQuickActions(args.description, "description");
  if (args.remove_source_branch === true) {
    throw new Error(
      "remove_source_branch is not allowed by the Holmes write policy (branch deletion is disabled)"
    );
  }
}

// ---------------------------------------------------------------------------
// Call-site guards (no-ops unless HOLMES_WRITE_POLICY=true)
// ---------------------------------------------------------------------------

export function assertHolmesToolAllowed(toolName: string): void {
  if (!HOLMES_WRITE_POLICY_ENABLED) return;
  if (!isHolmesAllowedTool(toolName)) {
    throw new Error(`${toolName} is not allowed by the Holmes write policy`);
  }
}

export function assertHolmesCreateBranch(args: { branch?: unknown }): void {
  if (HOLMES_WRITE_POLICY_ENABLED) validateHolmesCreateBranch(args);
}

export function assertHolmesCreateOrUpdateFile(args: {
  branch?: unknown;
  previous_path?: string;
}): void {
  if (HOLMES_WRITE_POLICY_ENABLED) validateHolmesCreateOrUpdateFile(args);
}

export function assertHolmesPushFiles(args: {
  branch?: unknown;
  files: ReadonlyArray<CommitFileLike>;
}): void {
  if (HOLMES_WRITE_POLICY_ENABLED) validateHolmesPushFiles(args);
}

export function assertHolmesCreateMergeRequest(args: {
  source_branch?: unknown;
  description?: string | null;
  remove_source_branch?: boolean | null;
}): void {
  if (HOLMES_WRITE_POLICY_ENABLED) validateHolmesCreateMergeRequest(args);
}

// ---------------------------------------------------------------------------
// Argument hygiene
//
// Upstream's sanitizeToolArguments drops top-level null/undefined but does not
// recurse, so nulls inside push_files[].files and create_merge_request's id
// arrays reach Zod and fail with type errors the model cannot act on
// ("Expected string, received null"). Normalizing blanks away before parsing
// turns several wasted turns into none. Only runs when the policy is enabled,
// so upstream behaviour is untouched.
// ---------------------------------------------------------------------------

/** Optional fields the model may blank out rather than omit. */
const BLANKABLE_TOP_LEVEL: Readonly<Record<string, readonly string[]>> = {
  create_or_update_file: ["previous_path", "last_commit_id", "commit_id", "encoding"],
  create_merge_request: ["description", "target_project_id"],
  create_branch: ["ref"],
};

/** Array fields GitLab rejects with 400 when they contain null or empty entries. */
const BLANKABLE_ARRAYS: Readonly<Record<string, readonly string[]>> = {
  create_merge_request: ["assignee_ids", "reviewer_ids", "labels"],
};

/** Per-file optional fields inside a push_files batch. */
const BLANKABLE_FILE_FIELDS = ["previous_path", "action", "encoding", "last_commit_id"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Drop blank optional arguments in place, before Zod validation.
 * Never adds or rewrites a meaningful value — it only removes "no value" markers.
 */
export function normalizeHolmesWriteArguments(toolName: string, args: unknown): void {
  if (!isPlainObject(args)) return;

  for (const key of BLANKABLE_TOP_LEVEL[toolName] ?? []) {
    if (isBlankArgument(args[key])) delete args[key];
  }

  for (const key of BLANKABLE_ARRAYS[toolName] ?? []) {
    const value = args[key];
    if (Array.isArray(value)) {
      const cleaned = value.filter(entry => !isBlankArgument(entry));
      if (cleaned.length === 0) delete args[key];
      else args[key] = cleaned;
    } else if (isBlankArgument(value)) {
      delete args[key];
    }
  }

  if (toolName === "push_files" && Array.isArray(args.files)) {
    for (const file of args.files) {
      if (!isPlainObject(file)) continue;
      for (const key of BLANKABLE_FILE_FIELDS) {
        if (isBlankArgument(file[key])) delete file[key];
      }
    }
  }
}

/** No-op unless the policy is enabled (keeps upstream behaviour identical). */
export function normalizeHolmesWriteArgumentsIfEnabled(toolName: string, args: unknown): void {
  if (HOLMES_WRITE_POLICY_ENABLED) normalizeHolmesWriteArguments(toolName, args);
}

// ---------------------------------------------------------------------------
// Tool descriptions
//
// The constraint has to be visible BEFORE the first call. Without it the agent
// attempts a default-branch write, reads the rejection, and reverse-engineers
// the rule over several turns.
// ---------------------------------------------------------------------------

const WORKFLOW_HINT =
  `Proposal workflow: create_branch ("${HOLMES_BRANCH_PREFIX}<short-description>", ref = the default branch) ` +
  `-> push_files or create_or_update_file on that branch -> create_merge_request from it. ` +
  `A human reviews and merges; merging, deleting and force-pushing are unavailable.`;

const TOOL_POLICY_HINTS: Readonly<Record<string, string>> = {
  create_branch:
    `POLICY: the new branch name must start with "${HOLMES_BRANCH_PREFIX}" (literal, case-sensitive), ` +
    `e.g. "${HOLMES_BRANCH_PREFIX}fix-timeout". "ref" may be any existing branch, such as main or master. ` +
    WORKFLOW_HINT,
  push_files:
    `POLICY: "branch" must start with "${HOLMES_BRANCH_PREFIX}" (literal, case-sensitive); writes to main, ` +
    `master, release or feature branches are refused. Per-file "action" may only be "create" or "update", ` +
    `and "previous_path" must be omitted (renames and moves are disabled). ` +
    WORKFLOW_HINT,
  create_or_update_file:
    `POLICY: "branch" must start with "${HOLMES_BRANCH_PREFIX}" (literal, case-sensitive); writes to main, ` +
    `master, release or feature branches are refused. Omit "previous_path" — it is only for renames, which ` +
    `are disabled, and creating versus updating is detected automatically. ` +
    WORKFLOW_HINT,
  create_merge_request:
    `POLICY: "source_branch" must start with "${HOLMES_BRANCH_PREFIX}" (literal, case-sensitive); ` +
    `"target_branch" may be main, master or any other branch. Do not put GitLab quick actions (lines ` +
    `starting with "/") in the description, and do not set remove_source_branch. Opening the merge request ` +
    `never merges it. ` +
    WORKFLOW_HINT,
};

/** Returns the description with the policy appended, or the original when nothing applies. */
export function describeHolmesTool(
  toolName: string,
  description: string | undefined
): string | undefined {
  if (!HOLMES_WRITE_POLICY_ENABLED) return description;
  const hint = TOOL_POLICY_HINTS[toolName];
  if (!hint) return description;
  return description ? `${description}\n\n${hint}` : hint;
}
