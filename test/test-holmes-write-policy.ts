/**
 * End-to-end tests for the HolmesGPT write policy (HOLMES_WRITE_POLICY=true).
 *
 * Spawns build/index.js against the in-repo mock GitLab server and verifies
 * that every enabled write tool enforces the holmes- branch prefix BEFORE any
 * upstream mutation, that disabled tools cannot run via direct calls or
 * discover_tools, and that read tools keep working. A final block confirms
 * upstream behaviour is unchanged when the flag is off.
 *
 * Requires `npm run build` first (like the other server-spawning suites).
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert";
import type { Request, Response } from "express";
import {
  cleanupServers,
  findAvailablePort,
  HOST,
  launchServer,
  ServerInstance,
  TransportMode,
} from "./utils/server-launcher.js";
import { MockGitLabServer, findMockServerPort } from "./utils/mock-gitlab-server.js";
import { CustomHeaderClient } from "./clients/custom-header-client.js";

const MOCK_TOKEN = "glpat-holmes-policy-test";
const PROJECT = "1";

const BRANCHES_PATH = `/projects/${PROJECT}/repository/branches`;
const COMMITS_PATH = `/projects/${PROJECT}/repository/commits`;
const README_PATH = `/projects/${PROJECT}/repository/files/README.md`;
const NEWFILE_PATH = `/projects/${PROJECT}/repository/files/NEW.md`;
const MR_PATH = `/projects/${PROJECT}/merge_requests`;

type Hit = { method: string; path: string; body: Record<string, unknown> };

let mockGitLab: MockGitLabServer;
let mockGitLabUrl: string;
let hits: Hit[] = [];
const servers: ServerInstance[] = [];
let portCounter = 0;

function mutations(): Hit[] {
  return hits.filter(h => h.method !== "GET");
}

function totalRequests(): number {
  return (mockGitLab as unknown as { requestCount: number }).requestCount;
}

function record(method: string, path: string, respond: (req: Request, res: Response) => void) {
  mockGitLab.addMockHandler(
    method.toLowerCase() as "get" | "post" | "put" | "delete",
    path,
    (req, res) => {
      hits.push({ method, path, body: (req.body ?? {}) as Record<string, unknown> });
      respond(req, res);
    }
  );
}

function fileResponse(branch: string) {
  return {
    file_name: "README.md",
    file_path: "README.md",
    size: 5,
    encoding: "base64",
    content: Buffer.from("hello").toString("base64"),
    ref: branch,
    blob_id: "blob1",
    commit_id: "c0ffee",
    last_commit_id: "c0ffee",
  };
}

function commitResponse(body: Record<string, unknown>) {
  return {
    id: "abc123abc123",
    short_id: "abc123",
    title: String(body.commit_message ?? "commit"),
    author_name: "Holmes",
    author_email: "holmes@example.com",
    authored_date: "2026-01-01T00:00:00Z",
    committer_name: "Holmes",
    committer_email: "holmes@example.com",
    committed_date: "2026-01-01T00:00:00Z",
    web_url: "https://gitlab.mock/project/1/-/commit/abc123",
    parent_ids: ["parent1"],
  };
}

function installMockHandlers() {
  record("POST", BRANCHES_PATH, (req, res) => {
    res.status(201).json({
      name: req.body.branch,
      commit: { id: "c0ffee", web_url: "https://gitlab.mock/project/1/-/commit/c0ffee" },
    });
  });
  record("POST", COMMITS_PATH, (req, res) => res.status(201).json(commitResponse(req.body)));
  // README.md exists on every branch (pre-existing file => PUT path)
  record("GET", README_PATH, (req, res) => res.json(fileResponse(String(req.query.ref))));
  record("PUT", README_PATH, (req, res) =>
    res.json({ file_path: "README.md", branch: req.body.branch })
  );
  record("POST", README_PATH, (req, res) =>
    res.status(201).json({ file_path: "README.md", branch: req.body.branch })
  );
  // NEW.md does not exist yet (=> POST path)
  record("GET", NEWFILE_PATH, (_req, res) =>
    res.status(404).json({ message: "404 File Not Found" })
  );
  record("POST", NEWFILE_PATH, (req, res) =>
    res.status(201).json({ file_path: "NEW.md", branch: req.body.branch })
  );
  record("POST", MR_PATH, (req, res) => {
    res.status(201).json({
      id: 42,
      iid: 7,
      project_id: 1,
      title: req.body.title,
      description: req.body.description ?? null,
      state: "opened",
      author: { id: 1, username: "holmes", name: "Holmes" },
      source_branch: req.body.source_branch,
      target_branch: req.body.target_branch,
      web_url: "https://gitlab.mock/project/1/-/merge_requests/7",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      merged_at: null,
      closed_at: null,
      merge_commit_sha: null,
    });
  });
}

async function launchMcpServer(extraEnv: Record<string, string> = {}): Promise<ServerInstance> {
  const port = await findAvailablePort(3800 + portCounter++ * 10);
  const server = await launchServer({
    mode: TransportMode.STREAMABLE_HTTP,
    port,
    timeout: 15000,
    env: {
      STREAMABLE_HTTP: "true",
      REMOTE_AUTHORIZATION: "true",
      GITLAB_API_URL: `${mockGitLabUrl}/api/v4`,
      // Enable everything upstream offers so the allowlist is what prunes it.
      GITLAB_TOOLSETS: "all",
      GITLAB_DISABLE_VERSION_CHECK: "true",
      // The suite issues far more than the default 60 MCP requests/minute (upstream cap: 1000).
      MAX_REQUESTS_PER_MINUTE: "1000",
      ...extraEnv,
    },
  });
  servers.push(server);
  return server;
}

async function connect(server: ServerInstance): Promise<CustomHeaderClient> {
  const client = new CustomHeaderClient({ authorization: `Bearer ${MOCK_TOKEN}` });
  await client.connect(`http://${HOST}:${server.port}/mcp`);
  return client;
}

async function withClient<T>(
  server: ServerInstance,
  fn: (client: CustomHeaderClient) => Promise<T>
): Promise<T> {
  const client = await connect(server);
  try {
    return await fn(client);
  } finally {
    await client.disconnect();
  }
}

function resultText(result: { content?: unknown }): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content.map((c: { text?: string }) => c.text ?? "").join("\n");
}

/** Call a tool and assert it fails with `pattern` without any request reaching GitLab. */
async function expectRejected(
  client: CustomHeaderClient,
  tool: string,
  args: Record<string, unknown>,
  pattern: RegExp
): Promise<void> {
  const mutationsBefore = mutations().length;
  const requestsBefore = totalRequests();
  let message: string;
  try {
    const result = await client.callTool(tool, args);
    assert.ok(result.isError, `${tool} should have failed, got: ${JSON.stringify(result)}`);
    message = resultText(result);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.match(message, pattern, `${tool}(${JSON.stringify(args)}) rejected for the wrong reason`);
  assert.strictEqual(mutations().length, mutationsBefore, `${tool} must not mutate GitLab`);
  assert.strictEqual(
    totalRequests(),
    requestsBefore,
    `${tool} must be rejected before any GitLab request`
  );
}

const NOT_ALLOWED_BRANCH = /Holmes may only write to branches whose name starts with "holmes-"/;
const NOT_ALLOWED_TOOL = /not allowed by the Holmes write policy/;
const MISSING = /is required|Required|invalid_type/i;

const FORBIDDEN_BRANCHES = [
  "main",
  "master",
  "release/1.2",
  "release-1.2",
  "develop",
  "feature/login",
  "feature/holmes-fix",
  "Holmes-fix",
  "holmes_fix",
];

const DISABLED_TOOLS = [
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
  "create_tag",
  "delete_tag",
  "create_release",
  "fork_repository",
  "create_repository",
  "create_issue",
  "create_merge_request_note",
  "execute_graphql",
  "orbit_query",
  "discover_tools",
];

describe("Holmes write policy", { concurrency: 1 }, () => {
  before(async () => {
    mockGitLab = new MockGitLabServer({
      port: await findMockServerPort(),
      validTokens: [MOCK_TOKEN],
    });
    installMockHandlers();
    await mockGitLab.start();
    mockGitLabUrl = mockGitLab.getUrl();
  });

  after(async () => {
    cleanupServers(servers);
    if (mockGitLab) await mockGitLab.stop();
  });

  describe("with HOLMES_WRITE_POLICY=true", { concurrency: 1 }, () => {
    let server: ServerInstance;

    before(async () => {
      server = await launchMcpServer({ HOLMES_WRITE_POLICY: "true" });
    });

    test("list_tools exposes only allowlisted tools", async () => {
      const names = await withClient(server, async c =>
        (await c.listTools()).tools.map(t => t.name)
      );
      for (const expected of [
        "create_branch",
        "push_files",
        "create_or_update_file",
        "create_merge_request",
        "get_file_contents",
        "get_repository_tree",
        "list_merge_requests",
        "get_pipeline_job_output",
      ]) {
        assert.ok(names.includes(expected), `${expected} should be listed`);
      }
      for (const disabled of DISABLED_TOOLS) {
        assert.ok(!names.includes(disabled), `${disabled} must not be listed`);
      }
    });

    test("creating holmes-fix-timeout from main succeeds", async () => {
      hits = [];
      const result = await withClient(server, c =>
        c.callTool("create_branch", {
          project_id: PROJECT,
          branch: "holmes-fix-timeout",
          ref: "main",
        })
      );
      assert.ok(!result.isError, resultText(result));
      const [hit] = mutations();
      assert.strictEqual(hit?.path, BRANCHES_PATH);
      assert.strictEqual(hit?.body.branch, "holmes-fix-timeout");
      assert.strictEqual(hit?.body.ref, "main");
    });

    test("push_files commits to a new holmes- branch", async () => {
      hits = [];
      const result = await withClient(server, c =>
        c.callTool("push_files", {
          project_id: PROJECT,
          branch: "holmes-fix-timeout",
          commit_message: "Increase timeout",
          files: [{ file_path: "config.yaml", content: "timeout: 30" }],
        })
      );
      assert.ok(!result.isError, resultText(result));
      const [hit] = mutations();
      assert.strictEqual(hit?.path, COMMITS_PATH);
      assert.strictEqual(hit?.body.branch, "holmes-fix-timeout");
      assert.strictEqual(hit?.body.force, undefined, "force must never be sent");
      assert.strictEqual(hit?.body.start_branch, undefined);
    });

    test("push_files commits to a pre-existing holmes- branch created by someone else", async () => {
      hits = [];
      const result = await withClient(server, c =>
        c.callTool("push_files", {
          project_id: PROJECT,
          branch: "holmes-existing",
          commit_message: "Follow-up",
          files: [{ file_path: "README.md", content: "updated", action: "update" }],
        })
      );
      assert.ok(!result.isError, resultText(result));
      assert.strictEqual(mutations()[0]?.body.branch, "holmes-existing");
    });

    test("create_or_update_file updates an existing file on a pre-existing holmes- branch", async () => {
      hits = [];
      const result = await withClient(server, c =>
        c.callTool("create_or_update_file", {
          project_id: PROJECT,
          file_path: "README.md",
          content: "updated",
          commit_message: "Update README",
          branch: "holmes-existing",
        })
      );
      assert.ok(!result.isError, resultText(result));
      const [hit] = mutations();
      assert.strictEqual(hit?.method, "PUT");
      assert.strictEqual(hit?.path, README_PATH);
      assert.strictEqual(hit?.body.branch, "holmes-existing");
    });

    test("create_or_update_file creates a new file on a holmes- branch", async () => {
      hits = [];
      const result = await withClient(server, c =>
        c.callTool("create_or_update_file", {
          project_id: PROJECT,
          file_path: "NEW.md",
          content: "new",
          commit_message: "Add NEW.md",
          branch: "holmes-fix-timeout",
        })
      );
      assert.ok(!result.isError, resultText(result));
      const [hit] = mutations();
      assert.strictEqual(hit?.method, "POST");
      assert.strictEqual(hit?.path, NEWFILE_PATH);
      assert.strictEqual(hit?.body.branch, "holmes-fix-timeout");
    });

    test("opening an MR from holmes-fix-timeout to main succeeds without merging", async () => {
      hits = [];
      const result = await withClient(server, c =>
        c.callTool("create_merge_request", {
          project_id: PROJECT,
          title: "Fix timeout",
          description: "Raises the timeout in /api/v1 handler.\n\nCloses #12",
          source_branch: "holmes-fix-timeout",
          target_branch: "main",
          remove_source_branch: false,
        })
      );
      assert.ok(!result.isError, resultText(result));
      assert.strictEqual(mutations().length, 1);
      const [hit] = mutations();
      assert.strictEqual(hit?.path, MR_PATH);
      assert.strictEqual(hit?.body.source_branch, "holmes-fix-timeout");
      assert.strictEqual(hit?.body.target_branch, "main");
      assert.strictEqual(hit?.body.merge_when_pipeline_succeeds, undefined);
      assert.strictEqual(hit?.body.remove_source_branch, false);
    });

    test("reads from main remain available", async () => {
      hits = [];
      const result = await withClient(server, c =>
        c.callTool("get_file_contents", {
          project_id: PROJECT,
          file_path: "README.md",
          ref: "main",
        })
      );
      assert.ok(!result.isError, resultText(result));
      assert.match(resultText(result), /hello/);
      assert.strictEqual(mutations().length, 0);
      assert.strictEqual(hits[0]?.method, "GET");
    });

    test("every write tool rejects non-holmes branches before any upstream request", async () => {
      await withClient(server, async c => {
        for (const branch of FORBIDDEN_BRANCHES) {
          await expectRejected(
            c,
            "create_branch",
            { project_id: PROJECT, branch, ref: "main" },
            NOT_ALLOWED_BRANCH
          );
          await expectRejected(
            c,
            "push_files",
            {
              project_id: PROJECT,
              branch,
              commit_message: "x",
              files: [{ file_path: "a.txt", content: "a" }],
            },
            NOT_ALLOWED_BRANCH
          );
          await expectRejected(
            c,
            "create_or_update_file",
            {
              project_id: PROJECT,
              file_path: "README.md",
              content: "x",
              commit_message: "x",
              branch,
            },
            NOT_ALLOWED_BRANCH
          );
          await expectRejected(
            c,
            "create_merge_request",
            { project_id: PROJECT, title: "x", source_branch: branch, target_branch: "main" },
            NOT_ALLOWED_BRANCH
          );
        }
      });
    });

    test("missing, empty, null, and bare-prefix branch values are rejected (no default-branch fallback)", async () => {
      await withClient(server, async c => {
        const files = [{ file_path: "a.txt", content: "a" }];
        await expectRejected(c, "create_branch", { project_id: PROJECT, ref: "main" }, MISSING);
        await expectRejected(
          c,
          "create_branch",
          { project_id: PROJECT, branch: "", ref: "main" },
          MISSING
        );
        await expectRejected(
          c,
          "create_branch",
          { project_id: PROJECT, branch: null, ref: "main" },
          MISSING
        );
        await expectRejected(
          c,
          "create_branch",
          { project_id: PROJECT, branch: "holmes-", ref: "main" },
          /not a valid branch name/
        );
        await expectRejected(
          c,
          "push_files",
          { project_id: PROJECT, commit_message: "x", files },
          MISSING
        );
        await expectRejected(
          c,
          "push_files",
          { project_id: PROJECT, branch: "", commit_message: "x", files },
          MISSING
        );
        await expectRejected(
          c,
          "create_or_update_file",
          { project_id: PROJECT, file_path: "README.md", content: "x", commit_message: "x" },
          MISSING
        );
        await expectRejected(
          c,
          "create_merge_request",
          { project_id: PROJECT, title: "x", target_branch: "main" },
          MISSING
        );
      });
    });

    test("prohibited actions embedded in otherwise allowed requests are rejected", async () => {
      await withClient(server, async c => {
        // delete / move hidden inside a batch commit to a holmes- branch
        await expectRejected(
          c,
          "push_files",
          {
            project_id: PROJECT,
            branch: "holmes-fix-timeout",
            commit_message: "x",
            files: [
              { file_path: "a.txt", content: "a" },
              { file_path: "old.txt", action: "delete" },
            ],
          },
          /"delete" is not allowed/
        );
        await expectRejected(
          c,
          "push_files",
          {
            project_id: PROJECT,
            branch: "holmes-fix-timeout",
            commit_message: "x",
            files: [{ file_path: "new.txt", action: "move", previous_path: "old.txt" }],
          },
          /"move" is not allowed/
        );
        // single-file move
        await expectRejected(
          c,
          "create_or_update_file",
          {
            project_id: PROJECT,
            file_path: "README.md",
            content: "x",
            commit_message: "x",
            branch: "holmes-fix-timeout",
            previous_path: "OLD.md",
          },
          /previous_path/
        );
        // quick actions in the MR description
        for (const description of [
          "/merge",
          "Fix\n/merge",
          "Fix\n  /target_branch main",
          "/close\nFix",
        ]) {
          await expectRejected(
            c,
            "create_merge_request",
            {
              project_id: PROJECT,
              title: "x",
              description,
              source_branch: "holmes-fix-timeout",
              target_branch: "main",
            },
            /quick action/
          );
        }
        // deferred branch deletion
        await expectRejected(
          c,
          "create_merge_request",
          {
            project_id: PROJECT,
            title: "x",
            source_branch: "holmes-fix-timeout",
            target_branch: "main",
            remove_source_branch: true,
          },
          /remove_source_branch/
        );
      });
    });

    test("disabled tools cannot execute through direct calls", async () => {
      await withClient(server, async c => {
        await expectRejected(
          c,
          "delete_branch",
          { project_id: PROJECT, branch_name: "main" },
          NOT_ALLOWED_TOOL
        );
        await expectRejected(
          c,
          "merge_merge_request",
          { project_id: PROJECT, merge_request_iid: 7 },
          NOT_ALLOWED_TOOL
        );
        await expectRejected(
          c,
          "update_merge_request",
          { project_id: PROJECT, merge_request_iid: 7, target_branch: "main" },
          NOT_ALLOWED_TOOL
        );
        await expectRejected(
          c,
          "update_default_branch",
          { project_id: PROJECT, branch: "holmes-x" },
          NOT_ALLOWED_TOOL
        );
        await expectRejected(
          c,
          "execute_graphql",
          {
            query:
              'mutation { mergeRequestAccept(input: {projectPath: "g/p", iid: "7"}) { errors } }',
          },
          NOT_ALLOWED_TOOL
        );
        await expectRejected(
          c,
          "create_pipeline",
          { project_id: PROJECT, ref: "main" },
          NOT_ALLOWED_TOOL
        );
        await expectRejected(
          c,
          "create_issue",
          { project_id: PROJECT, title: "x" },
          NOT_ALLOWED_TOOL
        );
      });
    });

    test("disabled tools cannot be activated through dynamic discovery", async () => {
      await withClient(server, async c => {
        await expectRejected(c, "discover_tools", {}, NOT_ALLOWED_TOOL);
        await expectRejected(c, "discover_tools", { category: "merge-requests" }, NOT_ALLOWED_TOOL);
        const names = (await c.listTools()).tools.map(t => t.name);
        assert.ok(!names.includes("merge_merge_request"));
        assert.ok(!names.includes("discover_tools"));
        await expectRejected(
          c,
          "merge_merge_request",
          { project_id: PROJECT, merge_request_iid: 7 },
          NOT_ALLOWED_TOOL
        );
      });
    });
  });

  describe("upstream behaviour without HOLMES_WRITE_POLICY", { concurrency: 1 }, () => {
    let server: ServerInstance;

    before(async () => {
      server = await launchMcpServer();
    });

    test("the flag is opt-in: unrestricted tools are listed and writes to main reach GitLab", async () => {
      hits = [];
      await withClient(server, async c => {
        const names = (await c.listTools()).tools.map(t => t.name);
        assert.ok(names.includes("delete_branch"));
        assert.ok(names.includes("merge_merge_request"));
        const result = await c.callTool("create_branch", {
          project_id: PROJECT,
          branch: "not-holmes",
          ref: "main",
        });
        assert.ok(!result.isError, resultText(result));
      });
      assert.strictEqual(mutations()[0]?.body.branch, "not-holmes");
    });
  });
});
