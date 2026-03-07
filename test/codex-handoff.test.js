const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { handoffToCodexThread, resolveCodexCommand } = require("../src/codex-handoff");

function createMockAppServerChild({
  threadId = "019cbafe-1111-7222-8333-444455556666",
  turnId = "019cbafe-9999-7222-8333-444455556666",
  closeCode = 0,
  emitUserMessageBeforeTurnStartResponse = false,
  turnStatus = "completed"
} = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.requests = [];

  let closed = false;
  let stdinBuffer = "";
  let activeThreadId = threadId;
  let activeTurnId = turnId;

  const emitJson = (payload) => {
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from(`${JSON.stringify(payload)}\n`));
    });
  };

  const emitUserMessage = () => {
    emitJson({
      method: "codex/event/user_message",
      params: {
        threadId: activeThreadId,
        item: {
          type: "userMessage"
        }
      }
    });
  };

  const closeOnce = () => {
    if (closed) {
      return;
    }
    closed = true;
    setImmediate(() => {
      child.emit("close", closeCode);
    });
  };

  child.stdin = {
    write(chunk) {
      stdinBuffer += chunk.toString("utf8");

      let newlineIndex = -1;
      while ((newlineIndex = stdinBuffer.indexOf("\n")) >= 0) {
        const line = stdinBuffer.slice(0, newlineIndex).trim();
        stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
        if (!line) {
          continue;
        }

        const request = JSON.parse(line);
        child.requests.push(request);

        if (request.method === "initialize") {
          emitJson({
            id: request.id,
            result: {
              userAgent: "Codex Desktop/0.107.0"
            }
          });
          continue;
        }

        if (request.method === "initialized") {
          continue;
        }

        if (request.method === "thread/start") {
          activeThreadId = threadId;
          emitJson({
            id: request.id,
            result: {
              thread: {
                id: activeThreadId
              }
            }
          });
          continue;
        }

        if (request.method === "thread/name/set") {
          emitJson({
            id: request.id,
            result: {}
          });
          emitJson({
            method: "thread/name/updated",
            params: {
              threadId: activeThreadId,
              threadName: request.params && typeof request.params.name === "string"
                ? request.params.name
                : null
            }
          });
          continue;
        }

        if (request.method === "turn/start") {
          activeTurnId = turnId;
          if (emitUserMessageBeforeTurnStartResponse) {
            emitUserMessage();
          }
          emitJson({
            id: request.id,
            result: {
              turn: {
                id: activeTurnId,
                items: [],
                status: "inProgress",
                error: null
              }
            }
          });
          if (!emitUserMessageBeforeTurnStartResponse) {
            emitUserMessage();
          }
          emitJson({
            method: "turn/completed",
            params: {
              threadId: activeThreadId,
              turn: {
                id: activeTurnId,
                items: [],
                status: turnStatus,
                error: null
              }
            }
          });
          closeOnce();
          continue;
        }
      }
    },
    end() {
      closeOnce();
    }
  };

  child.kill = () => {
    child.killed = true;
    closeOnce();
    return true;
  };

  return child;
}

function createMockCloseChild(closeCode = 0) {
  const child = new EventEmitter();
  child.killed = false;
  child.unref = () => {};
  child.kill = () => {
    child.killed = true;
    setImmediate(() => {
      child.emit("close", closeCode);
    });
    return true;
  };
  setImmediate(() => {
    child.emit("close", closeCode);
  });
  return child;
}

