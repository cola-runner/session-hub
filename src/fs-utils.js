const fs = require("node:fs/promises");
const path = require("node:path");

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true });
}

async function walkFiles(rootDirectoryPath) {
  const files = [];

  async function walk(currentPath) {
    let entries;
    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }

  await walk(rootDirectoryPath);
  return files;
}

async function movePath(sourcePath, destinationPath) {
  try {
    await fs.rename(sourcePath, destinationPath);
  } catch (error) {
    if (!error || error.code !== "EXDEV") {
      throw error;
    }
    await fs.copyFile(sourcePath, destinationPath);
    await fs.unlink(sourcePath);
  }
}

function normalizeRelativePath(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function isPathInsideRoot(rootPath, candidatePath) {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedCandidate = path.resolve(candidatePath);
  const rootWithSeparator = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : `${resolvedRoot}${path.sep}`;

  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(rootWithSeparator)
  );
}

function resolvePathWithinRoot(rootPath, relativePath, label = "path") {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw new Error(`${label} is missing`);
  }

  const resolvedRoot = path.resolve(rootPath);
  const resolvedCandidate = path.resolve(resolvedRoot, relativePath);
  if (!isPathInsideRoot(resolvedRoot, resolvedCandidate)) {
    throw new Error(`${label} escapes allowed root`);
  }

  return resolvedCandidate;
}

module.exports = {
  ensureDir,
  isPathInsideRoot,
  movePath,
  normalizeRelativePath,
  pathExists,
  resolvePathWithinRoot,
  walkFiles
};
