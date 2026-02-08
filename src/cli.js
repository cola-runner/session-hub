#!/usr/bin/env node

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { startServer } = require("./server");
const { ensureDir, pathExists } = require("./fs-utils");
const { TrashStore } = require("./trash-store");

function printHelp() {
  console.log(`
codex-history

Usage:
  codex-history start [--codex-home PATH] [--trash-root PATH] [--retention-days N] [--port N] [--no-open]
  codex-history cleanup [--codex-home PATH] [--trash-root PATH] [--retention-days N]
  codex-history install [--bin-dir PATH]
  codex-history uninstall [--bin-dir PATH]

Defaults:
  codex-home: ~/.codex
  trash-root: ~/.codex-trash
  retention-days: 30
`);
}

function parseArgs(argv) {
  const parsed = { _: [], flags: {} };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      parsed._.push(value);
      continue;
    }

    const withoutPrefix = value.slice(2);
    if (withoutPrefix.includes("=")) {
      const [key, raw] = withoutPrefix.split("=", 2);
      parsed.flags[key] = raw;
      continue;
    }

    const nextValue = argv[index + 1];
    if (!nextValue || nextValue.startsWith("--")) {
      parsed.flags[withoutPrefix] = true;
      continue;
    }

    parsed.flags[withoutPrefix] = nextValue;
    index += 1;
  }

  return parsed;
}

function resolvePaths(flags) {
  const codexHome = path.resolve(
    String(flags["codex-home"] || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"))
  );
  const trashRoot = path.resolve(
    String(flags["trash-root"] || path.join(os.homedir(), ".codex-trash"))
  );

  return { codexHome, trashRoot };
}

function parseIntFlag(value, fallbackValue) {
  const asNumber = Number.parseInt(String(value), 10);
  if (!Number.isFinite(asNumber) || asNumber < 0) {
    return fallbackValue;
  }
  return asNumber;
}

function openBrowser(url) {
  let command;
  let args;

  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore"
    });
    child.on("error", () => {
      // Ignore async spawn errors (for example missing open/xdg-open command).
    });
    child.unref();
  } catch {
    // Ignore browser launch failures and continue with server running.
  }
}

async function installBinary(flags) {
  const binDir = path.resolve(
    String(flags["bin-dir"] || path.join(os.homedir(), ".local", "bin"))
  );
  await ensureDir(binDir);

  const launcherPath = path.join(binDir, "codex-history");
  const cliPath = path.resolve(__dirname, "cli.js");
  const script = `#!/usr/bin/env bash\nnode "${cliPath}" "$@"\n`;

  await fs.writeFile(launcherPath, script, { mode: 0o755 });
  await fs.chmod(launcherPath, 0o755);

  console.log(`Installed launcher: ${launcherPath}`);
  const pathParts = (process.env.PATH || "").split(path.delimiter);
  if (!pathParts.includes(binDir)) {
    console.log(`PATH does not include ${binDir}. Add it to run codex-history directly.`);
  }
}

async function uninstallBinary(flags) {
  const binDir = path.resolve(
    String(flags["bin-dir"] || path.join(os.homedir(), ".local", "bin"))
  );
  const launcherPath = path.join(binDir, "codex-history");
  const legacyLauncherPath = path.join(binDir, "codex-session-tool");

  const removedPaths = [];

  if (await pathExists(launcherPath)) {
    await fs.rm(launcherPath, { force: true });
    removedPaths.push(launcherPath);
  }

  if (await pathExists(legacyLauncherPath)) {
    await fs.rm(legacyLauncherPath, { force: true });
    removedPaths.push(legacyLauncherPath);
  }

  if (removedPaths.length === 0) {
    console.log(`No launcher found in ${binDir}`);
    return;
  }

  for (const removedPath of removedPaths) {
    console.log(`Removed launcher: ${removedPath}`);
  }
}

async function runStart(flags) {
  const { codexHome, trashRoot } = resolvePaths(flags);
  const retentionDays = parseIntFlag(flags["retention-days"], 30);
  const port = parseIntFlag(flags.port, 0);
  const shouldOpenBrowser = !Boolean(flags["no-open"]);

  const running = await startServer({
    codexHome,
    trashRoot,
    retentionDays,
    port
  });

  console.log(`Codex History Manager is running on ${running.url}`);
  console.log(`codex-home: ${codexHome}`);
  console.log(`trash-root: ${trashRoot} (retention: ${retentionDays} days)`);
  console.log(
    `expired cleanup at startup: ${running.cleanupReport.succeeded.length} deleted, ${running.cleanupReport.failed.length} failed`
  );

  if (shouldOpenBrowser) {
    openBrowser(running.url);
  }

  const shutdown = () => {
    running.server.close(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function runCleanup(flags) {
  const { codexHome, trashRoot } = resolvePaths(flags);
  const retentionDays = parseIntFlag(flags["retention-days"], 30);

  const trashStore = new TrashStore({
    codexHome,
    trashRoot,
    retentionDays
  });

  const report = await trashStore.cleanupExpired();
  console.log(JSON.stringify(report, null, 2));
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.flags.help || parsed.flags.h) {
    printHelp();
    return;
  }

  const command = parsed._[0] || "start";

  switch (command) {
    case "start":
      await runStart(parsed.flags);
      break;
    case "cleanup":
      await runCleanup(parsed.flags);
      break;
    case "install":
      await installBinary(parsed.flags);
      break;
    case "uninstall":
      await uninstallBinary(parsed.flags);
      break;
    case "-h":
    case "--help":
    case "help":
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
      break;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
