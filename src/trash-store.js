const fs = require("node:fs/promises");
const path = require("node:path");
const {
  ensureDir,
  movePath,
  normalizeRelativePath,
  pathExists,
  resolvePathWithinRoot
} = require("./fs-utils");

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function createTrashId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isSafeTrashId(value) {
  return /^[A-Za-z0-9-]+$/.test(value);
}

class TrashStore {
  constructor({ codexHome, trashRoot, retentionDays }) {
    this.codexHome = codexHome;
    this.trashRoot = trashRoot;
    this.retentionDays = retentionDays;
    this.itemsRoot = path.join(trashRoot, "items");
  }

  async init() {
    await ensureDir(this.itemsRoot);
  }

  async trashSessionItem(item, homeRoot) {
    await this.init();

    const effectiveHomeRoot = homeRoot || this.codexHome;
    const trashId = createTrashId();
    const itemRoot = path.join(this.itemsRoot, trashId);
    const payloadRelativePath = normalizeRelativePath(path.join("payload", item.relativePath));
    const payloadAbsolutePath = path.join(itemRoot, payloadRelativePath);

    await ensureDir(path.dirname(payloadAbsolutePath));

    const deletedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + this.retentionDays * ONE_DAY_MS).toISOString();
    await movePath(item.absolutePath, payloadAbsolutePath);

    const metadata = {
      trashId,
      threadId: item.threadId,
      fileName: item.fileName,
      originalState: item.state,
      originalRelativePath: item.relativePath,
      payloadRelativePath,
      sizeBytes: item.sizeBytes,
      deletedAt,
      expiresAt,
      provider: item.provider || "codex",
      homeRoot: effectiveHomeRoot
    };

    await fs.writeFile(
      path.join(itemRoot, "meta.json"),
      JSON.stringify(metadata, null, 2),
      "utf8"
    );

    return metadata;
  }

  async listTrashItems() {
    await this.init();

    let entries;
    try {
      entries = await fs.readdir(this.itemsRoot, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const items = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const trashId = entry.name;
      const loaded = await this.#loadItem(trashId);
      if (loaded) {
        items.push(loaded);
      }
    }

    items.sort(
      (left, right) =>
        Date.parse(right.metadata.deletedAt || 0) - Date.parse(left.metadata.deletedAt || 0)
    );

    return items.map(({ metadata, payloadExists }) => ({
      ...metadata,
      payloadExists,
      expired: Date.parse(metadata.expiresAt || 0) <= Date.now()
    }));
  }

  async restore(trashIds) {
    const result = {
      succeeded: [],
      failed: []
    };

    for (const trashId of trashIds) {
      try {
        const restored = await this.#restoreOne(trashId);
        result.succeeded.push(restored);
      } catch (error) {
        result.failed.push({
          trashId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return result;
  }

  async purge(trashIds) {
    const result = {
      succeeded: [],
      failed: []
    };

    for (const trashId of trashIds) {
      try {
        await this.#purgeOne(trashId);
        result.succeeded.push({ trashId });
      } catch (error) {
        result.failed.push({
          trashId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return result;
  }

  async cleanupExpired() {
    const items = await this.listTrashItems();
    const expiredIds = items.filter((item) => item.expired).map((item) => item.trashId);
    const report = await this.purge(expiredIds);
    return {
      expiredCandidates: expiredIds.length,
      ...report
    };
  }

  async #restoreOne(trashId) {
    const loaded = await this.#loadItem(trashId);
    if (!loaded) {
      throw new Error("trash item not found");
    }

    const { metadata, itemRoot } = loaded;
    const payloadAbsolutePath = resolvePathWithinRoot(
      itemRoot,
      metadata.payloadRelativePath,
      "trash payload path"
    );
    if (!(await pathExists(payloadAbsolutePath))) {
      throw new Error("trash payload is missing");
    }

    const restoreHomeRoot = metadata.homeRoot || this.codexHome;
    const restoreAbsolutePath = resolvePathWithinRoot(
      restoreHomeRoot,
      metadata.originalRelativePath,
      "restore target path"
    );
    if (await pathExists(restoreAbsolutePath)) {
      throw new Error("restore target already exists");
    }

    await ensureDir(path.dirname(restoreAbsolutePath));
    await movePath(payloadAbsolutePath, restoreAbsolutePath);
    await fs.rm(itemRoot, { recursive: true, force: true });

    return {
      trashId,
      restoredTo: normalizeRelativePath(path.relative(restoreHomeRoot, restoreAbsolutePath))
    };
  }

  async #purgeOne(trashId) {
    if (!isSafeTrashId(trashId)) {
      throw new Error("invalid trash id");
    }

    const itemRoot = path.join(this.itemsRoot, trashId);
    await fs.rm(itemRoot, { recursive: true, force: true });
  }

  async #loadItem(trashId) {
    if (!isSafeTrashId(trashId)) {
      return null;
    }

    const itemRoot = path.join(this.itemsRoot, trashId);
    const metadataPath = path.join(itemRoot, "meta.json");

    let metadataRaw;
    try {
      metadataRaw = await fs.readFile(metadataPath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }

    let metadata;
    try {
      metadata = JSON.parse(metadataRaw);
    } catch {
      return null;
    }

    const payloadRelativePath = metadata.payloadRelativePath || "";
    let payloadExists = false;
    try {
      const payloadAbsolutePath = resolvePathWithinRoot(
        itemRoot,
        payloadRelativePath,
        "trash payload path"
      );
      payloadExists = await pathExists(payloadAbsolutePath);
    } catch {
      payloadExists = false;
    }

    return {
      metadata,
      itemRoot,
      payloadExists
    };
  }
}

module.exports = {
  TrashStore
};
