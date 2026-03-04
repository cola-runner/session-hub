const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");

function parseMaybeJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function extractTurnId(turnStartResponse) {
  if (!turnStartResponse || typeof turnStartResponse !== "object") {
    return null;
  }
  return turnStartResponse.turn?.turnId || turnStartResponse.turn?.id || null;
}

function tryLaunchCodexApp(spawnImpl = spawn) {
  try {
    const child = spawnImpl("codex", ["app"], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function waitForClose(child, timeoutMs = 1500) {
  await Promise.race([
    new Promise((resolve) => {
      child.once("close", resolve);
      child.once("exit", resolve);
      child.once("error", resolve);
    }),
    new Promise((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}

async function waitForPersistedRollout(filePath, timeoutMs = 6000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const stats = await fs.stat(filePath);
      if (stats.size > 0) {
        return true;
      }
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return false;
}

/**
 * Create a new Codex thread and push the transfer prompt into the first turn.
 * This uses the local experimental `codex app-server` protocol over stdio.
 *
 * @param {Object} options
 * @param {string} options.prompt
 * @param {string} [options.cwd]
 * @param {boolean} [options.launchCodexApp]
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.spawnImpl]
 */
async function handoffToCodexThread(options) {
  const prompt = String(options.prompt || "").trim();
  if (!prompt) {
    throw new Error("handoff prompt is empty");
  }

  const cwd = options.cwd ? String(options.cwd) : process.cwd();
  const launchCodexApp = options.launchCodexApp !== false;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 45000;
  const spawnImpl = options.spawnImpl || spawn;

  const child = spawnImpl("codex", ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "pipe"]
  });

  const pending = new Map();
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let threadId = null;
  let threadPath = null;
  let userMessageNotificationSeen = false;
  let turnCompletedNotificationSeen = false;
  let userMessageSeenResolver = null;
  let turnCompletedResolver = null;
  const userMessageSeenPromise = new Promise((resolve) => {
    userMessageSeenResolver = resolve;
  });
  const turnCompletedPromise = new Promise((resolve) => {
    turnCompletedResolver = resolve;
  });

  const settlePendingOnError = (error) => {
    for (const [, pendingEntry] of pending) {
      clearTimeout(pendingEntry.timer);
      pendingEntry.reject(error);
    }
    pending.clear();
  };

  const createRequest = (id, method, params) =>
    JSON.stringify({ id, method, params }) + "\n";

  const sendRequest = (id, method, params) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`codex app-server timeout for method ${method}`));
      }, timeoutMs);
      pending.set(id, {
        resolve,
        reject,
        timer,
        method
      });
      child.stdin.write(createRequest(id, method, params));
    });

  const handleMessage = (message) => {
    if (message && typeof message === "object" && Object.prototype.hasOwnProperty.call(message, "id")) {
      const pendingEntry = pending.get(message.id);
      if (!pendingEntry) {
        return;
      }
      clearTimeout(pendingEntry.timer);
      pending.delete(message.id);
      if (message.error) {
        pendingEntry.reject(
          new Error(`codex app-server ${pendingEntry.method} failed: ${message.error.message || "unknown error"}`)
        );
        return;
      }
      pendingEntry.resolve(message.result || {});
      return;
    }

    if (message && message.method === "codex/event/user_message") {
      userMessageNotificationSeen = true;
      if (userMessageSeenResolver) {
        userMessageSeenResolver(true);
      }
      return;
    }

    if (message && message.method === "turn/completed") {
      turnCompletedNotificationSeen = true;
      if (turnCompletedResolver) {
        turnCompletedResolver(true);
      }
    }
  };

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = stdoutBuffer.indexOf("\n");
      if (!line) {
        continue;
      }
      const parsed = parseMaybeJson(line);
      if (!parsed) {
        continue;
      }
      handleMessage(parsed);
    }
  });

  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString();
  });

  child.once("error", (error) => {
    settlePendingOnError(error instanceof Error ? error : new Error(String(error)));
  });

  try {
    await sendRequest(1, "initialize", {
      clientInfo: {
        name: "session-hub",
        version: "0.2.0"
      }
    });

    const threadStartResponse = await sendRequest(2, "thread/start", { cwd });
    threadId = threadStartResponse.thread?.threadId || threadStartResponse.thread?.id || null;
    threadPath = threadStartResponse.thread?.path || null;
    if (!threadId) {
      throw new Error("codex app-server thread/start did not return thread id");
    }

    const turnStartResponse = await sendRequest(3, "turn/start", {
      threadId,
      input: [{
        type: "text",
        text: prompt
      }]
    });

    // Wait briefly for persisted user-message notification; do not block forever.
    await Promise.race([
      userMessageSeenPromise,
      new Promise((resolve) => setTimeout(resolve, 2500))
    ]);

    const turnId = extractTurnId(turnStartResponse);
    if (turnId) {
      try {
        await sendRequest(4, "turn/interrupt", { threadId, turnId });
      } catch {
        // If the turn already finished, interrupt may fail. Continue.
      }
    }

    await Promise.race([
      turnCompletedPromise,
      new Promise((resolve) => setTimeout(resolve, 8000))
    ]);

    if (threadPath) {
      await waitForPersistedRollout(threadPath, 6000);
    }

    child.stdin.end();
    await waitForClose(child, 5000);
    if (!child.killed) {
      child.kill("SIGTERM");
    }

    return {
      threadId,
      turnId,
      launchedCodexApp: launchCodexApp ? tryLaunchCodexApp(spawnImpl) : false,
      userMessageNotificationSeen,
      turnCompletedNotificationSeen
    };
  } catch (error) {
    child.stdin.end();
    await waitForClose(child, 800);
    if (!child.killed) {
      child.kill("SIGTERM");
    }

    const details = stderrBuffer.trim();
    if (details) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} | ${details}`);
    }
    throw error;
  }
}

module.exports = {
  handoffToCodexThread
};
