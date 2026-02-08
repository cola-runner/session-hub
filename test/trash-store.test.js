const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { SessionStore } = require("../src/session-store");
const { TrashStore } = require("../src/trash-store");

async function createTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "codex-history-manager-"));
}

async function writeRolloutFile(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    '{"type":"session_meta"}\n' +
      '{"type":"event_msg","payload":{"type":"user_message","message":"hello"}}\n',
    "utf8"
  );
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

test("trash restore puts session file back", async () => {
  const codexHome = await createTempDir();
  const trashRoot = await createTempDir();

  const activeFile = path.join(
    codexHome,
    "sessions/2026/02/08/rollout-2026-02-08T03-11-52-trash-thread-1.jsonl"
  );
  await writeRolloutFile(activeFile);

  const store = new SessionStore({ codexHome });
  const trashStore = new TrashStore({ codexHome, trashRoot, retentionDays: 30 });
  const listed = await store.listSessions();
  const item = listed.items[0];

  const metadata = await trashStore.trashSessionItem(item);
  const afterTrash = await store.listSessions();
  assert.equal(afterTrash.counts.total, 0);

  const restoreReport = await trashStore.restore([metadata.trashId]);
  assert.equal(restoreReport.succeeded.length, 1);
  assert.equal(restoreReport.failed.length, 0);

  const afterRestore = await store.listSessions();
  assert.equal(afterRestore.counts.total, 1);

  await fs.rm(codexHome, { recursive: true, force: true });
  await fs.rm(trashRoot, { recursive: true, force: true });
});

test("restore rejects metadata with original path outside codexHome", async () => {
  const codexHome = await createTempDir();
  const trashRoot = await createTempDir();

  const activeFile = path.join(
    codexHome,
    "sessions/2026/02/08/rollout-2026-02-08T03-11-52-path-escape-thread-1.jsonl"
  );
  await writeRolloutFile(activeFile);

  const store = new SessionStore({ codexHome });
  const trashStore = new TrashStore({ codexHome, trashRoot, retentionDays: 30 });
  const listed = await store.listSessions();
  const metadata = await trashStore.trashSessionItem(listed.items[0]);
  const metadataPath = path.join(trashRoot, "items", metadata.trashId, "meta.json");
  const parsed = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  parsed.originalRelativePath = "../escaped-restore-target.jsonl";
  await fs.writeFile(metadataPath, JSON.stringify(parsed, null, 2), "utf8");

  const report = await trashStore.restore([metadata.trashId]);
  assert.equal(report.succeeded.length, 0);
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].error, /escapes allowed root/);

  const escapedTarget = path.resolve(codexHome, "../escaped-restore-target.jsonl");
  assert.equal(await pathExists(escapedTarget), false);

  await fs.rm(codexHome, { recursive: true, force: true });
  await fs.rm(trashRoot, { recursive: true, force: true });
});

test("restore rejects metadata with payload path outside trash item root", async () => {
  const codexHome = await createTempDir();
  const trashRoot = await createTempDir();

  const activeFile = path.join(
    codexHome,
    "sessions/2026/02/08/rollout-2026-02-08T03-11-52-payload-escape-thread-1.jsonl"
  );
  await writeRolloutFile(activeFile);

  const store = new SessionStore({ codexHome });
  const trashStore = new TrashStore({ codexHome, trashRoot, retentionDays: 30 });
  const listed = await store.listSessions();
  const metadata = await trashStore.trashSessionItem(listed.items[0]);
  const metadataPath = path.join(trashRoot, "items", metadata.trashId, "meta.json");
  const parsed = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  parsed.payloadRelativePath = "../../escaped-payload.jsonl";
  await fs.writeFile(metadataPath, JSON.stringify(parsed, null, 2), "utf8");

  const report = await trashStore.restore([metadata.trashId]);
  assert.equal(report.succeeded.length, 0);
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].error, /escapes allowed root/);

  await fs.rm(codexHome, { recursive: true, force: true });
  await fs.rm(trashRoot, { recursive: true, force: true });
});

test("cleanupExpired permanently deletes expired trash items", async () => {
  const codexHome = await createTempDir();
  const trashRoot = await createTempDir();

  const activeFile = path.join(
    codexHome,
    "sessions/2026/02/08/rollout-2026-02-08T03-11-52-expired-thread-1.jsonl"
  );
  await writeRolloutFile(activeFile);

  const store = new SessionStore({ codexHome });
  const trashStore = new TrashStore({ codexHome, trashRoot, retentionDays: 0 });
  const listed = await store.listSessions();
  await trashStore.trashSessionItem(listed.items[0]);

  const cleanup = await trashStore.cleanupExpired();
  assert.equal(cleanup.expiredCandidates, 1);
  assert.equal(cleanup.succeeded.length, 1);
  assert.equal(cleanup.failed.length, 0);

  const remaining = await trashStore.listTrashItems();
  assert.equal(remaining.length, 0);

  await fs.rm(codexHome, { recursive: true, force: true });
  await fs.rm(trashRoot, { recursive: true, force: true });
});
