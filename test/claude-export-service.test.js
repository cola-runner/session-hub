const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ClaudeSessionStore, encodeClaudeItemId } = require("../src/claude-session-store");
const { exportClaudeSessions } = require("../src/claude-export-service");

async function createTempDir(prefix = "session-hub-export-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeClaudeSession(projectDir, sessionId, lines) {
  await fs.mkdir(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function userTextLine(sessionId, content, timestamp) {
  return JSON.stringify({
    type: "user",
    sessionId,
    timestamp,
    message: {
      role: "user",
      content
    }
  });
}

function assistantToolLine(sessionId, command, timestamp) {
  return JSON.stringify({
    type: "assistant",
    sessionId,
    timestamp,
    message: {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: `toolu-${sessionId}`,
        name: "Bash",
        input: { command }
      }]
    }
  });
}

function toolResultLine(sessionId, toolUseId, content, isError, timestamp) {
  return JSON.stringify({
    type: "user",
    sessionId,
    timestamp,
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: toolUseId,
        content,
        is_error: isError
      }]
    }
  });
}

test("exportClaudeSessions exports multiple selected sessions", async () => {
  const claudeHome = await createTempDir("session-hub-export-claude-");
  const exportRoot = await createTempDir("session-hub-export-output-");
  const projectA = path.join(claudeHome, "projects", "-Users-test-projA");
  const projectB = path.join(claudeHome, "projects", "-Users-test-projB");

  await writeClaudeSession(projectA, "sess-a", [
    userTextLine("sess-a", "Build export flow", "2026-03-02T10:00:00.000Z"),
    assistantToolLine("sess-a", "npm test", "2026-03-02T10:00:10.000Z"),
    toolResultLine("sess-a", "toolu-sess-a", "tests passed", false, "2026-03-02T10:00:15.000Z")
  ]);
  await writeClaudeSession(projectB, "sess-b", [
    userTextLine("sess-b", "Need migration summary", "2026-03-02T11:00:00.000Z"),
    assistantToolLine("sess-b", "git status", "2026-03-02T11:00:08.000Z")
  ]);

  const claudeStore = new ClaudeSessionStore({ claudeHome });
  const listed = await claudeStore.listSessions();
  const itemIds = listed.items.map((item) => item.itemId);

  const exported = await exportClaudeSessions({
    itemIds,
    ownershipConfirmed: true,
    includeSubagents: true,
    compression: "three-layer",
    budgetStrategy: "layered-trim",
    claudeHome,
    exportRoot,
    claudeStore
  });

  assert.equal(exported.stats.sessionCount, 2);
  assert.ok(await pathExists(exported.files.promptMarkdown));
  assert.ok(await pathExists(exported.files.contextJson));
  assert.ok(await pathExists(exported.files.rawJsonl));
  assert.ok(await pathExists(exported.files.manifest));
  assert.ok(await pathExists(exported.files.overflow));

  const prompt = await fs.readFile(exported.files.promptMarkdown, "utf8");
  assert.match(prompt, /L1: Quick Continuation Summary/);
  assert.match(prompt, /L2: Engineering Context/);
  assert.match(prompt, /L3: Evidence Index/);
  assert.match(prompt, /Start Prompt For Codex/);

  await fs.rm(claudeHome, { recursive: true, force: true });
  await fs.rm(exportRoot, { recursive: true, force: true });
});

test("exportClaudeSessions supports single-session export", async () => {
  const claudeHome = await createTempDir("session-hub-export-single-");
  const exportRoot = await createTempDir("session-hub-export-single-out-");
  const project = path.join(claudeHome, "projects", "-Users-test-single");
  await writeClaudeSession(project, "sess-single", [
    userTextLine("sess-single", "Migrate this one session", "2026-03-02T12:00:00.000Z"),
    assistantToolLine("sess-single", "npm run build", "2026-03-02T12:01:00.000Z")
  ]);

  const claudeStore = new ClaudeSessionStore({ claudeHome });
  const exported = await exportClaudeSessions({
    itemIds: [encodeClaudeItemId("sess-single")],
    ownershipConfirmed: true,
    claudeHome,
    exportRoot,
    claudeStore
  });

  assert.equal(exported.stats.sessionCount, 1);
  assert.equal(exported.stats.eventCount > 0, true);

  await fs.rm(claudeHome, { recursive: true, force: true });
  await fs.rm(exportRoot, { recursive: true, force: true });
});

