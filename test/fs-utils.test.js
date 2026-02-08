const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { isPathInsideRoot, resolvePathWithinRoot } = require("../src/fs-utils");

test("isPathInsideRoot blocks sibling path with shared prefix", () => {
  const projectRoot = path.resolve(__dirname, "..");
  const webRoot = path.join(projectRoot, "web");
  const siblingPath = path.join(projectRoot, "web-secret", "leak.txt");
  const nestedPath = path.join(webRoot, "assets", "app.js");

  assert.equal(isPathInsideRoot(webRoot, siblingPath), false);
  assert.equal(isPathInsideRoot(webRoot, nestedPath), true);
});

test("resolvePathWithinRoot rejects escaping relative paths", () => {
  const root = path.resolve("/tmp/example-root");
  assert.throws(
    () => resolvePathWithinRoot(root, "../escape.txt", "test path"),
    /escapes allowed root/
  );

  const safePath = resolvePathWithinRoot(root, "nested/file.txt", "test path");
  assert.equal(safePath, path.join(root, "nested/file.txt"));
});
