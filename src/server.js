const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { isPathInsideRoot } = require("./fs-utils");
const { SessionStore } = require("./session-store");
const { ClaudeSessionStore, isClaudeItemId } = require("./claude-session-store");
const { TrashStore } = require("./trash-store");

const WEB_ROOT = path.join(__dirname, "..", "web");

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function toErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {};
  }
  return JSON.parse(raw);
}

function parseStringArrayField(payload, fieldName) {
  const field = payload && payload[fieldName];
  if (!Array.isArray(field)) {
    return [];
  }
  return field.map(String);
}

function contentTypeFor(filePath) {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (filePath.endsWith(".js")) {
    return "application/javascript; charset=utf-8";
  }
  if (filePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  return "application/octet-stream";
}

async function serveStatic(requestPath, response) {
  const normalizedPath = requestPath === "/" ? "/index.html" : requestPath;
  const relativePath = normalizedPath.startsWith("/")
    ? normalizedPath.slice(1)
    : normalizedPath;
  const normalizedAbsolutePath = path.resolve(WEB_ROOT, relativePath);

  if (!isPathInsideRoot(WEB_ROOT, normalizedAbsolutePath)) {
    json(response, 403, { error: "forbidden" });
    return;
  }

  try {
    const file = await fs.readFile(normalizedAbsolutePath);
    response.writeHead(200, {
      "content-type": contentTypeFor(normalizedAbsolutePath),
      "cache-control": "no-store"
    });
    response.end(file);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      json(response, 404, { error: "not found" });
      return;
    }
    json(response, 500, { error: toErrorMessage(error) });
  }
}

async function findItemAcrossStores(itemIds, codexStore, claudeStore) {
  const codexIds = [];
  const claudeIds = [];

  for (const itemId of itemIds) {
    if (isClaudeItemId(itemId)) {
      claudeIds.push(itemId);
    } else {
      codexIds.push(itemId);
    }
  }

  const [codexResult, claudeResult] = await Promise.all([
    codexIds.length > 0 ? codexStore.findItemsByIds(codexIds) : { found: [], missing: [] },
    claudeIds.length > 0 ? claudeStore.findItemsByIds(claudeIds) : { found: [], missing: [] }
  ]);

  return {
    found: codexResult.found.concat(claudeResult.found),
    missing: codexResult.missing.concat(claudeResult.missing)
  };
}

async function runMultiSourceBatch(itemIds, codexStore, claudeStore, action) {
  const selection = await findItemAcrossStores(itemIds, codexStore, claudeStore);
  const report = {
    requested: itemIds.length,
    succeeded: [],
    failed: []
  };

  for (const missingId of selection.missing) {
    report.failed.push({
      itemId: missingId,
      error: "session not found"
    });
  }

  for (const item of selection.found) {
    try {
      const details = await action(item);
      report.succeeded.push({
        itemId: item.itemId,
        threadId: item.threadId,
        ...details
      });
    } catch (error) {
      report.failed.push({
        itemId: item.itemId,
        threadId: item.threadId,
        error: toErrorMessage(error)
      });
    }
  }

  report.succeededCount = report.succeeded.length;
  report.failedCount = report.failed.length;
  return report;
}

async function runSessionBatch(itemIds, sessionStore, action) {
  const selection = await sessionStore.findItemsByIds(itemIds);
  const report = {
    requested: itemIds.length,
    succeeded: [],
    failed: []
  };

  for (const missingId of selection.missing) {
    report.failed.push({
      itemId: missingId,
      error: "session not found"
    });
  }

  for (const item of selection.found) {
    try {
      const details = await action(item);
      report.succeeded.push({
        itemId: item.itemId,
        threadId: item.threadId,
        ...details
      });
    } catch (error) {
      report.failed.push({
        itemId: item.itemId,
        threadId: item.threadId,
        error: toErrorMessage(error)
      });
    }
  }

  report.succeededCount = report.succeeded.length;
  report.failedCount = report.failed.length;
  return report;
}

