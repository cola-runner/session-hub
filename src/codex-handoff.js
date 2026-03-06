const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const MAX_INLINE_PROMPT_CHARS = 12000;
const MAX_THREAD_NAME_CHARS = 96;
const DESKTOP_STATE_RETRY_ATTEMPTS = 5;
const DESKTOP_STATE_RETRY_DELAY_MS = 150;
const APP_RESTART_SETTLE_DELAY_MS = 1200;

function trySpawnDetached({ spawnImpl = spawn, command, args = [] } = {}) {
  try {
    const child = spawnImpl(command, args, {
      detached: true,
      stdio: "ignore"
    });
    if (child && typeof child.unref === "function") {
      child.unref();
    }
    return true;
  } catch {
    return false;
  }
}

function tryOpenCodexThread({ spawnImpl = spawn, threadId, platform = process.platform } = {}) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId) {
    return false;
  }

  const deepLink = `codex://threads/${normalizedThreadId}`;
  if (platform === "darwin") {
    return trySpawnDetached({ spawnImpl, command: "open", args: [deepLink] });
  }
  if (platform === "win32") {
    return trySpawnDetached({
      spawnImpl,
      command: "cmd",
      args: ["/c", "start", "", deepLink]
    });
  }
  return trySpawnDetached({ spawnImpl, command: "xdg-open", args: [deepLink] });
}

function tryLaunchCodexApp({ spawnImpl = spawn, cwd, threadId, platform = process.platform } = {}) {
  const launchPath = cwd ? String(cwd) : ".";
  const launchedWorkspace = trySpawnDetached({ spawnImpl, command: "codex", args: ["app", launchPath] });
  const openedThread = tryOpenCodexThread({ spawnImpl, threadId, platform });
  return launchedWorkspace || openedThread;
}

async function runCommandBestEffort({
  spawnImpl = spawn,
  command,
  args = [],
  timeoutMs = 5000
} = {}) {
  let child = null;
  try {
    child = spawnImpl(command, args, {
      stdio: "ignore"
    });
  } catch {
    return false;
  }

  if (!child || typeof child.once !== "function") {
    return true;
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        if (!child.killed && typeof child.kill === "function") {
          child.kill("SIGTERM");
        }
      } catch {
        // best effort
      }
      finish(false);
    }, timeoutMs);

    child.once("error", () => finish(false));
    child.once("close", () => finish(true));
  });
}

async function tryRestartCodexApp({ spawnImpl = spawn, platform = process.platform } = {}) {
  if (platform !== "darwin") {
    return false;
  }

  await runCommandBestEffort({
    spawnImpl,
    command: "osascript",
    args: ["-e", 'tell application "Codex" to quit']
  });
  await delay(APP_RESTART_SETTLE_DELAY_MS);
  return true;
}

function appendWithCap(current, chunk) {
  const next = current + chunk;
  if (Buffer.byteLength(next, "utf8") <= MAX_CAPTURE_BYTES) {
    return next;
  }
  return next.slice(-MAX_CAPTURE_BYTES);
}

function projectNameFromCwd(cwd) {
  return String(cwd || "")
    .split(/[\\/]+/)
    .filter(Boolean)
    .pop() || "project";
}

function clipPrompt(prompt) {
  const trimmedPrompt = String(prompt || "").trim();
  if (!trimmedPrompt) {
    return "";
  }
  return trimmedPrompt.length > MAX_INLINE_PROMPT_CHARS
    ? `${trimmedPrompt.slice(0, MAX_INLINE_PROMPT_CHARS)}\n\n[truncated]`
    : trimmedPrompt;
}

function sanitizeThreadName(value, maxLength = MAX_THREAD_NAME_CHARS) {
  const normalized = String(value || "")
    .replace(/\0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "";
  }
  const chars = Array.from(normalized);
  if (chars.length <= maxLength) {
    return normalized;
  }
  return `${chars.slice(0, maxLength - 1).join("")}…`;
}