test("handoffToCodexThread creates thread with never/danger-full-access and injects an inline pack", async () => {
  const spawnCalls = [];
  let appServerChild = null;
  const threadId = "019cbafe-2222-7333-8444-555566667777";
  const turnId = "019cbafe-2222-7333-8444-555566667778";
  const prompt = "## Goal\nCarry the Claude context into this new Codex thread.";
  const threadName = "orbit-notes · Batch archive UI";

  const spawnImpl = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    if (command === "codex" && args[0] === "app-server") {
      appServerChild = createMockAppServerChild({ threadId, turnId });
      return appServerChild;
    }
    if (command === "codex" && args[0] === "app") {
      return {
        unref() {},
        kill() {},
        killed: false
      };
    }
    if (command === "open") {
      return {
        unref() {},
        kill() {},
        killed: false
      };
    }
    throw new Error(`unexpected spawn call: ${command} ${args.join(" ")}`);
  };

  const cwd = "/Users/test/projects/orbit-notes";
  const result = await handoffToCodexThread({
    prompt,
    cwd,
    threadName,
    codexCommand: "codex",
    launchCodexApp: true,
    syncDesktopState: false,
    timeoutMs: 2000,
    spawnImpl,
    platform: "darwin"
  });

  assert.equal(result.threadId, threadId);
  assert.equal(result.turnId, turnId);
  assert.equal(result.launchedCodexApp, true);
  assert.equal(result.mode, "inline-pack");
  assert.equal(result.threadName, threadName);
  assert.equal(result.trimmed, false);
  assert.equal(result.inlineChars, prompt.length);
  assert.equal(result.userMessageNotificationSeen, true);
  assert.equal(result.turnCompletedNotificationSeen, true);
  assert.equal(result.turnStatus, "completed");

  assert.equal(spawnCalls[0].command, "codex");
  assert.deepEqual(spawnCalls[0].args, ["app-server", "--listen", "stdio://"]);
  assert.equal(spawnCalls[0].options.cwd, cwd);

  const threadStartRequest = appServerChild.requests.find((request) => request.method === "thread/start");
  assert.equal(threadStartRequest.params.cwd, cwd);
  assert.equal(threadStartRequest.params.approvalPolicy, "never");
  assert.equal(threadStartRequest.params.sandbox, "danger-full-access");

  const threadNameRequest = appServerChild.requests.find((request) => request.method === "thread/name/set");
  assert.deepEqual(threadNameRequest.params, {
    threadId,
    name: threadName
  });

  const turnStartRequest = appServerChild.requests.find((request) => request.method === "turn/start");
  assert.equal(turnStartRequest.params.threadId, threadId);
  assert.equal(turnStartRequest.params.approvalPolicy, "never");
  assert.deepEqual(turnStartRequest.params.sandboxPolicy, {
    type: "dangerFullAccess"
  });
  assert.match(turnStartRequest.params.input[0].text, /^orbit-notes · Batch archive UI/m);
  assert.match(turnStartRequest.params.input[0].text, /Imported Claude context for this Codex thread/);
  assert.match(turnStartRequest.params.input[0].text, /read the migrated context below in full/i);
  assert.match(turnStartRequest.params.input[0].text, /Do not run tools/);
  assert.match(turnStartRequest.params.input[0].text, /state the current goal or project state/i);
  assert.match(turnStartRequest.params.input[0].text, /ready to continue/i);
  assert.match(turnStartRequest.params.input[0].text, /Carry the Claude context/);
  assert.doesNotMatch(turnStartRequest.params.input[0].text, /Prompt file:/);
  assert.doesNotMatch(turnStartRequest.params.input[0].text, /Context file:/);

  assert.deepEqual(spawnCalls[1], {
    command: "codex",
    args: ["app", cwd],
    options: {
      detached: true,
      stdio: "ignore"
    }
  });
  assert.deepEqual(spawnCalls[2], {
    command: "open",
    args: [`codex://threads/${threadId}`],
    options: {
      detached: true,
      stdio: "ignore"
    }
  });
});

test("handoffToCodexThread still reports launched when deep link open fails", async () => {
  const spawnCalls = [];
  const threadId = "019cbafe-3333-7444-8555-666677778888";

  const spawnImpl = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    if (command === "codex" && args[0] === "app-server") {
      return createMockAppServerChild({
        threadId,
        emitUserMessageBeforeTurnStartResponse: true
      });
    }
    if (command === "codex" && args[0] === "app") {
      return {
        unref() {},
        kill() {},
        killed: false
      };
    }
    if (command === "open") {
      throw new Error("open failed");
    }
    throw new Error(`unexpected spawn call: ${command} ${args.join(" ")}`);
  };

  const cwd = "/Users/test/projects/orbit-notes";
  const result = await handoffToCodexThread({
    prompt: "continue here",
    cwd,
    codexCommand: "codex",
    launchCodexApp: true,
    syncDesktopState: false,
    timeoutMs: 2000,
    spawnImpl,
    platform: "darwin"
  });

  assert.equal(result.threadId, threadId);
  assert.equal(result.turnStatus, "completed");
  assert.equal(result.launchedCodexApp, true);
  assert.equal(result.mode, "inline-pack");
  assert.deepEqual(spawnCalls[1], {
    command: "codex",
    args: ["app", cwd],
    options: {
      detached: true,
      stdio: "ignore"
    }
  });
});

test("handoffToCodexThread still reports launched when workspace open fails but deep link works", async () => {
  const spawnCalls = [];
  const threadId = "019cbafe-4444-7444-8555-666677778888";

  const spawnImpl = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    if (command === "codex" && args[0] === "app-server") {
      return createMockAppServerChild({ threadId });
    }
    if (command === "codex" && args[0] === "app") {
      throw new Error("app launch failed");
    }
    if (command === "open") {
      return {
        unref() {},
        kill() {},
        killed: false
      };
    }
    throw new Error(`unexpected spawn call: ${command} ${args.join(" ")}`);
  };

  const result = await handoffToCodexThread({
    prompt: "continue here",
    cwd: "/Users/test/projects/orbit-notes",
    codexCommand: "codex",
    launchCodexApp: true,
    syncDesktopState: false,
    timeoutMs: 2000,
    spawnImpl,
    platform: "darwin"
  });

  assert.equal(result.threadId, threadId);
  assert.equal(result.launchedCodexApp, true);
  assert.equal(result.mode, "inline-pack");
  assert.equal(spawnCalls.some((call) => call.command === "open"), true);
});

