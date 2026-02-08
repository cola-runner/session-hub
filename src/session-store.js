const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");
const { ensureDir, movePath, normalizeRelativePath, pathExists, walkFiles } = require("./fs-utils");

const ROLLOUT_FILENAME_PATTERN =
  /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(.+)\.jsonl$/;
const MAX_TITLE_SCAN_LINES = 700;
const USER_MESSAGE_BEGIN = "## My request for Codex:";

function parseRolloutFilename(fileName) {
  const match = ROLLOUT_FILENAME_PATTERN.exec(fileName);
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second, threadId] = match;
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    threadId,
    createdAt: `${year}-${month}-${day}T${hour}:${minute}:${second}Z`
  };
}

function encodeItemId(relativePath) {
  return Buffer.from(relativePath, "utf8").toString("base64url");
}

function decodeItemId(itemId) {
  return Buffer.from(itemId, "base64url").toString("utf8");
}

function formatDate(epochMs) {
  return new Date(epochMs).toISOString();
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

function extractTitleFromRecord(record) {
  if (!record || typeof record !== "object") {
    return null;
  }

  if (
    record.type === "event_msg" &&
    record.payload &&
    record.payload.type === "user_message" &&
    typeof record.payload.message === "string"
  ) {
    return normalizeTitle(stripUserMessagePrefix(record.payload.message));
  }

  return null;
}

function stripUserMessagePrefix(text) {
  if (typeof text !== "string") {
    return "";
  }

  const prefixIndex = text.indexOf(USER_MESSAGE_BEGIN);
  if (prefixIndex >= 0) {
    return text.slice(prefixIndex + USER_MESSAGE_BEGIN.length).trim();
  }
  return text.trim();
}

function isSystemGeneratedMessage(title) {
  const lowered = title.toLowerCase();
  return (
    lowered.startsWith("$skill-") ||
    lowered.startsWith("# agents.md instructions") ||
    lowered.startsWith("<environment_context>") ||
    lowered.startsWith("<permissions instructions>") ||
    lowered.startsWith("<app-context>") ||
    lowered.startsWith("<collaboration_mode>") ||
    lowered.startsWith("<instructions>") ||
    lowered.startsWith("<user_instructions>") ||
    lowered.startsWith("<skill>")
  );
}

async function readSessionSignalsFromRollout(absolutePath) {
  const input = fsSync.createReadStream(absolutePath, { encoding: "utf8" });
  const lineReader = readline.createInterface({
    input,
    crlfDelay: Infinity
  });

  let scannedLines = 0;
  let source = "unknown";
  let hasUserMessage = false;
  let firstUserTitle = null;
  let firstUserIsSystem = false;
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

      if (
        source === "unknown" &&
        record.type === "session_meta" &&
        record.payload &&
        typeof record.payload.source === "string" &&
        record.payload.source.trim()
      ) {
        source = record.payload.source.trim();
      }

      const extracted = extractTitleFromRecord(record);
      if (extracted) {
        hasUserMessage = true;
        if (!firstUserTitle) {
          firstUserTitle = extracted;
          firstUserIsSystem = isSystemGeneratedMessage(extracted);
        }
      }

      if (source !== "unknown" && firstUserTitle) {
        break;
      }
    }
  } finally {
    lineReader.close();
    input.destroy();
  }

  return {
    source,
    hasUserMessage,
    firstUserTitle,
    firstUserIsSystem
  };
}

function isSystemSession(signals) {
  if (!signals.hasUserMessage) {
    return true;
  }

  if (signals.firstUserTitle && signals.firstUserIsSystem) {
    return true;
  }

  if (signals.source === "exec" || signals.source === "mcp") {
    return true;
  }

  if (signals.source.startsWith("sub_agent")) {
    return true;
  }

  return false;
}

function fallbackTitleForThread(threadId) {
  if (threadId === "unknown") {
    return "Untitled session";
  }
  return `Untitled ${threadId.slice(0, 8)}`;
}

class SessionStore {
  constructor({ codexHome }) {
    this.codexHome = codexHome;
    this.sessionsRoot = path.join(codexHome, "sessions");
    this.archivedRoot = path.join(codexHome, "archived_sessions");
    this.globalStatePath = path.join(codexHome, ".codex-global-state.json");
    this.titleCache = new Map();
    this.desktopTitleCache = {
      version: "none",
      titles: new Map()
    };
  }