test("exportClaudeSessions ignores interrupted placeholders when deriving the goal", async () => {
  const claudeHome = await createTempDir("session-hub-export-summary-");
  const exportRoot = await createTempDir("session-hub-export-summary-out-");
  const project = path.join(claudeHome, "projects", "-Users-test-summary");
  await writeClaudeSession(project, "sess-summary", [
    userTextLine("sess-summary", "Ship the real migration fix", "2026-03-02T12:00:00.000Z"),
    JSON.stringify({
      type: "user",
      sessionId: "sess-summary",
      timestamp: "2026-03-02T12:05:00.000Z",
      message: {
        role: "user",
        content: [{
          type: "text",
          text: "[Request interrupted by user for tool use]"
        }]
      }
    })
  ]);

  const claudeStore = new ClaudeSessionStore({ claudeHome });
  const exported = await exportClaudeSessions({
    itemIds: [encodeClaudeItemId("sess-summary")],
    ownershipConfirmed: true,
    claudeHome,
    exportRoot,
    claudeStore
  });

  assert.match(exported.promptText, /Goal: Ship the real migration fix/);
  assert.doesNotMatch(exported.promptText, /Goal: \[Request interrupted by user for tool use\]/);

  await fs.rm(claudeHome, { recursive: true, force: true });
  await fs.rm(exportRoot, { recursive: true, force: true });
});

test("exportClaudeSessions rejects non-claude item id", async () => {
  const claudeHome = await createTempDir("session-hub-export-invalid-");
  const exportRoot = await createTempDir("session-hub-export-invalid-out-");
  const claudeStore = new ClaudeSessionStore({ claudeHome });
  const codexLikeId = Buffer.from(
    "sessions/2026/03/03/rollout-2026-03-03T00-00-00-x.jsonl",
    "utf8"
  ).toString("base64url");

  await assert.rejects(
    () =>
      exportClaudeSessions({
        itemIds: [codexLikeId],
        ownershipConfirmed: true,
        claudeHome,
        exportRoot,
        claudeStore
      }),
    /not a Claude session id/
  );

  await fs.rm(claudeHome, { recursive: true, force: true });
  await fs.rm(exportRoot, { recursive: true, force: true });
});

test("exportClaudeSessions rejects when ownership is not confirmed", async () => {
  const claudeHome = await createTempDir("session-hub-export-own-");
  const exportRoot = await createTempDir("session-hub-export-own-out-");
  const project = path.join(claudeHome, "projects", "-Users-test-own");
  await writeClaudeSession(project, "sess-own", [
    userTextLine("sess-own", "Hello", "2026-03-02T13:00:00.000Z")
  ]);

  const claudeStore = new ClaudeSessionStore({ claudeHome });
  const before = await fs.readdir(exportRoot);

  await assert.rejects(
    () =>
      exportClaudeSessions({
        itemIds: [encodeClaudeItemId("sess-own")],
        ownershipConfirmed: false,
        claudeHome,
        exportRoot,
        claudeStore
      }),
    /ownership confirmation is required/
  );

  const after = await fs.readdir(exportRoot);
  assert.deepEqual(after, before);

  await fs.rm(claudeHome, { recursive: true, force: true });
  await fs.rm(exportRoot, { recursive: true, force: true });
});

