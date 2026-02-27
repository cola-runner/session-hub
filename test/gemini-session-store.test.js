const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  GeminiSessionStore,
  encodeGeminiItemId,
  decodeGeminiItemId,
  isGeminiItemId
} = require("../src/gemini-session-store");

async function createTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "session-hub-gemini-"));
}

function makeGeminiSession({ sessionId, projectHash, startTime, lastUpdated, summary, messages }) {
  return JSON.stringify({
    sessionId,
    projectHash,
    startTime: startTime || new Date().toISOString(),
    lastUpdated: lastUpdated || new Date().toISOString(),
    ...(summary ? { summary } : {}),
    messages: messages || []
  });
}

async function writeGeminiSession(chatsDir, fileName, content) {
  await fs.mkdir(chatsDir, { recursive: true });
  const filePath = path.join(chatsDir, fileName);
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

test("encodeGeminiItemId and decodeGeminiItemId round-trip", () => {
  const sessionId = "abc-123-def";
  const encoded = encodeGeminiItemId(sessionId);
  assert.equal(decodeGeminiItemId(encoded), sessionId);
});

test("isGeminiItemId distinguishes Gemini from other ids", () => {
  const geminiId = encodeGeminiItemId("some-session");
  const claudeId = Buffer.from("claude:some-session", "utf8").toString("base64url");
  const codexId = Buffer.from("sessions/2026/02/08/rollout.jsonl", "utf8").toString("base64url");
  assert.equal(isGeminiItemId(geminiId), true);
  assert.equal(isGeminiItemId(claudeId), false);
  assert.equal(isGeminiItemId(codexId), false);
});

test("listSessions discovers sessions across project hash dirs", async () => {
  const geminiHome = await createTempDir();
  const hash1 = "aaa111";
  const hash2 = "bbb222";
  const chats1 = path.join(geminiHome, "tmp", hash1, "chats");
  const chats2 = path.join(geminiHome, "tmp", hash2, "chats");

  await writeGeminiSession(chats1, "session-2025-10-21T08-53-abc123.json", makeGeminiSession({
    sessionId: "sess-aaa",
    projectHash: hash1,
    summary: "Fix login bug",
    messages: [
      { type: "user", content: "Fix the login" },
      { type: "gemini", content: "Done." }
    ]
  }));

  await writeGeminiSession(chats2, "session-2025-10-22T09-00-def456.json", makeGeminiSession({
    sessionId: "sess-bbb",
    projectHash: hash2,
    messages: [
      { type: "user", content: "Add dark mode" }
    ]
  }));

  const store = new GeminiSessionStore({ geminiHome });
  const result = await store.listSessions();

  assert.equal(result.counts.total, 2);
  assert.equal(result.items.length, 2);

  const sessA = result.items.find((item) => item.threadId === "sess-aaa");
  const sessB = result.items.find((item) => item.threadId === "sess-bbb");

  assert.ok(sessA);
  assert.ok(sessB);
  assert.equal(sessA.title, "Fix login bug");
  assert.equal(sessA.provider, "gemini");
  assert.equal(sessA.state, "active");
  assert.equal(sessA.projectHash, hash1);
  assert.equal(sessA.messageCount, 2);
  assert.equal(sessB.title, "Add dark mode");
  assert.equal(sessB.messageCount, 1);

  await fs.rm(geminiHome, { recursive: true, force: true });
});

test("listSessions returns empty when no tmp directory", async () => {
  const geminiHome = await createTempDir();
  const store = new GeminiSessionStore({ geminiHome });
  const result = await store.listSessions();

  assert.equal(result.counts.total, 0);
  assert.equal(result.items.length, 0);

  await fs.rm(geminiHome, { recursive: true, force: true });
});

test("listSessions skips non-session files", async () => {
  const geminiHome = await createTempDir();
  const chatsDir = path.join(geminiHome, "tmp", "hash1", "chats");

  await writeGeminiSession(chatsDir, "session-2025-10-21T08-53-abc123.json", makeGeminiSession({
    sessionId: "sess-real",
    projectHash: "hash1",
    messages: [{ type: "user", content: "Hello" }]
  }));

  // Non-session files that should be skipped
  await fs.writeFile(path.join(chatsDir, "notes.txt"), "not a session", "utf8");
  await fs.writeFile(path.join(chatsDir, "data.json"), "{}", "utf8");

  const store = new GeminiSessionStore({ geminiHome });
  const result = await store.listSessions();

  assert.equal(result.counts.total, 1);
  assert.equal(result.items[0].threadId, "sess-real");

  await fs.rm(geminiHome, { recursive: true, force: true });
});

test("archive and unarchive round-trip", async () => {
  const geminiHome = await createTempDir();
  const chatsDir = path.join(geminiHome, "tmp", "hash1", "chats");

  await writeGeminiSession(chatsDir, "session-2025-10-21T08-53-abc123.json", makeGeminiSession({
    sessionId: "sess-arc",
    projectHash: "hash1",
    messages: [{ type: "user", content: "Archive me" }]
  }));

  const store = new GeminiSessionStore({ geminiHome });

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

  // Unarchive it back
  const unarchiveResult = await store.unarchiveItem(result.items[0]);
  assert.ok(unarchiveResult.from);
  assert.ok(unarchiveResult.to);
  assert.ok(unarchiveResult.to.includes("tmp"));

  // Verify it's active again
  result = await store.listSessions();
  assert.equal(result.counts.total, 1);
  assert.equal(result.counts.active, 1);
  assert.equal(result.counts.archived, 0);
  assert.equal(result.items[0].state, "active");

  await fs.rm(geminiHome, { recursive: true, force: true });
});

test("findItemsByIds returns found and missing", async () => {
  const geminiHome = await createTempDir();
  const chatsDir = path.join(geminiHome, "tmp", "hash1", "chats");

  await writeGeminiSession(chatsDir, "session-2025-10-21T08-53-abc123.json", makeGeminiSession({
    sessionId: "sess-find",
    projectHash: "hash1",
    messages: [{ type: "user", content: "Find me" }]
  }));

  const store = new GeminiSessionStore({ geminiHome });
  const validId = encodeGeminiItemId("sess-find");
  const invalidId = encodeGeminiItemId("sess-nonexistent");

  const result = await store.findItemsByIds([validId, invalidId]);
  assert.equal(result.found.length, 1);
  assert.equal(result.missing.length, 1);
  assert.equal(result.found[0].threadId, "sess-find");
  assert.equal(result.missing[0], invalidId);

  await fs.rm(geminiHome, { recursive: true, force: true });
});

test("archiveItem rejects already archived session", async () => {
  const geminiHome = await createTempDir();
  const archivedChats = path.join(geminiHome, "archived_sessions", "hash1", "chats");

  await writeGeminiSession(archivedChats, "session-2025-10-21T08-53-abc123.json", makeGeminiSession({
    sessionId: "sess-already",
    projectHash: "hash1",
    messages: [{ type: "user", content: "Already archived" }]
  }));

  const store = new GeminiSessionStore({ geminiHome });
  const result = await store.listSessions();
  assert.equal(result.items[0].state, "archived");

  await assert.rejects(
    () => store.archiveItem(result.items[0]),
    { message: "only active sessions can be archived" }
  );

  await fs.rm(geminiHome, { recursive: true, force: true });
});

test("unarchiveItem rejects active session", async () => {
  const geminiHome = await createTempDir();
  const chatsDir = path.join(geminiHome, "tmp", "hash1", "chats");

  await writeGeminiSession(chatsDir, "session-2025-10-21T08-53-abc123.json", makeGeminiSession({
    sessionId: "sess-active",
    projectHash: "hash1",
    messages: [{ type: "user", content: "Still active" }]
  }));

  const store = new GeminiSessionStore({ geminiHome });
  const result = await store.listSessions();
  assert.equal(result.items[0].state, "active");

  await assert.rejects(
    () => store.unarchiveItem(result.items[0]),
    { message: "only archived sessions can be restored to active" }
  );

  await fs.rm(geminiHome, { recursive: true, force: true });
});

test("listSessions uses summary as title when available", async () => {
  const geminiHome = await createTempDir();
  const chatsDir = path.join(geminiHome, "tmp", "hash1", "chats");

  await writeGeminiSession(chatsDir, "session-2025-10-21T08-53-abc123.json", makeGeminiSession({
    sessionId: "sess-summary",
    projectHash: "hash1",
    summary: "Review code changes",
    messages: [{ type: "user", content: "This is the first user message" }]
  }));

  const store = new GeminiSessionStore({ geminiHome });
  const result = await store.listSessions();

  assert.equal(result.items[0].title, "Review code changes");

  await fs.rm(geminiHome, { recursive: true, force: true });
});

test("listSessions falls back to first user message when no summary", async () => {
  const geminiHome = await createTempDir();
  const chatsDir = path.join(geminiHome, "tmp", "hash1", "chats");

  await writeGeminiSession(chatsDir, "session-2025-10-21T08-53-abc123.json", makeGeminiSession({
    sessionId: "sess-nosummary",
    projectHash: "hash1",
    messages: [
      { type: "gemini", content: "Hello, how can I help?" },
      { type: "user", content: "Help me debug this issue" }
    ]
  }));

  const store = new GeminiSessionStore({ geminiHome });
  const result = await store.listSessions();

  assert.equal(result.items[0].title, "Help me debug this issue");

  await fs.rm(geminiHome, { recursive: true, force: true });
});
