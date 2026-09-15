/**
 * Unit tests for the HolmesGPT write policy (utils/holmes-write-policy.ts).
 * Pure functions only — no server processes. The end-to-end enforcement
 * tests live in test/test-holmes-write-policy.ts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeHolmesTool,
  isBlankArgument,
  normalizeHolmesWriteArguments,
  HOLMES_BRANCH_PREFIX,
  HOLMES_READ_TOOLS,
  HOLMES_WRITE_TOOLS,
  isHolmesAllowedTool,
  isValidGitBranchName,
  validateHolmesBranch,
  validateHolmesCommitActions,
  validateHolmesCreateMergeRequest,
  validateHolmesCreateOrUpdateFile,
  validateHolmesPushFiles,
  validateNoQuickActions,
} from "../utils/holmes-write-policy.js";
import { allTools, readOnlyTools, deleteTools, destructiveTools } from "../tools/registry.js";

const NOT_ALLOWED = /Holmes may only write to branches whose name starts with "holmes-"/;
const REQUIRED = /is required/;
const INVALID = /not a valid branch name/;

describe("Holmes write policy: branch validation", () => {
  it("accepts a well-formed holmes- branch", () => {
    assert.equal(validateHolmesBranch("holmes-fix-timeout", "branch"), "holmes-fix-timeout");
  });

  it("accepts nested and dotted holmes- names that git allows", () => {
    for (const name of ["holmes-fix/retry", "holmes-v1.2", "holmes-INC-123_retry"]) {
      assert.equal(validateHolmesBranch(name, "branch"), name);
    }
  });

  it("rejects default and release branches", () => {
    for (const name of ["main", "master", "release/1.2", "release-1.2", "develop"]) {
      assert.throws(() => validateHolmesBranch(name, "branch"), NOT_ALLOWED, name);
    }
  });

  it("rejects branches that merely contain the prefix", () => {
    for (const name of ["feature/holmes-fix", "my-holmes-fix", "refs/heads/holmes-fix"]) {
      assert.throws(() => validateHolmesBranch(name, "branch"), NOT_ALLOWED, name);
    }
  });

  it("is case-sensitive", () => {
    for (const name of ["Holmes-fix", "HOLMES-fix", "holmes_fix"]) {
      assert.throws(() => validateHolmesBranch(name, "branch"), NOT_ALLOWED, name);
    }
  });

  it("rejects missing, empty, and non-string values", () => {
    for (const value of [undefined, null, "", 42, {}, ["holmes-x"]]) {
      assert.throws(() => validateHolmesBranch(value, "branch"), REQUIRED, String(value));
    }
  });

  it("rejects the bare prefix", () => {
    assert.throws(() => validateHolmesBranch(HOLMES_BRANCH_PREFIX, "branch"), INVALID);
  });

  it("rejects leading/trailing whitespace and control characters", () => {
    for (const name of [" holmes-x", "holmes-x ", "holmes-x\n", "holmes-a b", "holmes-\u0000x"]) {
      assert.throws(
        () => validateHolmesBranch(name, "branch"),
        /not allowed|not a valid/,
        JSON.stringify(name)
      );
    }
  });

  it("rejects malformed git ref names with the prefix", () => {
    for (const name of [
      "holmes-..main",
      "holmes-x/../main",
      "holmes-x//y",
      "holmes-x/",
      "holmes-x.lock",
      "holmes-x.",
      "holmes-x/.hidden",
      "holmes-x@{1}",
      "holmes-x~1",
      "holmes-x^",
      "holmes-x:y",
      "holmes-x?",
      "holmes-*",
      "holmes-[x]",
      "holmes-x\\y",
      `holmes-${"a".repeat(300)}`,
    ]) {
      assert.throws(() => validateHolmesBranch(name, "branch"), INVALID, name);
    }
  });

  it("names the offending field in the error", () => {
    assert.throws(
      () => validateHolmesBranch("main", "source_branch"),
      /^Error: source_branch "main"/
    );
  });

  it("isValidGitBranchName agrees with git on common cases", () => {
    assert.equal(isValidGitBranchName("main"), true);
    assert.equal(isValidGitBranchName("feature/x-1"), true);
    assert.equal(isValidGitBranchName("/x"), false);
    assert.equal(isValidGitBranchName("@"), false);
    assert.equal(isValidGitBranchName(""), false);
  });
});

describe("Holmes write policy: quick actions", () => {
  it("allows ordinary descriptions", () => {
    validateNoQuickActions(undefined, "description");
    validateNoQuickActions(null, "description");
    validateNoQuickActions("", "description");
    validateNoQuickActions(
      "Fix timeout in /api/v1 handler\n\nSee /etc/hosts changes.",
      "description"
    );
    validateNoQuickActions("Closes #12", "description");
  });

  it("rejects a quick action on its own line", () => {
    for (const text of [
      "/merge",
      "/merge\n",
      "Fix\n/merge",
      "Fix\r\n/merge\r\n",
      "Fix\n  /target_branch main",
      "\t/close",
      "/approve",
      "/remove_source_branch",
      "/ready",
    ]) {
      assert.throws(
        () => validateNoQuickActions(text, "description"),
        /quick action/,
        JSON.stringify(text)
      );
    }
  });
});

describe("Holmes write policy: commit actions", () => {
  it("allows create and update", () => {
    validateHolmesCommitActions([{}, { action: "create" }, { action: "update" }]);
  });

  it("rejects delete and move", () => {
    assert.throws(
      () => validateHolmesCommitActions([{ action: "delete" }]),
      /"delete" is not allowed/
    );
    assert.throws(
      () => validateHolmesCommitActions([{ action: "move", previous_path: "a" }]),
      /"move" is not allowed/
    );
  });

  it("rejects a prohibited action hidden among allowed ones", () => {
    assert.throws(
      () =>
        validateHolmesCommitActions([
          { action: "create" },
          { action: "update" },
          { action: "delete" },
        ]),
      /"delete" is not allowed/
    );
  });

  it("rejects previous_path on otherwise allowed actions", () => {
    assert.throws(
      () => validateHolmesCommitActions([{ action: "update", previous_path: "old.txt" }]),
      /previous_path/
    );
  });

  it("treats a blank previous_path as absent rather than a rename", () => {
    // Agents send null / "" to mean "not using this optional field". Rejecting
    // those sends the model hunting for a value that does not exist.
    validateHolmesCommitActions([{ action: "update", previous_path: "" }]);
    validateHolmesCommitActions([{ action: "update", previous_path: "   " }]);
    validateHolmesCommitActions([
      { action: "update", previous_path: undefined as unknown as string },
    ]);
  });

  it("treats a blank action as create", () => {
    validateHolmesCommitActions([{ action: "" }]);
  });

  it("says how to proceed, not only what is refused", () => {
    assert.throws(
      () => validateHolmesCommitActions([{ action: "update", previous_path: "old.txt" }]),
      /Omit previous_path entirely/
    );
    assert.throws(
      () => validateHolmesCommitActions([{ action: "delete" }]),
      /Use action "create" for a new file or "update" for an existing one/
    );
  });
});

describe("Holmes write policy: blank arguments", () => {
  it('recognises the values agents use for "no value"', () => {
    for (const value of [null, undefined, "", "   ", "\t"]) {
      assert.equal(isBlankArgument(value), true, JSON.stringify(value));
    }
    for (const value of ["main.py", 0, false, []]) {
      assert.equal(isBlankArgument(value), false, JSON.stringify(value));
    }
  });

  it("drops a blank previous_path from create_or_update_file", () => {
    for (const blank of [null, "", "  "]) {
      const args: Record<string, unknown> = { branch: "holmes-x", previous_path: blank };
      normalizeHolmesWriteArguments("create_or_update_file", args);
      assert.equal("previous_path" in args, false, JSON.stringify(blank));
    }
  });

  it("keeps a real previous_path so the policy can still reject it", () => {
    const args: Record<string, unknown> = { branch: "holmes-x", previous_path: "old.md" };
    normalizeHolmesWriteArguments("create_or_update_file", args);
    assert.equal(args.previous_path, "old.md");
    assert.throws(() => validateHolmesCreateOrUpdateFile(args), /previous_path/);
  });

  it("drops blank per-file fields inside a push_files batch", () => {
    // Upstream's sanitizer does not recurse, so these nulls would otherwise
    // reach Zod as "Expected string, received null".
    const args: Record<string, unknown> = {
      branch: "holmes-x",
      files: [
        { file_path: "a.txt", content: "a", previous_path: null, action: null, encoding: "" },
        { file_path: "b.txt", content: "b", previous_path: "" },
      ],
    };
    normalizeHolmesWriteArguments("push_files", args);
    for (const file of args.files as Record<string, unknown>[]) {
      assert.equal("previous_path" in file, false);
      assert.equal("action" in file, false);
      assert.equal("encoding" in file, false);
    }
  });

  it("drops null and empty entries from create_merge_request arrays", () => {
    const args: Record<string, unknown> = {
      source_branch: "holmes-x",
      assignee_ids: [null],
      reviewer_ids: null,
      labels: ["", null, "bug"],
      description: "",
    };
    normalizeHolmesWriteArguments("create_merge_request", args);
    assert.equal("assignee_ids" in args, false);
    assert.equal("reviewer_ids" in args, false);
    assert.deepEqual(args.labels, ["bug"]);
    assert.equal("description" in args, false);
  });

  it("leaves untouched anything it does not know about", () => {
    const args: Record<string, unknown> = { branch: "holmes-x", title: "", files: "not-an-array" };
    normalizeHolmesWriteArguments("push_files", args);
    assert.equal(args.title, "");
    assert.equal(args.files, "not-an-array");
    normalizeHolmesWriteArguments("unknown_tool", args);
    assert.equal(args.branch, "holmes-x");
  });

  it("tolerates non-object arguments", () => {
    normalizeHolmesWriteArguments("push_files", null);
    normalizeHolmesWriteArguments("push_files", undefined);
    normalizeHolmesWriteArguments("push_files", [1, 2, 3]);
  });
});

describe("Holmes write policy: tool descriptions", () => {
  it("is a no-op while the policy is disabled (upstream descriptions unchanged)", () => {
    // This suite runs without HOLMES_WRITE_POLICY; the enabled case is covered
    // end to end in test-holmes-write-policy.ts.
    assert.equal(describeHolmesTool("create_branch", "upstream text"), "upstream text");
    assert.equal(describeHolmesTool("list_issues", "upstream text"), "upstream text");
  });
});

describe("Holmes write policy: per-tool validators", () => {
  it("push_files requires a holmes- branch and allowed actions", () => {
    validateHolmesPushFiles({ branch: "holmes-x", files: [{ action: "create" }] });
    assert.throws(() => validateHolmesPushFiles({ branch: "main", files: [] }), NOT_ALLOWED);
    assert.throws(() => validateHolmesPushFiles({ files: [] }), REQUIRED);
    assert.throws(
      () => validateHolmesPushFiles({ branch: "holmes-x", files: [{ action: "delete" }] }),
      /"delete" is not allowed/
    );
  });

  it("create_or_update_file requires a holmes- branch and rejects previous_path", () => {
    validateHolmesCreateOrUpdateFile({ branch: "holmes-x" });
    assert.throws(() => validateHolmesCreateOrUpdateFile({ branch: "master" }), NOT_ALLOWED);
    assert.throws(
      () => validateHolmesCreateOrUpdateFile({ branch: "holmes-x", previous_path: "old.md" }),
      /previous_path/
    );
  });

  it("create_merge_request requires a holmes- source branch and no prohibited extras", () => {
    validateHolmesCreateMergeRequest({ source_branch: "holmes-x", description: "Fix" });
    validateHolmesCreateMergeRequest({ source_branch: "holmes-x", remove_source_branch: false });
    validateHolmesCreateMergeRequest({ source_branch: "holmes-x", remove_source_branch: null });
    assert.throws(() => validateHolmesCreateMergeRequest({ source_branch: "main" }), NOT_ALLOWED);
    assert.throws(() => validateHolmesCreateMergeRequest({}), REQUIRED);
    assert.throws(
      () => validateHolmesCreateMergeRequest({ source_branch: "holmes-x", description: "/merge" }),
      /quick action/
    );
    assert.throws(
      () =>
        validateHolmesCreateMergeRequest({ source_branch: "holmes-x", remove_source_branch: true }),
      /remove_source_branch/
    );
  });
});

describe("Holmes write policy: tool allowlist", () => {
  const knownToolNames = new Set(allTools.map(t => t.name));

  it("allows exactly the four repository write tools", () => {
    assert.deepEqual([...HOLMES_WRITE_TOOLS].sort(), [
      "create_branch",
      "create_merge_request",
      "create_or_update_file",
      "push_files",
    ]);
  });

  it("every allowlisted tool exists upstream (catches renames on upgrade)", () => {
    for (const name of [...HOLMES_READ_TOOLS, ...HOLMES_WRITE_TOOLS]) {
      assert.ok(knownToolNames.has(name), `unknown tool in allowlist: ${name}`);
    }
  });

  it("every allowlisted read tool is classified read-only upstream", () => {
    for (const name of HOLMES_READ_TOOLS) {
      assert.ok(readOnlyTools.has(name), `${name} is not in upstream readOnlyTools`);
    }
  });

  it("no allowlisted tool is a delete tool upstream, and no read tool is destructive", () => {
    for (const name of [...HOLMES_READ_TOOLS, ...HOLMES_WRITE_TOOLS]) {
      assert.ok(!deleteTools.has(name), `${name} is a delete tool`);
    }
    for (const name of HOLMES_READ_TOOLS) {
      assert.ok(!destructiveTools.has(name), `${name} is a destructive tool`);
    }
  });

  it("read and write sets do not overlap", () => {
    for (const name of HOLMES_WRITE_TOOLS) {
      assert.ok(!HOLMES_READ_TOOLS.has(name));
    }
  });

  it("rejects bypass and mutation tools by name", () => {
    for (const name of [
      "execute_graphql",
      "orbit_query",
      "orbit_list_tools",
      "discover_tools",
      "merge_merge_request",
      "approve_merge_request",
      "update_merge_request",
      "delete_branch",
      "protect_branch",
      "unprotect_branch",
      "update_default_branch",
      "update_project",
      "create_pipeline",
      "retry_pipeline",
      "cancel_pipeline",
      "play_pipeline_job",
      "create_tag",
      "delete_tag",
      "create_release",
      "fork_repository",
      "create_repository",
      "create_webhook",
      "list_project_variables",
      "get_pipeline_variables",
      "download_attachment",
      "upload_markdown",
      "create_issue",
      "create_merge_request_note",
      "create_note",
      "not_a_tool",
    ]) {
      assert.equal(isHolmesAllowedTool(name), false, name);
    }
  });
});