test("exportClaudeSessions includes subagent files and preserves order", async () => {
  const claudeHome = await createTempDir("session-hub-export-sub-");
  const exportRoot = await createTempDir("session-hub-export-sub-out-");
  const project = path.join(claudeHome, "projects", "-Users-test-sub");
  const sessionFile = await writeClaudeSession(project, "sess-sub", [
    userTextLine("sess-sub", "Main task", "2026-03-02T14:00:00.000Z"),
    assistantToolLine("sess-sub", "npm test", "2026-03-02T14:00:05.000Z")
  ]);

  const subagentDir = path.join(path.dirname(sessionFile), "subagents");
  await fs.mkdir(subagentDir, { recursive: true });
  await fs.writeFile(
    path.join(subagentDir, "agent-aaa.jsonl"),
    `${JSON.stringify({
      type: "assistant",
      sessionId: "agent-aaa",
      timestamp: "2026-03-02T13:59:59.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "subagent prep" }] }
    })}\n`,
    "utf8"
  );

  const claudeStore = new ClaudeSessionStore({ claudeHome });
  const exported = await exportClaudeSessions({
    itemIds: [encodeClaudeItemId("sess-sub")],
    ownershipConfirmed: true,
    includeSubagents: true,
    claudeHome,
    exportRoot,
    claudeStore
  });

  const raw = await fs.readFile(exported.files.rawJsonl, "utf8");
  assert.match(raw, /subagents\/agent-aaa\.jsonl/);

  await fs.rm(claudeHome, { recursive: true, force: true });
  await fs.rm(exportRoot, { recursive: true, force: true });
});

test("exportClaudeSessions tolerates bad JSONL lines and records warnings", async () => {
  const claudeHome = await createTempDir("session-hub-export-warn-");
  const exportRoot = await createTempDir("session-hub-export-warn-out-");
  const project = path.join(claudeHome, "projects", "-Users-test-warn");
  await fs.mkdir(project, { recursive: true });
  const sessionPath = path.join(project, "sess-warn.jsonl");
  await fs.writeFile(
    sessionPath,
    `${userTextLine("sess-warn", "Start", "2026-03-02T15:00:00.000Z")}\n` +
      "{bad json}\n" +
      `${assistantToolLine("sess-warn", "echo done", "2026-03-02T15:00:03.000Z")}\n`,
    "utf8"
  );

  const claudeStore = new ClaudeSessionStore({ claudeHome });
  const exported = await exportClaudeSessions({
    itemIds: [encodeClaudeItemId("sess-warn")],
    ownershipConfirmed: true,
    claudeHome,
    exportRoot,
    claudeStore
  });

  const manifest = JSON.parse(await fs.readFile(exported.files.manifest, "utf8"));
  assert.equal(manifest.parseWarnings.length > 0, true);

  await fs.rm(claudeHome, { recursive: true, force: true });
  await fs.rm(exportRoot, { recursive: true, force: true });
});

test("exportClaudeSessions generates overflow evidence for large sessions", async () => {
  const claudeHome = await createTempDir("session-hub-export-big-");
  const exportRoot = await createTempDir("session-hub-export-big-out-");
  const project = path.join(claudeHome, "projects", "-Users-test-big");
  const lines = [];
  for (let index = 0; index < 300; index += 1) {
    const t = `2026-03-02T16:${String(index % 60).padStart(2, "0")}:00.000Z`;
    lines.push(userTextLine("sess-big", `Task item ${index} with context ${"x".repeat(80)}`, t));
  }
  await writeClaudeSession(project, "sess-big", lines);

  const claudeStore = new ClaudeSessionStore({ claudeHome });
  const exported = await exportClaudeSessions({
    itemIds: [encodeClaudeItemId("sess-big")],
    ownershipConfirmed: true,
    claudeHome,
    exportRoot,
    claudeStore
  });

  assert.equal(exported.stats.overflowEvidenceCount > 0, true);
  const overflow = await fs.readFile(exported.files.overflow, "utf8");
  assert.match(overflow, /Overflow Evidence/);

  await fs.rm(claudeHome, { recursive: true, force: true });
  await fs.rm(exportRoot, { recursive: true, force: true });
});