test("handoffToCodexThread updates desktop thread order in CODEX_HOME", async () => {
  const threadId = "019cbafe-5555-7444-8555-666677778888";
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-codex-home-"));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tmpRoot;

  try {
    await fs.writeFile(
      path.join(tmpRoot, ".codex-global-state.json"),
      JSON.stringify({
        "thread-titles": {
          titles: {
            old: "Old"
          },
          order: ["old"]
        }
      }),
      "utf8"
    );

    const spawnImpl = (command, args) => {
      if (command === "codex" && args[0] === "app-server") {
        return createMockAppServerChild({ threadId });
      }
      throw new Error(`unexpected spawn call: ${command} ${args.join(" ")}`);
    };

    const result = await handoffToCodexThread({
      prompt: "continue here",
      cwd: "/Users/test/projects/orbit-notes",
      threadName: "orbit-notes · Continue migration",
      codexCommand: "codex",
      launchCodexApp: false,
      timeoutMs: 2000,
      spawnImpl,
      platform: "darwin"
    });

    assert.equal(result.threadId, threadId);
    assert.equal(result.mode, "inline-pack");
    const saved = JSON.parse(await fs.readFile(path.join(tmpRoot, ".codex-global-state.json"), "utf8"));
    assert.equal(saved["thread-titles"].order[0], threadId);
    assert.equal(saved["thread-titles"].titles[threadId], "orbit-notes · Continue migration");
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("handoffToCodexThread restarts Codex app on macOS before reopening the imported thread", async () => {
  const spawnCalls = [];
  const threadId = "019cbafe-6666-7444-8555-666677778888";
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-codex-restart-"));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = tmpRoot;

  try {
    await fs.writeFile(
      path.join(tmpRoot, ".codex-global-state.json"),
      JSON.stringify({
        "thread-titles": {
          titles: {},
          order: []
        }
      }),
      "utf8"
    );

    const spawnImpl = (command, args, options) => {
      spawnCalls.push({ command, args, options });
      if (command === "codex" && args[0] === "app-server") {
        return createMockAppServerChild({ threadId });
      }
      if (command === "osascript") {
        return createMockCloseChild(0);
      }
      if (command === "codex" && args[0] === "app") {
        return {
          unref() {},
          kill() {},
          killed: false
        };
      }
      if (command === "open") {
        return {
          unref() {},
          kill() {},
          killed: false
        };
      }
      throw new Error(`unexpected spawn call: ${command} ${args.join(" ")}`);
    };

    const result = await handoffToCodexThread({
      prompt: "continue here",
      cwd: "/Users/test/projects/orbit-notes",
      threadName: "orbit-notes · Restart after import",
      codexCommand: "codex",
      launchCodexApp: true,
      restartCodexApp: true,
      timeoutMs: 2000,
      spawnImpl,
      platform: "darwin"
    });

    assert.equal(result.threadId, threadId);
    assert.equal(result.launchedCodexApp, true);
    assert.equal(result.restartedCodexApp, true);
    assert.equal(spawnCalls[1].command, "osascript");
    assert.deepEqual(spawnCalls[1].args, ["-e", 'tell application "Codex" to quit']);
    assert.deepEqual(spawnCalls[2], {
      command: "codex",
      args: ["app", "/Users/test/projects/orbit-notes"],
      options: {
        detached: true,
        stdio: "ignore"
      }
    });
    assert.deepEqual(spawnCalls[3], {
      command: "open",
      args: [`codex://threads/${threadId}`],
      options: {
        detached: true,
        stdio: "ignore"
      }
    });

    const saved = JSON.parse(await fs.readFile(path.join(tmpRoot, ".codex-global-state.json"), "utf8"));
    assert.equal(saved["thread-titles"].order[0], threadId);
    assert.equal(saved["thread-titles"].titles[threadId], "orbit-notes · Restart after import");
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("resolveCodexCommand prefers installed macOS app binary when available", async () => {
  const command = await resolveCodexCommand({
    platform: "darwin",
    fileExistsImpl: async (targetPath) =>
      targetPath === "/Applications/Codex.app/Contents/Resources/codex"
  });

  assert.equal(command, "/Applications/Codex.app/Contents/Resources/codex");
});

test("handoffToCodexThread rewrites ENOENT into a clearer Codex CLI error", async () => {
  const spawnImpl = (command, args) => {
    if (command === "codex" && args[0] === "app-server") {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        write() {},
        end() {}
      };
      child.killed = false;
      child.kill = () => true;
      setImmediate(() => {
        const error = new Error("spawn codex ENOENT");
        error.code = "ENOENT";
        child.emit("error", error);
      });
      return child;
    }
    throw new Error(`unexpected spawn call: ${command} ${args.join(" ")}`);
  };

  await assert.rejects(
    () => handoffToCodexThread({
      prompt: "continue here",
      cwd: "/Users/test/projects/orbit-notes",
      launchCodexApp: false,
      timeoutMs: 2000,
      spawnImpl,
      codexCommand: "codex",
      platform: "darwin"
    }),
    /Codex CLI was not found/
  );
});
