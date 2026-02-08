const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { SessionStore, parseRolloutFilename } = require("../src/session-store");

async function createTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "codex-history-manager-"));
}

async function writeRolloutFile(
  filePath,
  content =
    '{"type":"session_meta"}\n' +
    '{"type":"event_msg","payload":{"type":"user_message","message":"hello"}}\n'
) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

async function writeGlobalState(codexHome, data) {
  const globalStatePath = path.join(codexHome, ".codex-global-state.json");
  await fs.writeFile(globalStatePath, JSON.stringify(data, null, 2), "utf8");
}

test("parseRolloutFilename parses thread id and date", () => {
  const parsed = parseRolloutFilename(
    "rollout-2026-02-08T03-11-52-019c3984-88a7-7e13-a5b6-3f4a6dcd4a1e.jsonl"
  );
  assert.ok(parsed);
  assert.equal(parsed.year, "2026");
  assert.equal(parsed.month, "02");
  assert.equal(parsed.day, "08");
  assert.equal(parsed.threadId, "019c3984-88a7-7e13-a5b6-3f4a6dcd4a1e");
});

test("archive and unarchive move files between codex directories", async () => {
  const codexHome = await createTempDir();
  const store = new SessionStore({ codexHome });

  const activeFile = path.join(
    codexHome,
    "sessions/2026/02/08/rollout-2026-02-08T03-11-52-active-thread-1.jsonl"
  );
  const archivedFile = path.join(
    codexHome,
    "archived_sessions/rollout-2026-02-07T03-11-52-archived-thread-1.jsonl"
  );

  await writeRolloutFile(activeFile);
  await writeRolloutFile(archivedFile);

  const before = await store.listSessions();
  assert.equal(before.counts.active, 1);
  assert.equal(before.counts.archived, 1);

  const activeItem = before.items.find((item) => item.threadId === "active-thread-1");
  assert.ok(activeItem);
  await store.archiveItem(activeItem);

  const afterArchive = await store.listSessions();
  assert.equal(afterArchive.counts.active, 0);
  assert.equal(afterArchive.counts.archived, 2);

  const archivedItem = afterArchive.items.find((item) => item.threadId === "archived-thread-1");
  assert.ok(archivedItem);
  await store.unarchiveItem(archivedItem);

  const afterUnarchive = await store.listSessions();
  assert.equal(afterUnarchive.counts.active, 1);
  assert.equal(afterUnarchive.counts.archived, 1);

  await fs.rm(codexHome, { recursive: true, force: true });
});

test("listSessions derives title from first user message", async () => {
  const codexHome = await createTempDir();
  const store = new SessionStore({ codexHome });

  const sessionPath = path.join(
    codexHome,
    "sessions/2026/02/08/rollout-2026-02-08T03-11-52-title-thread-1.jsonl"
  );

  await writeRolloutFile(
    sessionPath,
    '{"type":"session_meta","payload":{"id":"title-thread-1"}}\n' +
      '{"type":"event_msg","payload":{"type":"user_message","message":"   Build a batch archive ui for codex sessions.  \\n"}}\n'
  );

  const listed = await store.listSessions();
  assert.equal(listed.counts.total, 1);
  assert.equal(listed.items[0].title, "Build a batch archive ui for codex sessions.");
  assert.equal(listed.items[0].hasUserMessage, true);
  assert.equal(listed.items[0].isSystemMessage, false);

  await fs.rm(codexHome, { recursive: true, force: true });
});

test("desktop global state title is preferred when available", async () => {
  const codexHome = await createTempDir();
  const store = new SessionStore({ codexHome });

  const threadId = "desktop-title-thread-1";
  const sessionPath = path.join(
    codexHome,
    `sessions/2026/02/08/rollout-2026-02-08T03-11-52-${threadId}.jsonl`
  );

  await writeRolloutFile(
    sessionPath,
    '{"type":"session_meta","payload":{"id":"desktop-title-thread-1"}}\n' +
      '{"type":"event_msg","payload":{"type":"user_message","message":"raw first message title"}}\n'
  );

  await writeGlobalState(codexHome, {
    "thread-titles": {
      titles: {
        [threadId]: "Create batch session cleanup tool"
      },
      order: [threadId]
    }
  });

  const listed = await store.listSessions();
  assert.equal(listed.items[0].title, "Create batch session cleanup tool");
  assert.equal(listed.items[0].hasUserMessage, true);
  assert.equal(listed.items[0].isSystemMessage, false);

  await fs.rm(codexHome, { recursive: true, force: true });
});

test("system session is filtered out when first user message is skill trigger", async () => {
  const codexHome = await createTempDir();
  const store = new SessionStore({ codexHome });

  const sessionPath = path.join(
    codexHome,
    "sessions/2026/02/08/rollout-2026-02-08T03-11-52-skill-thread-1.jsonl"
  );

  await writeRolloutFile(
    sessionPath,
    '{"type":"session_meta","payload":{"id":"skill-thread-1","source":"cli"}}\n' +
      '{"type":"event_msg","payload":{"type":"user_message","message":"$skill-installer"}}\n'
  );

  const listed = await store.listSessions();
  assert.equal(listed.counts.total, 0);
  assert.equal(listed.items.length, 0);

  await fs.rm(codexHome, { recursive: true, force: true });
});

test("response_item-only prompt is filtered out", async () => {
  const codexHome = await createTempDir();
  const store = new SessionStore({ codexHome });

  const threadId = "response-only-thread-1";
  const sessionPath = path.join(
    codexHome,
    `sessions/2026/02/08/rollout-2026-02-08T03-11-52-${threadId}.jsonl`
  );

  await writeRolloutFile(
    sessionPath,
    '{"type":"session_meta","payload":{"id":"response-only-thread-1","source":"vscode"}}\n' +
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /tmp/project"}]}}\n'
  );

  const listed = await store.listSessions();
  assert.equal(listed.counts.total, 0);
  assert.equal(listed.items.length, 0);

  await fs.rm(codexHome, { recursive: true, force: true });
});

test("normal user session remains visible while system session is filtered", async () => {
  const codexHome = await createTempDir();
  const store = new SessionStore({ codexHome });

  const systemPath = path.join(
    codexHome,
    "sessions/2026/02/08/rollout-2026-02-08T03-11-52-system-thread-1.jsonl"
  );
  const userPath = path.join(
    codexHome,
    "sessions/2026/02/08/rollout-2026-02-08T03-11-53-user-thread-1.jsonl"
  );

  await writeRolloutFile(
    systemPath,
    '{"type":"session_meta","payload":{"id":"system-thread-1","source":"cli"}}\n' +
      '{"type":"event_msg","payload":{"type":"user_message","message":"$skill-installer"}}\n'
  );
  await writeRolloutFile(
    userPath,
    '{"type":"session_meta","payload":{"id":"user-thread-1","source":"cli"}}\n' +
      '{"type":"event_msg","payload":{"type":"user_message","message":"Build a codex history cleaner"}}\n'
  );

  const listed = await store.listSessions();
  assert.equal(listed.counts.total, 1);
  assert.equal(listed.counts.active, 1);
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].threadId, "user-thread-1");
  assert.equal(listed.items[0].title, "Build a codex history cleaner");

  await fs.rm(codexHome, { recursive: true, force: true });
});