test("exportClaudeSessions can hand off directly to a Codex thread", async () => {
  const claudeHome = await createTempDir("session-hub-export-handoff-");
  const exportRoot = await createTempDir("session-hub-export-handoff-out-");
  const project = path.join(claudeHome, "projects", "-Users-test-handoff");
  await writeClaudeSession(project, "sess-handoff", [
    userTextLine("sess-handoff", "Continue here", "2026-03-02T17:00:00.000Z")
  ]);

  const handoffWorkspace = path.join(exportRoot, "handoff-workspace");
  await fs.mkdir(handoffWorkspace, { recursive: true });

  const handoffCalls = [];
  const claudeStore = new ClaudeSessionStore({ claudeHome });
  const exported = await exportClaudeSessions({
    itemIds: [encodeClaudeItemId("sess-handoff")],
    ownershipConfirmed: true,
    handoffToCodex: true,
    launchCodexApp: true,
    restartCodexApp: true,
    handoffCwd: handoffWorkspace,
    handoffFn: async (payload) => {
      handoffCalls.push(payload);
      return {
        threadId: "thread-handoff-1",
        turnId: "turn-handoff-1",
        launchedCodexApp: true,
        restartedCodexApp: true,
        userMessageNotificationSeen: true
      };
    },
    claudeHome,
    exportRoot,
    claudeStore
  });

  assert.equal(handoffCalls.length, 1);
  assert.equal(handoffCalls[0].cwd, handoffWorkspace);
  assert.equal(handoffCalls[0].restartCodexApp, true);
  assert.match(handoffCalls[0].prompt, /## Goal/);
  assert.doesNotMatch(handoffCalls[0].prompt, /Start Prompt For Codex/);
  assert.equal(handoffCalls[0].threadName.length > 0, true);
  assert.equal(exported.codexHandoff.ok, true);
  assert.equal(exported.codexHandoff.threadId, "thread-handoff-1");
  assert.equal(exported.codexHandoff.threadName, handoffCalls[0].threadName);
  assert.equal(exported.codexHandoff.restartedCodexApp, true);
  assert.equal(exported.codexHandoff.mode, "inline-pack");
  assert.equal(exported.codexHandoff.trimmed, false);
  assert.equal(exported.codexHandoff.inlineChars > 0, true);

  await fs.rm(claudeHome, { recursive: true, force: true });
  await fs.rm(exportRoot, { recursive: true, force: true });
});

test("exportClaudeSessions trims oversized inline handoff packs", async () => {
  const claudeHome = await createTempDir("session-hub-export-inline-trim-");
  const exportRoot = await createTempDir("session-hub-export-inline-trim-out-");
  const project = path.join(claudeHome, "projects", "-Users-test-inline-trim");
  const lines = [];
  for (let index = 0; index < 420; index += 1) {
    const minute = String(index % 60).padStart(2, "0");
    const second = String(index % 60).padStart(2, "0");
    lines.push(userTextLine(
      "sess-inline-trim",
      `Large context item ${index} ${"x".repeat(180)}`,
      `2026-03-02T17:${minute}:${second}.000Z`
    ));
  }
  await writeClaudeSession(project, "sess-inline-trim", lines);

  const handoffCalls = [];
  const claudeStore = new ClaudeSessionStore({ claudeHome });
  const exported = await exportClaudeSessions({
    itemIds: [encodeClaudeItemId("sess-inline-trim")],
    ownershipConfirmed: true,
    handoffToCodex: true,
    handoffFn: async (payload) => {
      handoffCalls.push(payload);
      return {
        threadId: "thread-inline-trim",
        turnId: "turn-inline-trim",
        launchedCodexApp: false,
        userMessageNotificationSeen: true
      };
    },
    claudeHome,
    exportRoot,
    claudeStore
  });

  assert.equal(handoffCalls.length, 1);
  assert.equal(exported.codexHandoff.ok, true);
  assert.equal(exported.codexHandoff.mode, "inline-pack");
  assert.equal(exported.codexHandoff.trimmed, true);
  assert.equal(exported.codexHandoff.inlineChars <= 8000, true);
  assert.equal(handoffCalls[0].trimmed, true);
  assert.equal(handoffCalls[0].inlineChars <= 8000, true);

  await fs.rm(claudeHome, { recursive: true, force: true });
  await fs.rm(exportRoot, { recursive: true, force: true });
});

test("exportClaudeSessions still succeeds when Codex handoff fails", async () => {
  const claudeHome = await createTempDir("session-hub-export-handoff-fail-");
  const exportRoot = await createTempDir("session-hub-export-handoff-fail-out-");
  const project = path.join(claudeHome, "projects", "-Users-test-handoff-fail");
  await writeClaudeSession(project, "sess-handoff-fail", [
    userTextLine("sess-handoff-fail", "Continue after failure", "2026-03-02T18:00:00.000Z")
  ]);

  const claudeStore = new ClaudeSessionStore({ claudeHome });
  const exported = await exportClaudeSessions({
    itemIds: [encodeClaudeItemId("sess-handoff-fail")],
    ownershipConfirmed: true,
    handoffToCodex: true,
    handoffFn: async () => {
      throw new Error("mock handoff failure");
    },
    claudeHome,
    exportRoot,
    claudeStore
  });

  assert.equal(exported.codexHandoff.ok, false);
  assert.match(exported.codexHandoff.error, /mock handoff failure/);
  assert.ok(await pathExists(exported.files.promptMarkdown));
  assert.equal(exported.codexHandoff.mode, "inline-pack");

  await fs.rm(claudeHome, { recursive: true, force: true });
  await fs.rm(exportRoot, { recursive: true, force: true });
});

test("exportClaudeSessions infers handoff cwd from Claude raw records", async () => {
  const claudeHome = await createTempDir("session-hub-export-infer-cwd-");
  const exportRoot = await createTempDir("session-hub-export-infer-cwd-out-");
  const project = path.join(claudeHome, "projects", "-Users-test-infer-cwd");
  const inferredWorkspace = path.join(exportRoot, "workspace-inferred");
  await fs.mkdir(inferredWorkspace, { recursive: true });

  await writeClaudeSession(project, "sess-infer-cwd", [
    JSON.stringify({
      type: "user",
      sessionId: "sess-infer-cwd",
      timestamp: "2026-03-02T19:00:00.000Z",
      cwd: inferredWorkspace,
      message: {
        role: "user",
        content: "Continue from inferred cwd"
      }
    })
  ]);

  const calls = [];
  const claudeStore = new ClaudeSessionStore({ claudeHome });
  const exported = await exportClaudeSessions({
    itemIds: [encodeClaudeItemId("sess-infer-cwd")],
    ownershipConfirmed: true,
    handoffToCodex: true,
    handoffFn: async (payload) => {
      calls.push(payload);
      return {
        threadId: "thread-infer-cwd",
        turnId: "turn-infer-cwd",
        launchedCodexApp: false,
        userMessageNotificationSeen: true
      };
    },
    claudeHome,
    exportRoot,
    claudeStore
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, inferredWorkspace);
  assert.equal(exported.codexHandoff.ok, true);
  assert.equal(exported.codexHandoff.cwd, inferredWorkspace);

  await fs.rm(claudeHome, { recursive: true, force: true });
  await fs.rm(exportRoot, { recursive: true, force: true });
});

test("exportClaudeSessions falls back to nearest existing ancestor for missing cwd", async () => {
  const claudeHome = await createTempDir("session-hub-export-ancestor-cwd-");
  const exportRoot = await createTempDir("session-hub-export-ancestor-cwd-out-");
  const project = path.join(claudeHome, "projects", "-Users-test-ancestor-cwd");
  const existingRoot = path.join(exportRoot, "existing-root");
  const missingLeaf = path.join(existingRoot, "missing", "project-dir");
  await fs.mkdir(existingRoot, { recursive: true });

  await writeClaudeSession(project, "sess-ancestor-cwd", [
    JSON.stringify({
      type: "user",
      sessionId: "sess-ancestor-cwd",
      timestamp: "2026-03-02T20:00:00.000Z",
      cwd: missingLeaf,
      message: {
        role: "user",
        content: "Use ancestor fallback"
      }
    })
  ]);

  const calls = [];
  const claudeStore = new ClaudeSessionStore({ claudeHome });
  const exported = await exportClaudeSessions({
    itemIds: [encodeClaudeItemId("sess-ancestor-cwd")],
    ownershipConfirmed: true,
    handoffToCodex: true,
    handoffFn: async (payload) => {
      calls.push(payload);
      return {
        threadId: "thread-ancestor-cwd",
        turnId: "turn-ancestor-cwd",
        launchedCodexApp: false,
        userMessageNotificationSeen: true
      };
    },
    claudeHome,
    exportRoot,
    claudeStore
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, existingRoot);
  assert.equal(exported.codexHandoff.cwd, existingRoot);

  await fs.rm(claudeHome, { recursive: true, force: true });
  await fs.rm(exportRoot, { recursive: true, force: true });
});
