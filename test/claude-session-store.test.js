const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  ClaudeSessionStore,
  encodeClaudeItemId,
  decodeClaudeItemId,
  isClaudeItemId
} = require("../src/claude-session-store");

async function createTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "session-hub-claude-"));
}

async function writeClaudeSession(projectDir, sessionId, lines) {
  await fs.mkdir(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  await fs.writeFile(filePath, lines.join("\n") + "\n", "utf8");
  return filePath;
}

function userLine(sessionId, content, extra = {}) {
  return JSON.stringify({
    type: "user",
    sessionId,
    message: { role: "user", content },
    timestamp: new Date().toISOString(),
    ...extra
  });
}

function assistantLine(sessionId) {
  return JSON.stringify({
    type: "assistant",
    sessionId,
    message: { role: "assistant", content: [{ type: "text", text: "Sure." }] },
    timestamp: new Date().toISOString()
  });
}

test("encodeClaudeItemId and decodeClaudeItemId round-trip", () => {
  const sessionId = "abc-123-def";
  const encoded = encodeClaudeItemId(sessionId);
  assert.equal(decodeClaudeItemId(encoded), sessionId);
});

test("isClaudeItemId distinguishes Claude from Codex ids", () => {
  const claudeId = encodeClaudeItemId("some-session");
  const codexId = Buffer.from("sessions/2026/02/08/rollout.jsonl", "utf8").toString("base64url");
  assert.equal(isClaudeItemId(claudeId), true);
  assert.equal(isClaudeItemId(codexId), false);
});

test("listSessions discovers sessions across project directories", async () => {
  const claudeHome = await createTempDir();
  const projectDir = path.join(claudeHome, "projects", "-Users-test-myproject");

  await writeClaudeSession(projectDir, "sess-aaa", [
    userLine("sess-aaa", "Hello world", { gitBranch: "main" }),
    assistantLine("sess-aaa")
  ]);

  await writeClaudeSession(projectDir, "sess-bbb", [
    userLine("sess-bbb", "Fix the bug"),
    assistantLine("sess-bbb")
  ]);

  const store = new ClaudeSessionStore({ claudeHome });
  const result = await store.listSessions();

  assert.equal(result.counts.total, 2);
  assert.equal(result.items.length, 2);

  const sessA = result.items.find((item) => item.threadId === "sess-aaa");
  const sessB = result.items.find((item) => item.threadId === "sess-bbb");

  assert.ok(sessA);
  assert.ok(sessB);
  assert.equal(sessA.title, "Hello world");
  assert.equal(sessA.provider, "claude");
  assert.equal(sessA.state, "active");
  assert.equal(sessA.gitBranch, "main");
  assert.equal(sessA.projectName, "/Users/test/myproject");
  assert.equal(sessB.title, "Fix the bug");

  await fs.rm(claudeHome, { recursive: true, force: true });
});

test("listSessions returns empty when no projects directory", async () => {
  const claudeHome = await createTempDir();
  const store = new ClaudeSessionStore({ claudeHome });
  const result = await store.listSessions();

  assert.equal(result.counts.total, 0);
  assert.equal(result.items.length, 0);

  await fs.rm(claudeHome, { recursive: true, force: true });
});

test("listSessions skips non-jsonl files", async () => {
  const claudeHome = await createTempDir();
  const projectDir = path.join(claudeHome, "projects", "-Users-test-proj");

  await writeClaudeSession(projectDir, "sess-ccc", [
    userLine("sess-ccc", "Real session")
  ]);

  // Write a non-jsonl file
  await fs.writeFile(path.join(projectDir, "notes.txt"), "not a session", "utf8");
  // Write a subdirectory (should be skipped)
  await fs.mkdir(path.join(projectDir, "subdir"), { recursive: true });

  const store = new ClaudeSessionStore({ claudeHome });
  const result = await store.listSessions();

  assert.equal(result.counts.total, 1);
  assert.equal(result.items[0].threadId, "sess-ccc");

  await fs.rm(claudeHome, { recursive: true, force: true });
});

test("findItemsByIds returns found and missing", async () => {
  const claudeHome = await createTempDir();
  const projectDir = path.join(claudeHome, "projects", "-Users-test-proj2");

  await writeClaudeSession(projectDir, "sess-ddd", [
    userLine("sess-ddd", "Find me")
  ]);

  const store = new ClaudeSessionStore({ claudeHome });
  const validId = encodeClaudeItemId("sess-ddd");
  const invalidId = encodeClaudeItemId("sess-nonexistent");

  const result = await store.findItemsByIds([validId, invalidId]);
  assert.equal(result.found.length, 1);
  assert.equal(result.missing.length, 1);
  assert.equal(result.found[0].threadId, "sess-ddd");
  assert.equal(result.missing[0], invalidId);

  await fs.rm(claudeHome, { recursive: true, force: true });
});

test("listSessions falls back to Untitled for empty sessions", async () => {
  const claudeHome = await createTempDir();
  const projectDir = path.join(claudeHome, "projects", "-Users-test-proj3");

  // Session with no user message, only a progress line
  await writeClaudeSession(projectDir, "sess-empty", [
    JSON.stringify({ type: "progress", sessionId: "sess-empty", timestamp: new Date().toISOString() })
  ]);

  const store = new ClaudeSessionStore({ claudeHome });
  const result = await store.listSessions();

  assert.equal(result.counts.total, 1);
  assert.equal(result.items[0].title, "Untitled sess-emp");

  await fs.rm(claudeHome, { recursive: true, force: true });
});

test("listSessions discovers sessions from multiple projects", async () => {
  const claudeHome = await createTempDir();
  const projA = path.join(claudeHome, "projects", "-Users-test-projA");
  const projB = path.join(claudeHome, "projects", "-Users-test-projB");

  await writeClaudeSession(projA, "sess-pa", [userLine("sess-pa", "Project A session")]);
  await writeClaudeSession(projB, "sess-pb", [userLine("sess-pb", "Project B session")]);

  const store = new ClaudeSessionStore({ claudeHome });
  const result = await store.listSessions();

  assert.equal(result.counts.total, 2);
  const projects = result.items.map((item) => item.projectName).sort();
  assert.deepEqual(projects, ["/Users/test/projA", "/Users/test/projB"]);

  await fs.rm(claudeHome, { recursive: true, force: true });
});

test("archive and unarchive move Claude sessions between directories", async () => {
  const claudeHome = await createTempDir();
  const projectDir = path.join(claudeHome, "projects", "-Users-test-myproject");

  await writeClaudeSession(projectDir, "sess-arc", [
    userLine("sess-arc", "Archive me", { gitBranch: "main" })
  ]);

  const store = new ClaudeSessionStore({ claudeHome });

  // Verify initial state
  let result = await store.listSessions();
  assert.equal(result.counts.total, 1);
  assert.equal(result.counts.active, 1);
  assert.equal(result.counts.archived, 0);
  assert.equal(result.items[0].state, "active");

  // Archive the session
  const archiveResult = await store.archiveItem(result.items[0]);
  assert.ok(archiveResult.from);
  assert.ok(archiveResult.to);
  assert.ok(archiveResult.to.includes("archived_sessions"));

  // Verify it moved to archived
  result = await store.listSessions();
  assert.equal(result.counts.total, 1);
  assert.equal(result.counts.active, 0);
  assert.equal(result.counts.archived, 1);
  assert.equal(result.items[0].state, "archived");
  assert.equal(result.items[0].projectName, "/Users/test/myproject");

  // Unarchive it back
  const unarchiveResult = await store.unarchiveItem(result.items[0]);
  assert.ok(unarchiveResult.from);
  assert.ok(unarchiveResult.to);
  assert.ok(unarchiveResult.to.includes("projects"));

  // Verify it's active again
  result = await store.listSessions();
  assert.equal(result.counts.total, 1);
  assert.equal(result.counts.active, 1);
  assert.equal(result.counts.archived, 0);
  assert.equal(result.items[0].state, "active");

  await fs.rm(claudeHome, { recursive: true, force: true });
});

test("archiveItem rejects already archived session", async () => {
  const claudeHome = await createTempDir();
  const archivedDir = path.join(claudeHome, "archived_sessions", "-Users-test-proj");

  await writeClaudeSession(archivedDir, "sess-already", [
    userLine("sess-already", "Already archived")
  ]);

  const store = new ClaudeSessionStore({ claudeHome });
  const result = await store.listSessions();
  assert.equal(result.items[0].state, "archived");

  await assert.rejects(
    () => store.archiveItem(result.items[0]),
    { message: "only active sessions can be archived" }
  );

  await fs.rm(claudeHome, { recursive: true, force: true });
});

test("unarchiveItem rejects active session", async () => {
  const claudeHome = await createTempDir();
  const projectDir = path.join(claudeHome, "projects", "-Users-test-proj");

  await writeClaudeSession(projectDir, "sess-active", [
    userLine("sess-active", "Still active")
  ]);

  const store = new ClaudeSessionStore({ claudeHome });
  const result = await store.listSessions();
  assert.equal(result.items[0].state, "active");

  await assert.rejects(
    () => store.unarchiveItem(result.items[0]),
    { message: "only archived sessions can be restored to active" }
  );

  await fs.rm(claudeHome, { recursive: true, force: true });
});

test("listSessions merges active and archived Claude sessions", async () => {
  const claudeHome = await createTempDir();
  const projectDir = path.join(claudeHome, "projects", "-Users-test-proj");
  const archivedDir = path.join(claudeHome, "archived_sessions", "-Users-test-proj");

  await writeClaudeSession(projectDir, "sess-active", [
    userLine("sess-active", "Active session")
  ]);
  await writeClaudeSession(archivedDir, "sess-old", [
    userLine("sess-old", "Old session")
  ]);

  const store = new ClaudeSessionStore({ claudeHome });
  const result = await store.listSessions();

  assert.equal(result.counts.total, 2);
  assert.equal(result.counts.active, 1);
  assert.equal(result.counts.archived, 1);

  const active = result.items.find((i) => i.threadId === "sess-active");
  const archived = result.items.find((i) => i.threadId === "sess-old");
  assert.equal(active.state, "active");
  assert.equal(archived.state, "archived");

  await fs.rm(claudeHome, { recursive: true, force: true });
});
