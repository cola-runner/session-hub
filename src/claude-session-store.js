const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");

const MAX_TITLE_SCAN_LINES = 50;

function encodeClaudeItemId(sessionId) {
  return Buffer.from(`claude:${sessionId}`, "utf8").toString("base64url");
}

function decodeClaudeItemId(itemId) {
  const decoded = Buffer.from(itemId, "base64url").toString("utf8");
  if (!decoded.startsWith("claude:")) {
    return null;
  }
  return decoded.slice("claude:".length);
}

function isClaudeItemId(itemId) {
  return decodeClaudeItemId(itemId) !== null;
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

function decodeProjectName(dirName) {
  return dirName.replace(/^-/, "/").replace(/-/g, "/");
}

async function readFirstUserMessage(absolutePath) {
  let input;
  try {
    input = fsSync.createReadStream(absolutePath, { encoding: "utf8" });
  } catch {
    return { title: null, gitBranch: null, messageCount: 0 };
  }

  const lineReader = readline.createInterface({
    input,
    crlfDelay: Infinity
  });

  let scannedLines = 0;
  let firstUserContent = null;
  let gitBranch = null;
  let messageCount = 0;

  try {
    for await (const line of lineReader) {
      scannedLines += 1;
      if (scannedLines > MAX_TITLE_SCAN_LINES) {
        break;
      }

      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }

      if (record.type === "user") {
        messageCount += 1;
        if (!gitBranch && record.gitBranch) {
          gitBranch = record.gitBranch;
        }
        if (!firstUserContent && record.message && record.message.content) {
          const content = record.message.content;
          if (typeof content === "string") {
            firstUserContent = content;
          }
        }
      }
    }
  } finally {
    lineReader.close();
    input.destroy();
  }

  const title = normalizeTitle(firstUserContent);
  return { title, gitBranch, messageCount };
}

class ClaudeSessionStore {
  constructor({ claudeHome }) {
    this.claudeHome = claudeHome;
    this.projectsRoot = path.join(claudeHome, "projects");
    this.titleCache = new Map();
  }

  async listSessions() {
    let projectDirs;
    try {
      const entries = await fs.readdir(this.projectsRoot, { withFileTypes: true });
      projectDirs = entries.filter((entry) => entry.isDirectory());
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return { items: [], counts: { total: 0 } };
      }
      throw error;
    }

    const items = [];

    for (const projectDir of projectDirs) {
      const projectPath = path.join(this.projectsRoot, projectDir.name);
      const projectName = decodeProjectName(projectDir.name);

      let files;
      try {
        files = await fs.readdir(projectPath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".jsonl")) {
          continue;
        }

        const absolutePath = path.join(projectPath, file.name);
        const sessionId = file.name.replace(/\.jsonl$/, "");

        let stats;
        try {
          stats = await fs.stat(absolutePath);
        } catch (error) {
          if (error && error.code === "ENOENT") {
            continue;
          }
          throw error;
        }

        const meta = await this.#resolveItemMeta(absolutePath, stats.mtimeMs, stats.size, sessionId);

        const itemId = encodeClaudeItemId(sessionId);
        const relativePath = path.relative(this.claudeHome, absolutePath).split(path.sep).join("/");

        items.push({
          itemId,
          threadId: sessionId,
          title: meta.title || `Untitled ${sessionId.slice(0, 8)}`,
          fileName: file.name,
          state: "active",
          provider: "claude",
          absolutePath,
          relativePath,
          sizeBytes: stats.size,
          createdAt: new Date(stats.birthtimeMs || stats.ctimeMs || stats.mtimeMs || Date.now()).toISOString(),
          updatedAt: new Date(stats.mtimeMs || stats.ctimeMs || Date.now()).toISOString(),
          updatedAtEpochMs: stats.mtimeMs || stats.ctimeMs || Date.now(),
          projectName,
          gitBranch: meta.gitBranch || null,
          messageCount: meta.messageCount || 0
        });
      }
    }

    items.sort((left, right) => right.updatedAtEpochMs - left.updatedAtEpochMs);

    const livePaths = new Set(items.map((item) => item.absolutePath));
    for (const cachedPath of this.titleCache.keys()) {
      if (!livePaths.has(cachedPath)) {
        this.titleCache.delete(cachedPath);
      }
    }

    const result = items.map(({ updatedAtEpochMs, ...item }) => item);

    return {
      items: result,
      counts: { total: result.length }
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

  async #resolveItemMeta(absolutePath, mtimeMs, sizeBytes, sessionId) {
    const cached = this.titleCache.get(absolutePath);
    if (cached && cached.mtimeMs === mtimeMs && cached.sizeBytes === sizeBytes) {
      return {
        title: cached.title,
        gitBranch: cached.gitBranch,
        messageCount: cached.messageCount
      };
    }

    let signals = { title: null, gitBranch: null, messageCount: 0 };
    try {
      signals = await readFirstUserMessage(absolutePath);
    } catch (error) {
      if (!error || error.code !== "ENOENT") {
        throw error;
      }
    }

    this.titleCache.set(absolutePath, {
      mtimeMs,
      sizeBytes,
      title: signals.title,
      gitBranch: signals.gitBranch,
      messageCount: signals.messageCount
    });

    return {
      title: signals.title,
      gitBranch: signals.gitBranch,
      messageCount: signals.messageCount
    };
  }
}

module.exports = {
  ClaudeSessionStore,
  decodeClaudeItemId,
  encodeClaudeItemId,
  isClaudeItemId
};
