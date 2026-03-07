const { execFile } = require("node:child_process");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

function toPosixPath(value) {
  return String(value || "").replaceAll("\\", "/");
}

function looksLikeCodexDesktopProcess(command, args) {
  const normalizedCommand = toPosixPath(command);
  const normalizedArgs = toPosixPath(args);
  const baseName = path.basename(normalizedCommand);
  const combined = `${normalizedCommand} ${normalizedArgs}`;

  if (/\bcodex app-server\b/i.test(combined)) {
    return false;
  }

  if (normalizedCommand.includes("/Codex.app/Contents/MacOS/Codex")) {
    return true;
  }

  if (normalizedArgs.includes("/Codex.app/Contents/MacOS/Codex")) {
    return true;
  }

  if (baseName === "Codex" || baseName === "Codex.exe" || baseName === "codex-desktop") {
    return true;
  }

  return false;
}

function parsePsProcessList(stdout) {
  const processes = [];
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const match = /^(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    const pid = Number.parseInt(match[1], 10);
    const command = match[2];
    const args = match[3] || command;

    if (!Number.isFinite(pid) || !looksLikeCodexDesktopProcess(command, args)) {
      continue;
    }

    processes.push({
      pid,
      command,
      args
    });
  }

  return processes;
}

function parseWindowsTasklist(stdout) {
  const processes = [];
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (line.startsWith("INFO:")) {
      continue;
    }

    const match = /^"([^"]+)","([^"]+)"/.exec(line);
    if (!match) {
      continue;
    }

    const imageName = match[1];
    const pid = Number.parseInt(match[2], 10);
    if (imageName !== "Codex.exe" || !Number.isFinite(pid)) {
      continue;
    }

    processes.push({
      pid,
      command: imageName,
      args: imageName
    });
  }

  return processes;
}

async function runExecFile(execFileImpl, command, args) {
  const result = await execFileImpl(command, args);
  if (typeof result === "string") {
    return { stdout: result, stderr: "" };
  }
  if (result && typeof result === "object") {
    return {
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : ""
    };
  }
  return { stdout: "", stderr: "" };
}

async function listPosixCodexProcesses(execFileImpl) {
  try {
    const { stdout } = await runExecFile(execFileImpl, "ps", ["-axo", "pid=,comm=,args="]);
    return parsePsProcessList(stdout);
  } catch {
    return [];
  }
}

async function listWindowsCodexProcesses(execFileImpl) {
  try {
    const { stdout } = await runExecFile(execFileImpl, "tasklist", [
      "/fo",
      "csv",
      "/nh",
      "/fi",
      "IMAGENAME eq Codex.exe"
    ]);
    return parseWindowsTasklist(stdout);
  } catch {
    return [];
  }
}

async function detectCodexAppStatus(options = {}) {
  const platform = options.platform ? String(options.platform) : process.platform;
  const execFileImpl = options.execFileImpl || execFileAsync;
  const processes = platform === "win32"
    ? await listWindowsCodexProcesses(execFileImpl)
    : await listPosixCodexProcesses(execFileImpl);

  const fingerprint = processes.length > 0
    ? processes
      .map((processInfo) => String(processInfo.pid))
      .sort()
      .join(",")
    : null;

  return {
    checkedAt: new Date().toISOString(),
    platform,
    running: processes.length > 0,
    fingerprint,
    processes
  };
}

module.exports = {
  detectCodexAppStatus,
  looksLikeCodexDesktopProcess,
  parsePsProcessList,
  parseWindowsTasklist
};
