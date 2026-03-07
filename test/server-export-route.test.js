const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { encodeClaudeItemId } = require("../src/claude-session-store");
const { startServer } = require("../src/server");

async function createTempDir(prefix = "session-hub-server-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function closeServer(server) {
  await new Promise((resolve) => {
    server.close(resolve);
  });
}

async function writeClaudeSession(claudeHome, projectDirName, sessionId, lines) {
  const projectDir = path.join(claudeHome, "projects", projectDirName);
  await fs.mkdir(projectDir, { recursive: true });
  const sessionPath = path.join(projectDir, `${sessionId}.jsonl`);
  await fs.writeFile(sessionPath, `${lines.join("\n")}\n`, "utf8");
}

function userLine(sessionId, content, timestamp) {
  return JSON.stringify({
    type: "user",
    sessionId,
    timestamp,
    message: { role: "user", content }
  });
}

test("POST /api/claude/export rejects non-claude item ids", async () => {
  const codexHome = await createTempDir("session-hub-server-codex-");
  const claudeHome = await createTempDir("session-hub-server-claude-");
  const geminiHome = await createTempDir("session-hub-server-gemini-");
  const trashRoot = await createTempDir("session-hub-server-trash-");
  const running = await startServer({
    codexHome,
    claudeHome,
    geminiHome,
    trashRoot,
    port: 0
  });

  try {
    const response = await fetch(`${running.url}/api/claude/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        itemIds: ["not-claude-id"],
        ownershipConfirmed: true
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.match(payload.error, /Claude session ids only/);
  } finally {
    await closeServer(running.server);
    await fs.rm(codexHome, { recursive: true, force: true });
    await fs.rm(claudeHome, { recursive: true, force: true });
    await fs.rm(geminiHome, { recursive: true, force: true });
    await fs.rm(trashRoot, { recursive: true, force: true });
  }
});

test("POST /api/claude/export rejects when ownership is not confirmed", async () => {
  const codexHome = await createTempDir("session-hub-server-codex-");
  const claudeHome = await createTempDir("session-hub-server-claude-");
  const geminiHome = await createTempDir("session-hub-server-gemini-");
  const trashRoot = await createTempDir("session-hub-server-trash-");
  await writeClaudeSession(claudeHome, "-Users-test-own", "sess-own", [
    userLine("sess-own", "Need export", "2026-03-03T00:00:00.000Z")
  ]);

  const running = await startServer({
    codexHome,
    claudeHome,
    geminiHome,
    trashRoot,
    port: 0
  });

  try {
    const response = await fetch(`${running.url}/api/claude/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        itemIds: [encodeClaudeItemId("sess-own")],
        ownershipConfirmed: false
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.match(payload.error, /ownership confirmation is required/);
  } finally {
    await closeServer(running.server);
    await fs.rm(codexHome, { recursive: true, force: true });
    await fs.rm(claudeHome, { recursive: true, force: true });
    await fs.rm(geminiHome, { recursive: true, force: true });
    await fs.rm(trashRoot, { recursive: true, force: true });
  }
});

test("POST /api/claude/export returns exported package", async () => {
  const codexHome = await createTempDir("session-hub-server-codex-");
  const claudeHome = await createTempDir("session-hub-server-claude-");
  const geminiHome = await createTempDir("session-hub-server-gemini-");
  const trashRoot = await createTempDir("session-hub-server-trash-");
  await writeClaudeSession(claudeHome, "-Users-test-ok", "sess-ok", [
    userLine("sess-ok", "Continue the project", "2026-03-03T01:00:00.000Z")
  ]);

  const running = await startServer({
    codexHome,
    claudeHome,
    geminiHome,
    trashRoot,
    port: 0
  });

  try {
    const response = await fetch(`${running.url}/api/claude/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        itemIds: [encodeClaudeItemId("sess-ok")],
        ownershipConfirmed: true,
        includeSubagents: true,
        compression: "three-layer",
        budgetStrategy: "layered-trim"
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.stats.sessionCount, 1);
    assert.equal(typeof payload.promptText, "string");
    assert.equal(payload.codexHandoff, null);
    await fs.access(payload.files.promptMarkdown);
    await fs.access(payload.files.contextJson);
    await fs.access(payload.files.rawJsonl);
    await fs.access(payload.files.manifest);
    await fs.access(payload.files.overflow);
  } finally {
    await closeServer(running.server);
    await fs.rm(codexHome, { recursive: true, force: true });
    await fs.rm(claudeHome, { recursive: true, force: true });
    await fs.rm(geminiHome, { recursive: true, force: true });
    await fs.rm(trashRoot, { recursive: true, force: true });
  }
});

test("GET /api/codex/status returns detector payload", async () => {
  const codexHome = await createTempDir("session-hub-server-codex-status-");
  const claudeHome = await createTempDir("session-hub-server-claude-status-");
  const geminiHome = await createTempDir("session-hub-server-gemini-status-");
  const trashRoot = await createTempDir("session-hub-server-trash-status-");
  const running = await startServer({
    codexHome,
    claudeHome,
    geminiHome,
    trashRoot,
    port: 0,
    codexStatusProvider: async () => ({
      checkedAt: "2026-03-07T00:00:00.000Z",
      platform: "darwin",
      running: true,
      fingerprint: "42",
      processes: [{
        pid: 42,
        command: "/Applications/Codex.app/Contents/MacOS/Codex",
        args: "/Applications/Codex.app/Contents/MacOS/Codex"
      }]
    })
  });

  try {
    const response = await fetch(`${running.url}/api/codex/status`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.running, true);
    assert.equal(payload.fingerprint, "42");
    assert.equal(payload.processes.length, 1);
  } finally {
    await closeServer(running.server);
    await fs.rm(codexHome, { recursive: true, force: true });
    await fs.rm(claudeHome, { recursive: true, force: true });
    await fs.rm(geminiHome, { recursive: true, force: true });
    await fs.rm(trashRoot, { recursive: true, force: true });
  }
});
