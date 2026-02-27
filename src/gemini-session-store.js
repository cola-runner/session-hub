const fs = require("node:fs/promises");
const path = require("node:path");
const { ensureDir, movePath, normalizeRelativePath, pathExists } = require("./fs-utils");

function encodeGeminiItemId(sessionId) {
  return Buffer.from(`gemini:${sessionId}`, "utf8").toString("base64url");
}

function decodeGeminiItemId(itemId) {
  const decoded = Buffer.from(itemId, "base64url").toString("utf8");
  if (!decoded.startsWith("gemini:")) {
    return null;
  }
  return decoded.slice("gemini:".length);
}

function isGeminiItemId(itemId) {
  return decodeGeminiItemId(itemId) !== null;
}

function normalizeTitle(rawTitle) {
  if (typeof rawTitle !== "string") {
    return null;
  }

  const oneLine = rawTitle.replace(/\s+/g, " ").trim();
  if (!oneLine) {
    return null;
  }

  const titleChars = Array.from(oneLine);
  const maxLength = 56;
  if (titleChars.length <= maxLength) {
    return oneLine;
  }

  return `${titleChars.slice(0, maxLength - 1).join("")}…`;
}

class GeminiSessionStore {
  constructor({ geminiHome }) {
    this.geminiHome = geminiHome;
    this.projectsRoot = path.join(geminiHome, "tmp");
    this.archivedRoot = path.join(geminiHome, "archived_sessions");
    this.titleCache = new Map();
  }

  async listSessions() {
    const [active, archived] = await Promise.all([
      this.#scanRoot(this.projectsRoot, "active"),
      this.#scanRoot(this.archivedRoot, "archived")
    ]);

    const items = active.concat(archived)
      .sort((left, right) => right.updatedAtEpochMs - left.updatedAtEpochMs);

    const livePaths = new Set(items.map((item) => item.absolutePath));
    for (const cachedPath of this.titleCache.keys()) {
      if (!livePaths.has(cachedPath)) {
        this.titleCache.delete(cachedPath);
      }
    }

    const result = items.map(({ updatedAtEpochMs, ...item }) => item);

    return {
      items: result,
      counts: {
        total: result.length,
        active: active.length,
        archived: archived.length
      }
    };
  }

  async archiveItem(item) {
    if (item.state !== "active") {
      throw new Error("only active sessions can be archived");
    }

    const relativeFromRoot = path.relative(this.projectsRoot, item.absolutePath);
    const destinationPath = path.join(this.archivedRoot, relativeFromRoot);
    if (await pathExists(destinationPath)) {
      throw new Error("archived destination already exists");
    }

    await ensureDir(path.dirname(destinationPath));
    await movePath(item.absolutePath, destinationPath);
    return {
      from: item.relativePath,
      to: normalizeRelativePath(path.relative(this.geminiHome, destinationPath))
    };
  }

  async unarchiveItem(item) {
    if (item.state !== "archived") {
      throw new Error("only archived sessions can be restored to active");
    }

    const relativeFromRoot = path.relative(this.archivedRoot, item.absolutePath);
    const destinationPath = path.join(this.projectsRoot, relativeFromRoot);
    if (await pathExists(destinationPath)) {
      throw new Error("active destination already exists");
    }

    await ensureDir(path.dirname(destinationPath));
    await movePath(item.absolutePath, destinationPath);
    return {
      from: item.relativePath,
      to: normalizeRelativePath(path.relative(this.geminiHome, destinationPath))
    };
  }

  async findItemsByIds(itemIds) {
    const { items } = await this.listSessions();
    const byId = new Map(items.map((item) => [item.itemId, item]));
    const found = [];
    const missing = [];

    for (const itemId of itemIds) {
      const item = byId.get(itemId);
      if (item) {
        found.push(item);
      } else {
        missing.push(itemId);
      }
    }

    return { found, missing };
  }

  async #scanRoot(rootPath, state) {
    let hashDirs;
    try {
      const entries = await fs.readdir(rootPath, { withFileTypes: true });
      hashDirs = entries.filter((entry) => entry.isDirectory());
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const items = [];

    for (const hashDir of hashDirs) {
      const chatsPath = path.join(rootPath, hashDir.name, "chats");

      let files;
      try {
        files = await fs.readdir(chatsPath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.isFile() || !file.name.startsWith("session-") || !file.name.endsWith(".json")) {
          continue;
        }

        const absolutePath = path.join(chatsPath, file.name);

        let stats;
        try {
          stats = await fs.stat(absolutePath);
        } catch (error) {
          if (error && error.code === "ENOENT") {
            continue;
          }
          throw error;
        }

        const meta = await this.#resolveItemMeta(absolutePath, stats.mtimeMs, stats.size);

        const itemId = encodeGeminiItemId(meta.sessionId);
        const relativePath = path.relative(this.geminiHome, absolutePath).split(path.sep).join("/");

        items.push({
          itemId,
          threadId: meta.sessionId,
          title: meta.title || `Untitled ${meta.sessionId.slice(0, 8)}`,
          fileName: file.name,
          state,
          provider: "gemini",
          absolutePath,
          relativePath,
          sizeBytes: stats.size,
          createdAt: meta.startTime || new Date(stats.birthtimeMs || stats.ctimeMs || stats.mtimeMs || Date.now()).toISOString(),
          updatedAt: meta.lastUpdated || new Date(stats.mtimeMs || stats.ctimeMs || Date.now()).toISOString(),
          updatedAtEpochMs: meta.lastUpdated ? Date.parse(meta.lastUpdated) : (stats.mtimeMs || stats.ctimeMs || Date.now()),
          projectHash: hashDir.name,
          messageCount: meta.messageCount || 0
        });
      }
    }

    return items;
  }

  async #resolveItemMeta(absolutePath, mtimeMs, sizeBytes) {
    const cached = this.titleCache.get(absolutePath);
    if (cached && cached.mtimeMs === mtimeMs && cached.sizeBytes === sizeBytes) {
      return cached;
    }

    let meta = { sessionId: "", title: null, startTime: null, lastUpdated: null, messageCount: 0 };
    try {
      const raw = await fs.readFile(absolutePath, "utf8");
      const data = JSON.parse(raw);

      meta.sessionId = data.sessionId || "";
      meta.startTime = data.startTime || null;
      meta.lastUpdated = data.lastUpdated || null;
      meta.messageCount = Array.isArray(data.messages) ? data.messages.length : 0;

      if (data.summary) {
        meta.title = normalizeTitle(data.summary);
      }

      if (!meta.title && Array.isArray(data.messages)) {
        const firstUser = data.messages.find((m) => m.type === "user");
        if (firstUser && typeof firstUser.content === "string") {
          meta.title = normalizeTitle(firstUser.content);
        }
      }
    } catch {
      // Ignore read/parse errors
    }

    const entry = { ...meta, mtimeMs, sizeBytes };
    this.titleCache.set(absolutePath, entry);
    return meta;
  }
}

module.exports = {
  GeminiSessionStore,
  decodeGeminiItemId,
  encodeGeminiItemId,
  isGeminiItemId
};