async function startServer({
  codexHome,
  claudeHome,
  trashRoot,
  retentionDays = 30,
  port = 0
}) {
  const sessionStore = new SessionStore({ codexHome });
  const claudeStore = new ClaudeSessionStore({ claudeHome });
  const trashStore = new TrashStore({ codexHome, trashRoot, retentionDays });
  const cleanupReport = await trashStore.cleanupExpired();

  const server = http.createServer(async (request, response) => {
    if (!request.url || !request.method) {
      json(response, 400, { error: "invalid request" });
      return;
    }

    const { pathname } = new URL(request.url, "http://127.0.0.1");

    try {
      if (request.method === "GET" && pathname === "/api/health") {
        json(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && pathname === "/api/config") {
        json(response, 200, {
          codexHome,
          claudeHome,
          trashRoot,
          retentionDays
        });
        return;
      }

      if (request.method === "GET" && pathname === "/api/sessions") {
        const [codexResult, claudeResult] = await Promise.all([
          sessionStore.listSessions(),
          claudeStore.listSessions()
        ]);

        const codexItems = codexResult.items.map((item) => ({
          ...item,
          provider: "codex"
        }));
        const claudeItems = claudeResult.items;

        const merged = codexItems.concat(claudeItems).sort((left, right) => {
          const leftTime = Date.parse(left.updatedAt) || 0;
          const rightTime = Date.parse(right.updatedAt) || 0;
          return rightTime - leftTime;
        });

        json(response, 200, {
          items: merged,
          counts: {
            total: merged.length,
            active: merged.filter((item) => item.state === "active").length,
            archived: merged.filter((item) => item.state === "archived").length
          }
        });
        return;
      }

      if (request.method === "POST" && pathname === "/api/sessions/archive") {
        const payload = await readJsonBody(request);
        const itemIds = parseStringArrayField(payload, "itemIds");
        const claudeIds = itemIds.filter((id) => isClaudeItemId(id));
        if (claudeIds.length > 0) {
          json(response, 400, { error: "archive is not supported for Claude sessions" });
          return;
        }
        const report = await runSessionBatch(itemIds, sessionStore, (item) =>
          sessionStore.archiveItem(item)
        );
        json(response, 200, report);
        return;
      }

      if (request.method === "POST" && pathname === "/api/sessions/unarchive") {
        const payload = await readJsonBody(request);
        const itemIds = parseStringArrayField(payload, "itemIds");
        const claudeIds = itemIds.filter((id) => isClaudeItemId(id));
        if (claudeIds.length > 0) {
          json(response, 400, { error: "unarchive is not supported for Claude sessions" });
          return;
        }
        const report = await runSessionBatch(itemIds, sessionStore, (item) =>
          sessionStore.unarchiveItem(item)
        );
        json(response, 200, report);
        return;
      }

      if (request.method === "POST" && pathname === "/api/sessions/delete") {
        const payload = await readJsonBody(request);
        const itemIds = parseStringArrayField(payload, "itemIds");
        const report = await runMultiSourceBatch(
          itemIds,
          sessionStore,
          claudeStore,
          (item) => {
            const homeRoot = item.provider === "claude" ? claudeHome : codexHome;
            return trashStore.trashSessionItem(item, homeRoot);
          }
        );
        json(response, 200, report);
        return;
      }

      if (request.method === "GET" && pathname === "/api/trash") {
        json(response, 200, {
          items: await trashStore.listTrashItems()
        });
        return;
      }

      if (request.method === "POST" && pathname === "/api/trash/restore") {
        const payload = await readJsonBody(request);
        const trashIds = parseStringArrayField(payload, "trashIds");
        json(response, 200, await trashStore.restore(trashIds));
        return;
      }

      if (request.method === "POST" && pathname === "/api/trash/purge") {
        const payload = await readJsonBody(request);
        const trashIds = parseStringArrayField(payload, "trashIds");
        json(response, 200, await trashStore.purge(trashIds));
        return;
      }

      if (request.method === "POST" && pathname === "/api/trash/cleanup") {
        json(response, 200, await trashStore.cleanupExpired());
        return;
      }

      if (request.method === "GET") {
        await serveStatic(pathname, response);
        return;
      }

      json(response, 404, { error: "not found" });
    } catch (error) {
      json(response, 500, { error: toErrorMessage(error) });
    }
  });

  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to resolve server address");
  }

  return {
    cleanupReport,
    codexHome,
    claudeHome,
    port: address.port,
    retentionDays,
    server,
    trashRoot,
    url: `http://127.0.0.1:${address.port}`
  };
}

module.exports = {
  startServer
};