  async listSessions() {
    const desktopTitles = await this.#loadDesktopThreadTitles();
    const [active, archived] = await Promise.all([
      this.#scanRoot(this.sessionsRoot, "active", desktopTitles),
      this.#scanRoot(this.archivedRoot, "archived", desktopTitles)
    ]);

    const mergedItems = active
      .concat(archived)
      .sort((left, right) => right.updatedAtEpochMs - left.updatedAtEpochMs);

    const livePaths = new Set(mergedItems.map((item) => item.absolutePath));
    for (const cachedPath of this.titleCache.keys()) {
      if (!livePaths.has(cachedPath)) {
        this.titleCache.delete(cachedPath);
      }
    }

    const items = mergedItems
      .map(({ updatedAtEpochMs, ...item }) => item);

    return {
      items,
      counts: {
        total: items.length,
        active: active.length,
        archived: archived.length
      }
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

  async archiveItem(item) {
    if (item.state !== "active") {
      throw new Error("only active sessions can be archived");
    }

    const destinationPath = path.join(this.archivedRoot, item.fileName);
    if (await pathExists(destinationPath)) {
      throw new Error("archived destination already exists");
    }

    await ensureDir(this.archivedRoot);
    await movePath(item.absolutePath, destinationPath);
    return {
      from: item.relativePath,
      to: normalizeRelativePath(path.relative(this.codexHome, destinationPath))
    };
  }

  async unarchiveItem(item) {
    if (item.state !== "archived") {
      throw new Error("only archived sessions can be restored to active");
    }

    const parsed = parseRolloutFilename(item.fileName);
    if (!parsed) {
      throw new Error("cannot infer date from rollout filename");
    }

    const destinationDir = path.join(
      this.sessionsRoot,
      parsed.year,
      parsed.month,
      parsed.day
    );
    const destinationPath = path.join(destinationDir, item.fileName);
    if (await pathExists(destinationPath)) {
      throw new Error("active destination already exists");
    }

    await ensureDir(destinationDir);
    await movePath(item.absolutePath, destinationPath);
    return {
      from: item.relativePath,
      to: normalizeRelativePath(path.relative(this.codexHome, destinationPath))
    };
  }

  async #scanRoot(rootPath, state, desktopTitles) {
    const files = await walkFiles(rootPath);
    const items = [];

    for (const absolutePath of files) {
      const fileName = path.basename(absolutePath);
      if (!fileName.startsWith("rollout-") || !fileName.endsWith(".jsonl")) {
        continue;
      }

      const parsed = parseRolloutFilename(fileName);
      let stats;
      try {
        stats = await fs.stat(absolutePath);
      } catch (error) {
        if (error && error.code === "ENOENT") {
          continue;
        }
        throw error;
      }

      const threadId = parsed ? parsed.threadId : "unknown";
      const relativePath = normalizeRelativePath(path.relative(this.codexHome, absolutePath));
      const updatedAtEpochMs = stats.mtimeMs || stats.ctimeMs || Date.now();
      const createdAtEpochMs = stats.birthtimeMs || stats.ctimeMs || stats.mtimeMs || Date.now();
      const resolved = await this.#resolveItemMeta(
        absolutePath,
        stats.mtimeMs,
        stats.size,
        threadId,
        desktopTitles
      );
      if (resolved.isSystemMessage) {
        continue;
      }

      items.push({
        itemId: encodeItemId(relativePath),
        threadId,
        title: resolved.title,
        hasUserMessage: resolved.hasUserMessage,
        isSystemMessage: resolved.isSystemMessage,
        source: resolved.source,
        fileName,
        state,
        absolutePath,
        relativePath,
        sizeBytes: stats.size,
        createdAt: parsed ? parsed.createdAt : formatDate(createdAtEpochMs),
        updatedAt: formatDate(updatedAtEpochMs),
        updatedAtEpochMs
      });
    }

    return items;
  }

  async #resolveItemMeta(absolutePath, mtimeMs, sizeBytes, threadId, desktopTitles) {
    const cached = this.titleCache.get(absolutePath);
    if (
      cached &&
      cached.mtimeMs === mtimeMs &&
      cached.sizeBytes === sizeBytes &&
      cached.desktopTitleVersion === this.desktopTitleCache.version
    ) {
      return {
        title: cached.title,
        hasUserMessage: cached.hasUserMessage,
        isSystemMessage: cached.isSystemMessage,
        source: cached.source
      };
    }

    let signals = {
      source: "unknown",
      hasUserMessage: false,
      firstUserTitle: null,
      firstUserIsSystem: false
    };

    try {
      signals = await readSessionSignalsFromRollout(absolutePath);
    } catch (error) {
      if (!error || error.code !== "ENOENT") {
        throw error;
      }
    }

    const desktopTitle = desktopTitles.get(threadId);
    const title = desktopTitle || signals.firstUserTitle || fallbackTitleForThread(threadId);
    const isSystemMessage = isSystemSession(signals);

    this.titleCache.set(absolutePath, {
      mtimeMs,
      sizeBytes,
      desktopTitleVersion: this.desktopTitleCache.version,
      title,
      source: signals.source,
      hasUserMessage: signals.hasUserMessage,
      isSystemMessage
    });

    return {
      title,
      source: signals.source,
      hasUserMessage: signals.hasUserMessage,
      isSystemMessage
    };
  }

  async #loadDesktopThreadTitles() {
    let stats;
    try {
      stats = await fs.stat(this.globalStatePath);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        this.desktopTitleCache = {
          version: "none",
          titles: new Map()
        };
        return this.desktopTitleCache.titles;
      }
      throw error;
    }

    const version = `${stats.mtimeMs}:${stats.size}`;
    if (this.desktopTitleCache.version === version) {
      return this.desktopTitleCache.titles;
    }

    let parsed;
    try {
      const raw = await fs.readFile(this.globalStatePath, "utf8");
      parsed = JSON.parse(raw);
    } catch {
      this.desktopTitleCache = {
        version,
        titles: new Map()
      };
      return this.desktopTitleCache.titles;
    }

    const titlesRaw =
      parsed &&
      typeof parsed === "object" &&
      parsed["thread-titles"] &&
      typeof parsed["thread-titles"] === "object"
        ? parsed["thread-titles"].titles
        : null;

    const titles = new Map();
    if (titlesRaw && typeof titlesRaw === "object" && !Array.isArray(titlesRaw)) {
      for (const [threadId, rawTitle] of Object.entries(titlesRaw)) {
        const normalized = normalizeTitle(rawTitle);
        if (normalized) {
          titles.set(threadId, normalized);
        }
      }
    }

    this.desktopTitleCache = {
      version,
      titles
    };
    return titles;
  }
}

module.exports = {
  SessionStore,
  decodeItemId,
  encodeItemId,
  parseRolloutFilename
};
