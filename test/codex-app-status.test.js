const assert = require("node:assert/strict");
const test = require("node:test");

const {
  detectCodexAppStatus,
  parsePsProcessList,
  parseWindowsTasklist
} = require("../src/codex-app-status");

test("parsePsProcessList keeps desktop Codex processes and ignores app-server", () => {
  const processes = parsePsProcessList(`
    101 /Applications/Codex.app/Contents/MacOS/Codex /Applications/Codex.app/Contents/MacOS/Codex
    102 /usr/local/bin/codex /usr/local/bin/codex app-server --listen stdio://
    103 Codex Codex
  `);

  assert.deepEqual(
    processes.map((entry) => entry.pid),
    [101, 103]
  );
});

test("parseWindowsTasklist parses Codex.exe rows", () => {
  const processes = parseWindowsTasklist(`
    "Codex.exe","4820","Console","1","120,040 K"
    "Code.exe","5000","Console","1","100,000 K"
  `);

  assert.deepEqual(processes, [{
    pid: 4820,
    command: "Codex.exe",
    args: "Codex.exe"
  }]);
});

test("detectCodexAppStatus reports running state for posix platforms", async () => {
  const status = await detectCodexAppStatus({
    platform: "darwin",
    execFileImpl: async (command, args) => {
      assert.equal(command, "ps");
      assert.deepEqual(args, ["-axo", "pid=,comm=,args="]);
      return {
        stdout: "777 /Applications/Codex.app/Contents/MacOS/Codex /Applications/Codex.app/Contents/MacOS/Codex\n",
        stderr: ""
      };
    }
  });

  assert.equal(status.running, true);
  assert.equal(status.fingerprint, "777");
  assert.equal(status.processes.length, 1);
});

test("detectCodexAppStatus reports not running on Windows when tasklist is empty", async () => {
  const status = await detectCodexAppStatus({
    platform: "win32",
    execFileImpl: async (command, args) => {
      assert.equal(command, "tasklist");
      assert.deepEqual(args, ["/fo", "csv", "/nh", "/fi", "IMAGENAME eq Codex.exe"]);
      return {
        stdout: "INFO: No tasks are running which match the specified criteria.\n",
        stderr: ""
      };
    }
  });

  assert.equal(status.running, false);
  assert.equal(status.fingerprint, null);
  assert.deepEqual(status.processes, []);
});
