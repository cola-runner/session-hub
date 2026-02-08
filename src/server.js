const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { isPathInsideRoot } = require("./fs-utils");
const { SessionStore } = require("./session-store");
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
  trashRoot,
  retentionDays = 30,
  port = 0
}) {
  const sessionStore = new SessionStore({ codexHome });
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
          trashRoot,
          retentionDays
        });
        return;
      }

      if (request.method === "GET" && pathname === "/api/sessions") {
        json(response, 200, await sessionStore.listSessions());
        return;
      }

      if (request.method === "POST" && pathname === "/api/sessions/archive") {
        const payload = await readJsonBody(request);
        const itemIds = parseStringArrayField(payload, "itemIds");
        const report = await runSessionBatch(itemIds, sessionStore, (item) =>
          sessionStore.archiveItem(item)
        );
        json(response, 200, report);
        return;
      }

      if (request.method === "POST" && pathname === "/api/sessions/unarchive") {
        const payload = await readJsonBody(request);
        const itemIds = parseStringArrayField(payload, "itemIds");
        const report = await runSessionBatch(itemIds, sessionStore, (item) =>
          sessionStore.unarchiveItem(item)
        );
        json(response, 200, report);
        return;
      }

      if (request.method === "POST" && pathname === "/api/sessions/delete") {
        const payload = await readJsonBody(request);
        const itemIds = parseStringArrayField(payload, "itemIds");
        const report = await runSessionBatch(itemIds, sessionStore, (item) =>
          trashStore.trashSessionItem(item)
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