function defaultThreadName(cwd) {
  const projectName = projectNameFromCwd(cwd);
  return sanitizeThreadName(`Imported from Claude: ${projectName}`);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildHandoffMessage({ prompt, cwd, threadName } = {}) {
  const clippedPrompt = clipPrompt(prompt);
  if (!clippedPrompt) {
    return "";
  }

  const resolvedThreadName = sanitizeThreadName(threadName) || defaultThreadName(cwd);
  return [
    resolvedThreadName,
    "",
    "Imported Claude context for this Codex thread.",
    "",
    "For this first turn only:",
    "- Do not run tools.",
    "- Do not edit files.",
    "- Reply with one short confirmation that the context was loaded.",
    "",
    "Migrated context:",
    "",
    clippedPrompt
  ].join("\n");
}

function parseJsonLine(line) {
  const text = String(line || "").trim();
  if (!text || text[0] !== "{") {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractThreadIdFromUnknownObject(message) {
  if (!message || typeof message !== "object") {
    return null;
  }

  const candidates = [
    message.threadId,
    message.conversationId,
    message.thread_id,
    message.id,
    message.result && message.result.thread && message.result.thread.id,
    message.params && message.params.threadId,
    message.params && message.params.conversationId,
    message.params && message.params.thread && message.params.thread.id
  ];

  for (const candidate of candidates) {
    const value = typeof candidate === "string" ? candidate.trim() : "";
    if (UUID_RE.test(value)) {
      return value;
    }
  }

  return null;
}

function extractTurnIdFromUnknownObject(message) {
  if (!message || typeof message !== "object") {
    return null;
  }

  const candidates = [
    message.turnId,
    message.turn_id,
    message.result && message.result.turn && message.result.turn.id,
    message.params && message.params.turnId,
    message.params && message.params.turn && message.params.turn.id
  ];

  for (const candidate of candidates) {
    const value = typeof candidate === "string" ? candidate.trim() : "";
    if (UUID_RE.test(value)) {
      return value;
    }
  }

  return null;
}

function extractThreadIdFromOutput(outputText) {
  const text = String(outputText || "");
  const match = UUID_RE.exec(text);
  return match ? match[0] : null;
}

async function updateDesktopThreadOrder({ threadId, cwd, threadName } = {}) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!UUID_RE.test(normalizedThreadId)) {
    return;
  }

  const codexHome = process.env.CODEX_HOME
    ? String(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
  const statePath = path.join(codexHome, ".codex-global-state.json");
  const preferredTitle = sanitizeThreadName(threadName) || defaultThreadName(cwd);

  for (let attempt = 0; attempt < DESKTOP_STATE_RETRY_ATTEMPTS; attempt += 1) {
    let parsed;
    try {
      const raw = await fs.readFile(statePath, "utf8");
      parsed = JSON.parse(raw);
    } catch {
      if (attempt + 1 < DESKTOP_STATE_RETRY_ATTEMPTS) {
        await delay(DESKTOP_STATE_RETRY_DELAY_MS);
      }
      continue;
    }

    if (!parsed || typeof parsed !== "object") {
      return;
    }

    const threadTitlesRaw = parsed["thread-titles"];
    const threadTitles = threadTitlesRaw && typeof threadTitlesRaw === "object"
      ? threadTitlesRaw
      : {};
    const titlesRaw = threadTitles.titles;
    const orderRaw = threadTitles.order;

    const titles = titlesRaw && typeof titlesRaw === "object"
      ? { ...titlesRaw }
      : {};
    const order = Array.isArray(orderRaw)
      ? orderRaw.filter((entry) => typeof entry === "string")
      : [];

    titles[normalizedThreadId] = preferredTitle;

    parsed["thread-titles"] = {
      ...threadTitles,
      titles,
      order: [normalizedThreadId, ...order.filter((entry) => entry !== normalizedThreadId)]
    };

    const tmpPath = `${statePath}.tmp-${process.pid}-${Date.now()}-${attempt}`;
    try {
      await fs.writeFile(tmpPath, JSON.stringify(parsed), "utf8");
      await fs.rename(tmpPath, statePath);

      const saved = JSON.parse(await fs.readFile(statePath, "utf8"));
      const savedTitles = saved["thread-titles"] && typeof saved["thread-titles"] === "object"
        ? saved["thread-titles"]
        : {};
      const savedOrder = Array.isArray(savedTitles.order) ? savedTitles.order : [];
      const savedTitlesMap = savedTitles.titles && typeof savedTitles.titles === "object"
        ? savedTitles.titles
        : {};
      if (
        savedOrder[0] === normalizedThreadId
        && savedTitlesMap[normalizedThreadId] === preferredTitle
      ) {
        return;
      }
    } catch {
      try {
        await fs.rm(tmpPath, { force: true });
      } catch {
        // best effort cleanup
      }
    }

    if (attempt + 1 < DESKTOP_STATE_RETRY_ATTEMPTS) {
      await delay(DESKTOP_STATE_RETRY_DELAY_MS);
    }
  }
}

function createAppServerRpcClient({
  spawnImpl = spawn,
  cwd,
  message,
  threadName,
  timeoutMs = 60000
} = {}) {
  const child = spawnImpl("codex", ["app-server", "--listen", "stdio://"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"]
  });

  let settled = false;
  let stdoutCapture = "";
  let stderrCapture = "";
  let stdoutBuffer = "";
  let stderrBuffer = "";

  let nextRequestId = 1;
  let initializeRequestId = null;
  let threadStartRequestId = null;
  let threadNameSetRequestId = null;
  let turnStartRequestId = null;
  const normalizedThreadName = sanitizeThreadName(threadName);

  const state = {
    threadId: null,
    turnId: null,
    userMessageNotificationSeen: false,
    turnCompletedNotificationSeen: false,
    turnStatus: null
  };

  const sendJson = (payload) => {
    if (!child.stdin || typeof child.stdin.write !== "function") {
      throw new Error("codex app-server stdin is unavailable");
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  const sendRequest = (method, params) => {
    const id = `handoff-${nextRequestId++}`;
    sendJson({
      jsonrpc: "2.0",
      id,
      method,
      params
    });
    return id;
  };

    const sendNotification = (method, params) => {
      sendJson({
        jsonrpc: "2.0",
        method,
        params
      });
    };

    const startTurn = () => {
      turnStartRequestId = sendRequest("turn/start", {
        threadId: state.threadId,
        input: [{
          type: "text",
          text: message,
          text_elements: []
        }],
        cwd,
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "dangerFullAccess"
        }
      });
    };

  const closeGracefully = () => {
    if (child.stdin && typeof child.stdin.end === "function") {
      child.stdin.end();
    }
    setTimeout(() => {
      if (!child.killed && typeof child.kill === "function") {
        child.kill("SIGTERM");
      }
    }, 250);
  };

  const resultPromise = new Promise((resolve, reject) => {
    const timeoutTimer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      if (!child.killed && typeof child.kill === "function") {
        child.kill("SIGTERM");
      }
      reject(new Error(`codex app-server handoff timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const clearTimeoutTimer = () => clearTimeout(timeoutTimer);

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeoutTimer();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const succeed = () => {
      if (settled) {
        return;
      }
      if (!state.threadId) {
        fail(new Error("codex app-server did not return a thread id"));
        return;
      }
      settled = true;
      clearTimeoutTimer();
      closeGracefully();
      resolve({
        threadId: state.threadId,
        turnId: state.turnId,
        userMessageNotificationSeen: state.userMessageNotificationSeen,
        turnCompletedNotificationSeen: state.turnCompletedNotificationSeen,
        turnStatus: state.turnStatus
      });
    };

    const processMessage = (messageObj) => {
      if (!messageObj || typeof messageObj !== "object") {
        return;
      }

      const threadIdCandidate = extractThreadIdFromUnknownObject(messageObj);
      if (!state.threadId && threadIdCandidate) {
        state.threadId = threadIdCandidate;
      }

      const turnIdCandidate = extractTurnIdFromUnknownObject(messageObj);
      if (!state.turnId && turnIdCandidate) {
        state.turnId = turnIdCandidate;
      }

      if (Object.prototype.hasOwnProperty.call(messageObj, "id")) {
        const responseId = String(messageObj.id);
        if (messageObj.error) {
          if (responseId === threadNameSetRequestId) {
            threadNameSetRequestId = null;
            startTurn();
            return;
          }
          fail(new Error(`codex app-server request failed (${responseId}): ${JSON.stringify(messageObj.error)}`));
          return;
        }

        if (responseId === initializeRequestId) {
          sendNotification("initialized");
          threadStartRequestId = sendRequest("thread/start", {
            cwd,
            approvalPolicy: "never",
            sandbox: "danger-full-access",
            ephemeral: false
          });
          return;
        }

        if (responseId === threadStartRequestId) {
          if (messageObj.result && messageObj.result.thread && UUID_RE.test(String(messageObj.result.thread.id || ""))) {
            state.threadId = String(messageObj.result.thread.id);
          }
          if (!state.threadId) {
            fail(new Error("codex app-server thread/start response missing thread id"));
            return;
          }

          if (normalizedThreadName) {
            threadNameSetRequestId = sendRequest("thread/name/set", {
              threadId: state.threadId,
              name: normalizedThreadName
            });
          } else {
            startTurn();
          }
          return;
        }

        if (responseId === threadNameSetRequestId) {
          threadNameSetRequestId = null;
          startTurn();
          return;
        }

        if (responseId === turnStartRequestId) {
          if (messageObj.result && messageObj.result.turn && UUID_RE.test(String(messageObj.result.turn.id || ""))) {
            state.turnId = String(messageObj.result.turn.id);
          }
          return;
        }
      }

      const method = typeof messageObj.method === "string" ? messageObj.method : "";
      if (!method) {
        return;
      }

      if (method === "codex/event/user_message") {
        state.userMessageNotificationSeen = true;
        return;
      }

      if (method === "item/started" || method === "item/completed") {
        const itemType = messageObj.params && messageObj.params.item && messageObj.params.item.type;
        if (itemType === "userMessage") {
          state.userMessageNotificationSeen = true;
        }
        return;
      }

      if (method === "turn/completed") {
        const completedThreadId = messageObj.params && messageObj.params.threadId;
        if (state.threadId && completedThreadId && String(completedThreadId) !== state.threadId) {
          return;
        }
        const completedTurnStatus = messageObj.params
          && messageObj.params.turn
          && typeof messageObj.params.turn.status === "string"
            ? messageObj.params.turn.status
            : null;
        state.turnCompletedNotificationSeen = true;
        state.turnStatus = completedTurnStatus;
        if (completedTurnStatus && completedTurnStatus !== "completed") {
          fail(new Error(`codex app-server handoff turn completed with status ${completedTurnStatus}`));
          return;
        }
        succeed();
      }
    };

    const processStreamChunk = (chunkText, streamName) => {
      if (streamName === "stdout") {
        stdoutCapture = appendWithCap(stdoutCapture, chunkText);
        stdoutBuffer += chunkText;
      } else {
        stderrCapture = appendWithCap(stderrCapture, chunkText);
        stderrBuffer += chunkText;
      }

      let newlineIndex = -1;
      const bufferRef = streamName === "stdout" ? () => stdoutBuffer : () => stderrBuffer;
      const assignBuffer = (nextValue) => {
        if (streamName === "stdout") {
          stdoutBuffer = nextValue;
        } else {
          stderrBuffer = nextValue;
        }
      };

      while ((newlineIndex = bufferRef().indexOf("\n")) >= 0) {
        const line = bufferRef().slice(0, newlineIndex).trim();
        assignBuffer(bufferRef().slice(newlineIndex + 1));

        if (!line) {
          continue;
        }

        const parsed = parseJsonLine(line);
        if (parsed) {
          processMessage(parsed);
          continue;
        }

        if (!state.threadId) {
          const threadIdFromLine = extractThreadIdFromOutput(line);
          if (threadIdFromLine) {
            state.threadId = threadIdFromLine;
          }
        }
      }
    };

    child.stdout.on("data", (chunk) => {
      processStreamChunk(chunk.toString("utf8"), "stdout");
    });

    child.stderr.on("data", (chunk) => {
      processStreamChunk(chunk.toString("utf8"), "stderr");
    });

    child.once("error", (error) => {
      fail(error);
    });

    child.once("close", (code) => {
      if (settled) {
        return;
      }

      const combinedOutput = `${stdoutCapture}\n${stderrCapture}`.trim();
      if (!state.threadId && combinedOutput) {
        state.threadId = extractThreadIdFromOutput(combinedOutput);
      }

      if (
        state.threadId
        && state.turnCompletedNotificationSeen
        && (!state.turnStatus || state.turnStatus === "completed")
      ) {
        settled = true;
        clearTimeoutTimer();
        resolve({
          threadId: state.threadId,
          turnId: state.turnId,
          userMessageNotificationSeen: state.userMessageNotificationSeen,
          turnCompletedNotificationSeen: state.turnCompletedNotificationSeen,
          turnStatus: state.turnStatus
        });
        return;
      }

      const details = combinedOutput || `codex app-server closed with exit code ${code}`;
      fail(new Error(`codex app-server handoff did not complete cleanly: ${details}`));
    });

    initializeRequestId = sendRequest("initialize", {
      clientInfo: {
        name: "session-hub-handoff",
        title: "Session Hub Handoff",
        version: "1.0.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
  });

  return resultPromise;
}

/**
 * Create a new Codex thread through app-server and inject handoff content.
 *
 * @param {Object} options
 * @param {string} options.prompt
 * @param {string} [options.promptFilePath]
 * @param {string} [options.contextFilePath]
 * @param {string} [options.cwd]
 * @param {string} [options.mode]
 * @param {boolean} [options.trimmed]
 * @param {number} [options.inlineChars]
 * @param {boolean} [options.launchCodexApp]
 * @param {boolean} [options.restartCodexApp]
 * @param {boolean} [options.syncDesktopState]
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.spawnImpl]
 * @param {string} [options.platform]
 */
async function handoffToCodexThread(options) {
  const prompt = String(options.prompt || "").trim();
  if (!prompt) {
    throw new Error("handoff prompt is empty");
  }

  const cwd = options.cwd ? String(options.cwd) : process.cwd();
  const launchCodexApp = options.launchCodexApp !== false;
  const restartCodexApp = options.restartCodexApp === true;
  const syncDesktopState = options.syncDesktopState !== false;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 60000;
  const spawnImpl = options.spawnImpl || spawn;
  const platform = options.platform ? String(options.platform) : process.platform;
  const handoffMode = options.mode ? String(options.mode) : "inline-pack";
  const threadName = sanitizeThreadName(options.threadName) || defaultThreadName(cwd);
  const inlineChars = Number.isFinite(options.inlineChars)
    ? Number(options.inlineChars)
    : Array.from(prompt).length;
  const message = buildHandoffMessage({
    prompt,
    cwd,
    threadName
  });

  if (!message) {
    throw new Error("handoff message is empty");
  }

  const rpcResult = await createAppServerRpcClient({
    spawnImpl,
    cwd,
    message,
    threadName,
    timeoutMs
  });

  const restartedCodexApp = launchCodexApp && restartCodexApp
    ? await tryRestartCodexApp({ spawnImpl, platform })
    : false;

  if (syncDesktopState) {
    await updateDesktopThreadOrder({
      threadId: rpcResult.threadId,
      cwd,
      threadName
    });
  }

  const launchedCodexApp = launchCodexApp
    ? tryLaunchCodexApp({ spawnImpl, cwd, threadId: rpcResult.threadId, platform })
    : false;

  return {
    threadId: rpcResult.threadId,
    turnId: rpcResult.turnId || null,
    launchedCodexApp,
    restartedCodexApp,
    mode: handoffMode,
    threadName,
    trimmed: options.trimmed === true,
    inlineChars,
    userMessageNotificationSeen: rpcResult.userMessageNotificationSeen,
    turnCompletedNotificationSeen: rpcResult.turnCompletedNotificationSeen,
    turnStatus: rpcResult.turnStatus || null
  };
}

module.exports = {
  handoffToCodexThread
};
