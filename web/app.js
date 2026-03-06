/* ── theme ────────────────────────────────────────────── */

function applyTheme(theme) {
  if (theme === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  const btn = document.getElementById("theme-toggle");
  if (btn) {
    btn.textContent = theme === "dark" ? "Light" : "Dark";
  }
}

function getStoredTheme() {
  try {
    return localStorage.getItem("session-hub-theme");
  } catch {
    return null;
  }
}

function setStoredTheme(theme) {
  try {
    localStorage.setItem("session-hub-theme", theme);
  } catch {
    // ignore
  }
}

// Apply immediately to avoid flash
applyTheme(getStoredTheme() || "light");

const URL_PARAMS = new URLSearchParams(window.location.search);
const IS_TRANSFER_MODE = URL_PARAMS.get("mode") === "transfer";
const INITIAL_VIEW = URL_PARAMS.get("view") || "claude";

const state = {
  config: null,
  sessions: [],
  trash: [],
  currentView: INITIAL_VIEW,
  queries: {
    codex: "",
    claude: "",
    gemini: "",
    trash: ""
  },
  stateFilter: {
    codex: "all",
    claude: "all",
    gemini: "all"
  },
  selected: {
    codex: new Set(),
    claude: new Set(),
    gemini: new Set(),
    trash: new Set()
  },
  confirmResolve: null,
  confirmKeyListenerBound: false,
  lastFocusedElement: null,
  confirmCheckboxRequired: false,
  claudeExportPrompt: "",
  claudeExportResult: null,
  transferSelectionBootstrapped: false
};

const dom = {
  configInfo: document.getElementById("config-info"),
  feedback: document.getElementById("feedback"),
  refreshAll: document.getElementById("refresh-all"),
  cleanupExpired: document.getElementById("cleanup-expired"),

  tabCodex: document.getElementById("tab-codex"),
  tabClaude: document.getElementById("tab-claude"),
  tabGemini: document.getElementById("tab-gemini"),
  tabTrash: document.getElementById("tab-trash"),

  viewCodex: document.getElementById("view-codex"),
  viewClaude: document.getElementById("view-claude"),
  viewGemini: document.getElementById("view-gemini"),
  viewTrash: document.getElementById("view-trash"),

  codexQuery: document.getElementById("codex-query"),
  codexSelectFiltered: document.getElementById("codex-select-filtered"),
  codexClearSelection: document.getElementById("codex-clear-selection"),
  codexSelectionMeta: document.getElementById("codex-selection-meta"),
  codexCheckAll: document.getElementById("codex-check-all"),
  codexBody: document.getElementById("codex-body"),
  codexActionArchive: document.getElementById("codex-action-archive"),
  codexActionUnarchive: document.getElementById("codex-action-unarchive"),
  codexActionDelete: document.getElementById("codex-action-delete"),

  claudeQuery: document.getElementById("claude-query"),
  claudeSelectFiltered: document.getElementById("claude-select-filtered"),
  claudeClearSelection: document.getElementById("claude-clear-selection"),
  claudeSelectionMeta: document.getElementById("claude-selection-meta"),
  claudeCheckAll: document.getElementById("claude-check-all"),
  claudeBody: document.getElementById("claude-body"),
  claudeActionArchive: document.getElementById("claude-action-archive"),
  claudeActionUnarchive: document.getElementById("claude-action-unarchive"),
  claudeActionDelete: document.getElementById("claude-action-delete"),
  claudeActionExport: document.getElementById("claude-action-export"),
  claudeActionTransferActive: document.getElementById("claude-action-transfer-active"),
  claudeTransferHint: document.getElementById("claude-transfer-hint"),
  claudeExportResult: document.getElementById("claude-export-result"),
  claudeExportPath: document.getElementById("claude-export-path"),
  claudeTransferStatus: document.getElementById("claude-transfer-status"),
  claudeCopyPrompt: document.getElementById("claude-copy-prompt"),

  geminiQuery: document.getElementById("gemini-query"),
  geminiSelectFiltered: document.getElementById("gemini-select-filtered"),
  geminiClearSelection: document.getElementById("gemini-clear-selection"),
  geminiSelectionMeta: document.getElementById("gemini-selection-meta"),
  geminiCheckAll: document.getElementById("gemini-check-all"),
  geminiBody: document.getElementById("gemini-body"),
  geminiActionArchive: document.getElementById("gemini-action-archive"),
  geminiActionUnarchive: document.getElementById("gemini-action-unarchive"),
  geminiActionDelete: document.getElementById("gemini-action-delete"),

  trashQuery: document.getElementById("trash-query"),
  trashSelectFiltered: document.getElementById("trash-select-filtered"),
  trashClearSelection: document.getElementById("trash-clear-selection"),
  trashSelectionMeta: document.getElementById("trash-selection-meta"),
  trashCheckAll: document.getElementById("trash-check-all"),
  trashBody: document.getElementById("trash-body"),
  actionRestore: document.getElementById("action-restore"),
  actionPurge: document.getElementById("action-purge"),

  confirmModal: document.getElementById("confirm-modal"),
  confirmBackdrop: document.getElementById("confirm-backdrop"),
  confirmTitle: document.getElementById("confirm-title"),
  confirmMessage: document.getElementById("confirm-message"),
  confirmCheckRow: document.getElementById("confirm-check-row"),
  confirmCheckInput: document.getElementById("confirm-check-input"),
  confirmCheckLabel: document.getElementById("confirm-check-label"),
  confirmCancel: document.getElementById("confirm-cancel"),
  confirmAccept: document.getElementById("confirm-accept")
};

function setActiveStateFilter(filterGroup, filterState) {
  const selector = `.state-filter-btn[data-filter="${filterGroup}"]`;
  document.querySelectorAll(selector).forEach((button) => {
    button.classList.toggle("active", button.getAttribute("data-state") === filterState);
  });
}

function configureTransferModeUI() {
  if (!IS_TRANSFER_MODE) {
    return;
  }

  dom.claudeActionArchive.classList.add("hidden");
  dom.claudeActionUnarchive.classList.add("hidden");
  dom.claudeActionDelete.classList.add("hidden");
  dom.claudeActionExport.classList.add("hidden");
  dom.claudeActionTransferActive.classList.remove("hidden");
  dom.claudeTransferHint.classList.remove("hidden");
  dom.claudeSelectFiltered.textContent = "Select Active Projects";
  dom.claudeClearSelection.textContent = "Clear Project Selection";

  state.stateFilter.claude = "active";
  setActiveStateFilter("claude", "active");
}

/* ── helpers ──────────────────────────────────────────── */

function formatBytes(sizeBytes) {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return "0 B";
  }
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = sizeBytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatDate(isoDate) {
  const epoch = Date.parse(isoDate);
  if (!Number.isFinite(epoch)) {
    return "-";
  }
  return new Date(epoch).toLocaleString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function truncateText(value, maxLength = 56) {
  const chars = Array.from(String(value || ""));
  if (chars.length <= maxLength) {
    return chars.join("");
  }
  return `${chars.slice(0, maxLength - 1).join("")}…`;
}

function statePill(sessionState) {
  if (sessionState === "archived") {
    return `<span class="pill archived">archived</span>`;
  }
  return `<span class="pill active">active</span>`;
}

function providerBadge(provider) {
  if (provider === "claude") {
    return `<span class="pill claude">Claude</span>`;
  }
  if (provider === "gemini") {
    return `<span class="pill gemini">Gemini</span>`;
  }
  return `<span class="pill codex">Codex</span>`;
}

function trashExpiryPill(isExpired) {
  if (isExpired) {
    return `<span class="pill expired">expired</span>`;
  }
  return `<span class="pill live">waiting</span>`;
}

function showFeedback(message, type = "ok") {
  dom.feedback.classList.remove("ok", "error", "show");
  dom.feedback.textContent = message;
  dom.feedback.classList.add(type, "show");
}

function summarizeReport(report) {
  const failedPreview = (report.failed || [])
    .slice(0, 3)
    .map((entry) => `${entry.threadId || entry.itemId || entry.trashId}: ${entry.error}`)
    .join(" | ");
  const failedSuffix = failedPreview ? ` | failures: ${failedPreview}` : "";
  return `success ${report.succeededCount || report.succeeded?.length || 0}, failed ${
    report.failedCount || report.failed?.length || 0
  }${failedSuffix}`;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `request failed: ${response.status}`);
  }
  return payload;
}

function toError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function copyTextToClipboard(text) {
  if (!text) {
    throw new Error("nothing to copy");
  }
  if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
    throw new Error("clipboard API is unavailable in this browser");
  }
  await navigator.clipboard.writeText(text);
}

/* ── confirm modal ────────────────────────────────────── */

function closeConfirmModal(accepted) {
  const resolver = state.confirmResolve;
  if (!resolver) {
    return;
  }

  state.confirmResolve = null;
  dom.confirmModal.classList.add("hidden");
  dom.confirmModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");

  if (
    state.lastFocusedElement &&
    typeof state.lastFocusedElement.focus === "function" &&
    document.contains(state.lastFocusedElement)
  ) {
    state.lastFocusedElement.focus();
  }
  state.lastFocusedElement = null;
  state.confirmCheckboxRequired = false;
  dom.confirmCheckInput.checked = false;
  dom.confirmCheckRow.classList.add("hidden");
  dom.confirmAccept.disabled = false;

  resolver(Boolean(accepted));
}

function requestConfirmation({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = true,
  requireCheckboxLabel = ""
}) {
  if (state.confirmResolve) {
    closeConfirmModal(false);
  }

  dom.confirmTitle.textContent = title;
  dom.confirmMessage.textContent = message;
  dom.confirmAccept.textContent = confirmLabel;
  dom.confirmCancel.textContent = cancelLabel;
  dom.confirmAccept.classList.toggle("danger", danger);
  dom.confirmAccept.classList.toggle("primary", !danger);
  const shouldRequireCheckbox = Boolean(requireCheckboxLabel);
  state.confirmCheckboxRequired = shouldRequireCheckbox;
  if (shouldRequireCheckbox) {
    dom.confirmCheckLabel.textContent = requireCheckboxLabel;
    dom.confirmCheckInput.checked = false;
    dom.confirmCheckRow.classList.remove("hidden");
    dom.confirmAccept.disabled = true;
  } else {
    dom.confirmCheckInput.checked = false;
    dom.confirmCheckRow.classList.add("hidden");
    dom.confirmAccept.disabled = false;
  }

  dom.confirmModal.classList.remove("hidden");
  dom.confirmModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  state.lastFocusedElement = document.activeElement;

  return new Promise((resolve) => {
    state.confirmResolve = resolve;
    setTimeout(() => {
      dom.confirmAccept.focus();
    }, 0);
  });
}

/* ── filtering ────────────────────────────────────────── */

function codexSessions() {
  return state.sessions.filter((s) => s.provider === "codex" || !s.provider);
}

function claudeSessions() {
  return state.sessions.filter((s) => s.provider === "claude");
}

function activeClaudeSessions() {
  return claudeSessions().filter((session) => session.state === "active");
}

function claudeProjectKey(session) {
  const relativePath = typeof session.relativePath === "string"
    ? session.relativePath
    : "";
  const parts = relativePath.split("/");
  if (parts.length >= 2 && (parts[0] === "projects" || parts[0] === "archived_sessions")) {
    return `${parts[0]}/${parts[1]}`;
  }
  if (session.projectName) {
    return `name:${session.projectName}`;
  }
  return `thread:${session.threadId || "unknown"}`;
}

function selectedActiveClaudeProjectKeys() {
  const selectedProjectKeys = new Set();
  for (const session of claudeSessions()) {
    if (!state.selected.claude.has(session.itemId)) {
      continue;
    }
    if (session.state !== "active") {
      continue;
    }
    selectedProjectKeys.add(claudeProjectKey(session));
  }
  return selectedProjectKeys;
}

function activeClaudeSessionsForSelectedProjects() {
  const selectedProjectKeys = selectedActiveClaudeProjectKeys();
  if (selectedProjectKeys.size === 0) {
    return [];
  }
  return activeClaudeSessions().filter((session) => selectedProjectKeys.has(claudeProjectKey(session)));
}

function filteredClaudeProjectRows() {
  const grouped = new Map();
  for (const session of filteredClaude()) {
    if (session.state !== "active") {
      continue;
    }
    const projectKey = claudeProjectKey(session);
    if (!grouped.has(projectKey)) {
      grouped.set(projectKey, {
        projectKey,
        projectName: session.projectName || "(unknown-project)",
        itemIds: [],
        sizeBytes: 0,
        latestUpdatedAt: session.updatedAt,
        latestUpdatedAtMs: Date.parse(session.updatedAt) || 0,
        latestTitle: session.title || "Untitled session"
      });
    }

    const row = grouped.get(projectKey);
    row.itemIds.push(session.itemId);
    row.sizeBytes += Number(session.sizeBytes) || 0;

    const updatedAtMs = Date.parse(session.updatedAt) || 0;
    if (updatedAtMs >= row.latestUpdatedAtMs) {
      row.latestUpdatedAtMs = updatedAtMs;
      row.latestUpdatedAt = session.updatedAt;
      row.latestTitle = session.title || row.latestTitle;
    }
  }

  return Array.from(grouped.values())
    .sort((left, right) => right.latestUpdatedAtMs - left.latestUpdatedAtMs)
    .map((row) => {
      return {
        projectKey: row.projectKey,
        projectName: row.projectName,
        itemIds: row.itemIds,
        sessionCount: row.itemIds.length,
        sizeBytes: row.sizeBytes,
        latestUpdatedAt: row.latestUpdatedAt,
        latestTitle: row.latestTitle
      };
    });
}

function applyClaudeProjectSelection(projectRows, shouldSelect) {
  for (const project of projectRows) {
    for (const itemId of project.itemIds) {
      if (shouldSelect) {
        state.selected.claude.add(itemId);
      } else {
        state.selected.claude.delete(itemId);
      }
    }
  }
}

function setFilteredClaudeProjectSelection(shouldSelect) {
  applyClaudeProjectSelection(filteredClaudeProjectRows(), shouldSelect);
}

function filteredCodex() {
  const query = state.queries.codex.trim().toLowerCase();
  const stateF = state.stateFilter.codex;
  return codexSessions().filter((session) => {
    if (stateF !== "all" && session.state !== stateF) {
      return false;
    }
    if (!query) {
      return true;
    }
    const text = `${session.title || ""} ${session.threadId} ${session.fileName} ${
      session.relativePath || ""
    } ${session.state}`.toLowerCase();
    return text.includes(query);
  });
}

function filteredClaude() {
  const query = state.queries.claude.trim().toLowerCase();
  const stateF = state.stateFilter.claude;
  return claudeSessions().filter((session) => {
    if (stateF !== "all" && session.state !== stateF) {
      return false;
    }
    if (!query) {
      return true;
    }
    const text = `${session.title || ""} ${session.threadId} ${session.projectName || ""} ${
      session.gitBranch || ""
    } ${session.state}`.toLowerCase();
    return text.includes(query);
  });
}

function geminiSessions() {
  return state.sessions.filter((s) => s.provider === "gemini");
}

function filteredGemini() {
  const query = state.queries.gemini.trim().toLowerCase();
  const stateF = state.stateFilter.gemini;
  return geminiSessions().filter((session) => {
    if (stateF !== "all" && session.state !== stateF) {
      return false;
    }
    if (!query) {
      return true;
    }
    const text = `${session.title || ""} ${session.threadId} ${session.projectHash || ""} ${
      session.state
    }`.toLowerCase();
    return text.includes(query);
  });
}

function filteredTrash() {
  const query = state.queries.trash.trim().toLowerCase();
  return state.trash.filter((item) => {
    if (!query) {
      return true;
    }
    const text =
      `${item.threadId || ""} ${item.fileName || ""} ${item.originalRelativePath || ""} ${
        item.trashId || ""
      } ${item.provider || ""}`.toLowerCase();
    return text.includes(query);
  });
}

/* ── view switching ───────────────────────────────────── */

function setCurrentView(viewName) {
  state.currentView = viewName;

  dom.viewCodex.classList.toggle("hidden", viewName !== "codex");
  dom.viewClaude.classList.toggle("hidden", viewName !== "claude");
  dom.viewGemini.classList.toggle("hidden", viewName !== "gemini");
  dom.viewTrash.classList.toggle("hidden", viewName !== "trash");

  dom.tabCodex.classList.toggle("active", viewName === "codex");
  dom.tabClaude.classList.toggle("active", viewName === "claude");
  dom.tabGemini.classList.toggle("active", viewName === "gemini");
  dom.tabTrash.classList.toggle("active", viewName === "trash");

  dom.tabCodex.setAttribute("aria-selected", String(viewName === "codex"));
  dom.tabClaude.setAttribute("aria-selected", String(viewName === "claude"));
  dom.tabGemini.setAttribute("aria-selected", String(viewName === "gemini"));
  dom.tabTrash.setAttribute("aria-selected", String(viewName === "trash"));
}

/* ── selection helpers ────────────────────────────────── */

function applySelection(selectedSet, rows, idField, shouldSelect) {
  for (const row of rows) {
    const id = row[idField];
    if (shouldSelect) {
      selectedSet.add(id);
    } else {
      selectedSet.delete(id);
    }
  }
}

function countSelectedRows(selectedSet, rows, idField) {
  return rows.filter((row) => selectedSet.has(row[idField])).length;
}

function pruneSelectionSet(selectedSet, validIds) {
  for (const selected of Array.from(selectedSet)) {
    if (!validIds.has(selected)) {
      selectedSet.delete(selected);
    }
  }
}

/* ── render: Codex ────────────────────────────────────── */

function renderCodex() {
  const rows = filteredCodex();
  const selectedSet = state.selected.codex;

  dom.codexBody.innerHTML = "";
  for (const session of rows) {
    const title = session.title || "Untitled session";
    const displayTitle = truncateText(title, 62);
    const displayThreadId = truncateText(session.threadId, 14);

    const row = document.createElement("tr");
    row.innerHTML = `
      <td><input type="checkbox" data-session-id="${session.itemId}" /></td>
      <td class="title-cell" title="${escapeHtml(title)}">${escapeHtml(displayTitle)}</td>
      <td>${statePill(session.state)}</td>
      <td title="${escapeHtml(session.threadId)}">${escapeHtml(displayThreadId)}</td>
      <td>${formatDate(session.updatedAt)}</td>
      <td>${formatBytes(session.sizeBytes)}</td>
      <td title="${escapeHtml(session.relativePath || "")}">${escapeHtml(
      truncateText(session.relativePath || "", 48)
    )}</td>
    `;
    dom.codexBody.appendChild(row);
  }

  dom.codexBody.querySelectorAll("input[type=checkbox]").forEach((checkbox) => {
    const id = checkbox.getAttribute("data-session-id");
    checkbox.checked = selectedSet.has(id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        selectedSet.add(id);
      } else {
        selectedSet.delete(id);
      }
      renderSelectionMeta();
    });
  });

  const selectedInRows = countSelectedRows(selectedSet, rows, "itemId");
  dom.codexCheckAll.checked = rows.length > 0 && selectedInRows === rows.length;
  renderSelectionMeta();
}

/* ── render: Claude ───────────────────────────────────── */

function renderClaude() {
  if (IS_TRANSFER_MODE) {
    const projectRows = filteredClaudeProjectRows();
    const projectByKey = new Map(projectRows.map((project) => [project.projectKey, project]));
    const selectedSet = state.selected.claude;

    dom.claudeBody.innerHTML = "";
    for (const project of projectRows) {
      const projectName = project.projectName || "(unknown-project)";
      const displayProject = truncateText(projectName, 62);

      const row = document.createElement("tr");
      row.innerHTML = `
      <td><input type="checkbox" data-project-key="${escapeHtml(project.projectKey)}" /></td>
      <td class="title-cell" title="${escapeHtml(projectName)}">${escapeHtml(displayProject)}</td>
      <td>${project.sessionCount}</td>
      <td>${formatDate(project.latestUpdatedAt)}</td>
      <td>${formatBytes(project.sizeBytes)}</td>
    `;
      dom.claudeBody.appendChild(row);
    }

    dom.claudeBody.querySelectorAll("input[type=checkbox]").forEach((checkbox) => {
      const projectKey = checkbox.getAttribute("data-project-key");
      const project = projectByKey.get(projectKey);
      if (!project) {
        return;
      }
      const selectedCount = project.itemIds.filter((itemId) => selectedSet.has(itemId)).length;
      checkbox.checked = selectedCount === project.itemIds.length && project.itemIds.length > 0;
      checkbox.indeterminate = selectedCount > 0 && selectedCount < project.itemIds.length;
      checkbox.addEventListener("change", () => {
        applyClaudeProjectSelection([project], checkbox.checked);
        renderClaude();
      });
    });

    const selectedProjects = projectRows.filter((project) =>
      project.itemIds.every((itemId) => selectedSet.has(itemId))
    ).length;
    dom.claudeCheckAll.checked = projectRows.length > 0 && selectedProjects === projectRows.length;
    renderSelectionMeta();
    return;
  }

  const rows = filteredClaude();
  const selectedSet = state.selected.claude;

  dom.claudeBody.innerHTML = "";
  for (const session of rows) {
    const project = session.projectName || "-";
    const displayProject = truncateText(project, 62);

    const row = document.createElement("tr");
    row.innerHTML = `
      <td><input type="checkbox" data-session-id="${session.itemId}" /></td>
      <td class="title-cell" title="${escapeHtml(project)}">${escapeHtml(displayProject)}</td>
      <td>${session.messageCount || 0}</td>
      <td>${formatDate(session.updatedAt)}</td>
      <td>${formatBytes(session.sizeBytes)}</td>
    `;
    dom.claudeBody.appendChild(row);
  }

  dom.claudeBody.querySelectorAll("input[type=checkbox]").forEach((checkbox) => {
    const id = checkbox.getAttribute("data-session-id");
    checkbox.checked = selectedSet.has(id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        selectedSet.add(id);
      } else {
        selectedSet.delete(id);
      }
      renderClaude();
    });
  });

  const selectedInRows = countSelectedRows(selectedSet, rows, "itemId");
  dom.claudeCheckAll.checked = rows.length > 0 && selectedInRows === rows.length;
  renderSelectionMeta();
}

/* ── render: Gemini ───────────────────────────────────── */

function renderGemini() {
  const rows = filteredGemini();
  const selectedSet = state.selected.gemini;

  dom.geminiBody.innerHTML = "";
  for (const session of rows) {
    const title = session.title || "Untitled session";
    const displayTitle = truncateText(title, 62);
    const hash = session.projectHash || "-";

    const row = document.createElement("tr");
    row.innerHTML = `
      <td><input type="checkbox" data-session-id="${session.itemId}" /></td>
      <td class="title-cell" title="${escapeHtml(title)}">${escapeHtml(displayTitle)}</td>
      <td>${statePill(session.state)}</td>
      <td title="${escapeHtml(hash)}">${escapeHtml(truncateText(hash, 16))}</td>
      <td>${session.messageCount || 0}</td>
      <td>${formatDate(session.updatedAt)}</td>
      <td>${formatBytes(session.sizeBytes)}</td>
    `;
    dom.geminiBody.appendChild(row);
  }

  dom.geminiBody.querySelectorAll("input[type=checkbox]").forEach((checkbox) => {
    const id = checkbox.getAttribute("data-session-id");
    checkbox.checked = selectedSet.has(id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        selectedSet.add(id);
      } else {
        selectedSet.delete(id);
      }
      renderSelectionMeta();
    });
  });

  const selectedInRows = countSelectedRows(selectedSet, rows, "itemId");
  dom.geminiCheckAll.checked = rows.length > 0 && selectedInRows === rows.length;
  renderSelectionMeta();
}

/* ── render: Trash ────────────────────────────────────── */

function renderTrash() {
  const rows = filteredTrash();
  dom.trashBody.innerHTML = "";

  for (const item of rows) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><input type="checkbox" data-trash-id="${item.trashId}" /></td>
      <td>${trashExpiryPill(item.expired)}</td>
      <td>${providerBadge(item.provider || "codex")}</td>
      <td title="${escapeHtml(item.threadId || "-")}">${escapeHtml(
      truncateText(item.threadId || "-", 16)
    )}</td>
      <td>${formatDate(item.deletedAt)}</td>
      <td>${formatDate(item.expiresAt)}</td>
      <td>${formatBytes(item.sizeBytes)}</td>
      <td title="${escapeHtml(item.originalRelativePath || "")}">${escapeHtml(
      truncateText(item.originalRelativePath || "-", 48)
    )}</td>
    `;
    dom.trashBody.appendChild(row);
  }

  dom.trashBody.querySelectorAll("input[type=checkbox]").forEach((checkbox) => {
    const id = checkbox.getAttribute("data-trash-id");
    checkbox.checked = state.selected.trash.has(id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        state.selected.trash.add(id);
      } else {
        state.selected.trash.delete(id);
      }
      renderSelectionMeta();
    });
  });

  const selectedInRows = countSelectedRows(state.selected.trash, rows, "trashId");
  dom.trashCheckAll.checked = rows.length > 0 && selectedInRows === rows.length;
  renderSelectionMeta();
}

/* ── selection meta + button state ────────────────────── */

function renderSelectionMeta() {
  const codexTotal = codexSessions().length;
  const claudeTotal = claudeSessions().length;
  const geminiTotal = geminiSessions().length;
  const selectedClaudeProjects = selectedActiveClaudeProjectKeys().size;
  const totalActiveClaudeProjects = new Set(activeClaudeSessions().map((session) => claudeProjectKey(session))).size;

  dom.codexSelectionMeta.textContent = `${state.selected.codex.size} selected / ${codexTotal} total`;
  dom.claudeSelectionMeta.textContent = IS_TRANSFER_MODE
    ? `${state.selected.claude.size} sessions selected / ${claudeTotal} total | ${selectedClaudeProjects}/${totalActiveClaudeProjects} projects queued`
    : `${state.selected.claude.size} selected / ${claudeTotal} total`;
  dom.geminiSelectionMeta.textContent = `${state.selected.gemini.size} selected / ${geminiTotal} total`;
  dom.trashSelectionMeta.textContent = `${state.selected.trash.size} selected / ${state.trash.length} total`;

  // Codex buttons: archive only for active, unarchive only for archived
  const codexSelectedItems = codexSessions().filter((s) => state.selected.codex.has(s.itemId));
  const hasActiveSelected = codexSelectedItems.some((s) => s.state === "active");
  const hasArchivedSelected = codexSelectedItems.some((s) => s.state === "archived");

  dom.codexActionArchive.disabled = !hasActiveSelected;
  dom.codexActionUnarchive.disabled = !hasArchivedSelected;
  dom.codexActionDelete.disabled = state.selected.codex.size === 0;

  const claudeSelectedItems = claudeSessions().filter((s) => state.selected.claude.has(s.itemId));
  const hasClaudeActiveSelected = claudeSelectedItems.some((s) => s.state === "active");
  const hasClaudeArchivedSelected = claudeSelectedItems.some((s) => s.state === "archived");

  dom.claudeActionArchive.disabled = !hasClaudeActiveSelected;
  dom.claudeActionUnarchive.disabled = !hasClaudeArchivedSelected;
  dom.claudeActionDelete.disabled = state.selected.claude.size === 0;
  dom.claudeActionExport.disabled = state.selected.claude.size === 0;
  dom.claudeActionTransferActive.disabled = selectedClaudeProjects === 0;
  if (IS_TRANSFER_MODE) {
    dom.claudeActionTransferActive.textContent = selectedClaudeProjects > 0
      ? `Transfer ${selectedClaudeProjects} Selected Project${selectedClaudeProjects > 1 ? "s" : ""} To Codex`
      : "Transfer Selected Projects To Codex";
  }

  const geminiSelectedItems = geminiSessions().filter((s) => state.selected.gemini.has(s.itemId));
  const hasGeminiActiveSelected = geminiSelectedItems.some((s) => s.state === "active");
  const hasGeminiArchivedSelected = geminiSelectedItems.some((s) => s.state === "archived");

  dom.geminiActionArchive.disabled = !hasGeminiActiveSelected;
  dom.geminiActionUnarchive.disabled = !hasGeminiArchivedSelected;
  dom.geminiActionDelete.disabled = state.selected.gemini.size === 0;

  dom.actionRestore.disabled = state.selected.trash.size === 0;
  dom.actionPurge.disabled = state.selected.trash.size === 0;
}

function renderTabCounts() {
  const codexAll = codexSessions();
  const claudeAll = claudeSessions();
  const geminiAll = geminiSessions();
  const codexActive = codexAll.filter((s) => s.state === "active").length;
  const codexArchived = codexAll.filter((s) => s.state === "archived").length;
  const claudeActive = claudeAll.filter((s) => s.state === "active").length;
  const claudeArchived = claudeAll.filter((s) => s.state === "archived").length;
  const geminiActive = geminiAll.filter((s) => s.state === "active").length;
  const geminiArchived = geminiAll.filter((s) => s.state === "archived").length;
  const trashCount = state.trash.length;

  dom.tabCodex.textContent = `Codex (${codexAll.length})`;
  dom.tabClaude.textContent = `Claude (${claudeAll.length})`;
  dom.tabGemini.textContent = `Gemini (${geminiAll.length})`;
  dom.tabTrash.textContent = `Trash (${trashCount})`;

  // Update state filter button labels with counts
  document.querySelectorAll("[data-filter=codex]").forEach((btn) => {
    const s = btn.getAttribute("data-state");
    if (s === "all") btn.textContent = `All (${codexAll.length})`;
    else if (s === "active") btn.textContent = `Active (${codexActive})`;
    else if (s === "archived") btn.textContent = `Archived (${codexArchived})`;
  });
  document.querySelectorAll("[data-filter=claude]").forEach((btn) => {
    const s = btn.getAttribute("data-state");
    if (s === "all") btn.textContent = `All (${claudeAll.length})`;
    else if (s === "active") btn.textContent = `Active (${claudeActive})`;
    else if (s === "archived") btn.textContent = `Archived (${claudeArchived})`;
  });
  document.querySelectorAll("[data-filter=gemini]").forEach((btn) => {
    const s = btn.getAttribute("data-state");
    if (s === "all") btn.textContent = `All (${geminiAll.length})`;
    else if (s === "active") btn.textContent = `Active (${geminiActive})`;
    else if (s === "archived") btn.textContent = `Archived (${geminiArchived})`;
  });
}

function sanitizeSelections() {
  const codexIds = new Set(codexSessions().map((s) => s.itemId));
  const claudeIds = new Set(claudeSessions().map((s) => s.itemId));
  const geminiIds = new Set(geminiSessions().map((s) => s.itemId));
  const trashIds = new Set(state.trash.map((item) => item.trashId));

  pruneSelectionSet(state.selected.codex, codexIds);
  pruneSelectionSet(state.selected.claude, claudeIds);
  pruneSelectionSet(state.selected.gemini, geminiIds);
  pruneSelectionSet(state.selected.trash, trashIds);
}

/* ── data loading ─────────────────────────────────────── */

async function loadConfig() {
  state.config = await requestJson("/api/config");
  dom.configInfo.textContent = `codex-home: ${state.config.codexHome} | claude-home: ${state.config.claudeHome} | gemini-home: ${state.config.geminiHome} | trash: ${state.config.trashRoot} | retention: ${state.config.retentionDays} days`;
}

async function loadSessions() {
  const response = await requestJson("/api/sessions");
  state.sessions = response.items || [];
}

async function loadTrash() {
  const response = await requestJson("/api/trash");
  state.trash = response.items || [];
}

function renderClaudeExportResult() {
  if (IS_TRANSFER_MODE) {
    dom.claudeExportResult.classList.add("hidden");
    dom.claudeExportPath.textContent = "";
    dom.claudeTransferStatus.textContent = "";
    dom.claudeTransferStatus.classList.add("hidden");
    dom.claudeCopyPrompt.textContent = "Copy Import Prompt";
    dom.claudeCopyPrompt.disabled = true;
    return;
  }

  if (!state.claudeExportResult) {
    dom.claudeExportResult.classList.add("hidden");
    dom.claudeExportPath.textContent = "";
    dom.claudeTransferStatus.textContent = "";
    dom.claudeTransferStatus.classList.add("hidden");
    dom.claudeCopyPrompt.textContent = "Copy Import Prompt";
    dom.claudeCopyPrompt.disabled = true;
    return;
  }

  const result = state.claudeExportResult;
  if (result.batch) {
    const batch = result.batch;
    dom.claudeExportPath.textContent =
      `Transferred ${batch.sessionCount} session(s) from ${batch.projectCount} project(s).`;

    const cliFallback = batch.handoffSuccessCount > 0
      ? " App not opened? run `codex resume --all` in terminal."
      : "";

    if (batch.errors.length > 0) {
      const preview = batch.errors.slice(0, 2).join(" | ");
      dom.claudeTransferStatus.textContent =
        `Created ${batch.handoffSuccessCount} Codex session(s). Issues: ${preview}${batch.errors.length > 2 ? " ..." : ""}${cliFallback}`;
    } else if (batch.threadRefs.length > 0) {
      const preview = batch.threadRefs.slice(0, 2).join(" | ");
      dom.claudeTransferStatus.textContent =
        `Created ${batch.handoffSuccessCount} Codex session(s). Threads: ${preview}${batch.threadRefs.length > 2 ? " ..." : ""}${cliFallback}`;
    } else {
      dom.claudeTransferStatus.textContent =
        `Created ${batch.handoffSuccessCount} Codex session(s).${cliFallback}`;
    }
    dom.claudeTransferStatus.classList.remove("hidden");
    dom.claudeCopyPrompt.textContent = "Copy Import Prompt (Single Export Only)";
    dom.claudeCopyPrompt.disabled = true;
    dom.claudeExportResult.classList.remove("hidden");
    return;
  }

  dom.claudeExportPath.textContent =
    `Exported ${result.stats?.sessionCount || 0} session(s), ${result.stats?.eventCount || 0} events to ${result.exportDir}`;
  if (result.codexHandoff && result.codexHandoff.ok) {
    const threadSuffix = result.codexHandoff.threadId ? ` (thread ${result.codexHandoff.threadId})` : "";
    const fallbackHint = result.codexHandoff.launchedCodexApp === false
      ? ` App not opened? run \`codex resume ${result.codexHandoff.threadId || "--all"}\`.`
      : "";
    dom.claudeTransferStatus.textContent = `Transferred to Codex${threadSuffix}. Continue in Codex now.${fallbackHint}`;
    dom.claudeTransferStatus.classList.remove("hidden");
    dom.claudeCopyPrompt.textContent = "Copy Import Prompt (Fallback)";
  } else if (result.codexHandoff && result.codexHandoff.ok === false) {
    dom.claudeTransferStatus.textContent =
      `Auto transfer to Codex failed: ${result.codexHandoff.error}. Use the copy button as fallback.`;
    dom.claudeTransferStatus.classList.remove("hidden");
    dom.claudeCopyPrompt.textContent = "Copy Import Prompt";
  } else {
    dom.claudeTransferStatus.textContent = "";
    dom.claudeTransferStatus.classList.add("hidden");
    dom.claudeCopyPrompt.textContent = "Copy Import Prompt";
  }
  dom.claudeExportResult.classList.remove("hidden");
  dom.claudeCopyPrompt.disabled = !state.claudeExportPrompt;
}

function renderAll() {
  renderTabCounts();
  renderCodex();
  renderClaude();
  renderClaudeExportResult();
  renderGemini();
  renderTrash();
}

function bootstrapTransferSelectionIfNeeded() {
  if (!IS_TRANSFER_MODE || state.transferSelectionBootstrapped) {
    return;
  }

  state.stateFilter.claude = "active";
  setActiveStateFilter("claude", "active");
  state.transferSelectionBootstrapped = true;
}

async function refreshAll() {
  await Promise.all([loadConfig(), loadSessions(), loadTrash()]);
  sanitizeSelections();
  bootstrapTransferSelectionIfNeeded();
  renderAll();
}

/* ── actions ──────────────────────────────────────────── */

async function runCodexAction(actionName) {
  const selectedSet = state.selected.codex;
  let itemIds = Array.from(selectedSet);
  if (itemIds.length === 0) {
    showFeedback("No sessions selected.", "error");
    return;
  }

  // For archive/unarchive, filter to only applicable items
  if (actionName === "archive") {
    const activeIds = new Set(codexSessions().filter((s) => s.state === "active").map((s) => s.itemId));
    itemIds = itemIds.filter((id) => activeIds.has(id));
    if (itemIds.length === 0) {
      showFeedback("No active sessions selected to archive.", "error");
      return;
    }
  }
  if (actionName === "unarchive") {
    const archivedIds = new Set(codexSessions().filter((s) => s.state === "archived").map((s) => s.itemId));
    itemIds = itemIds.filter((id) => archivedIds.has(id));
    if (itemIds.length === 0) {
      showFeedback("No archived sessions selected to unarchive.", "error");
      return;
    }
  }

  if (actionName === "delete") {
    const accepted = await requestConfirmation({
      title: "Move sessions to trash?",
      message: `Move ${itemIds.length} Codex session(s) to trash?\n\nThis is a soft delete and can be restored until expiration.`,
      confirmLabel: "Move To Trash",
      cancelLabel: "Keep Sessions",
      danger: true
    });
    if (!accepted) {
      return;
    }
  }

  const report = await requestJson(`/api/sessions/${actionName}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ itemIds })
  });

  showFeedback(`${actionName}: ${summarizeReport(report)}`, report.failedCount ? "error" : "ok");
  selectedSet.clear();
  await Promise.all([loadSessions(), loadTrash()]);
  sanitizeSelections();
  renderAll();
}

async function runClaudeAction(actionName) {
  const selectedSet = state.selected.claude;
  let itemIds = Array.from(selectedSet);
  if (itemIds.length === 0) {
    showFeedback("No sessions selected.", "error");
    return;
  }

  if (actionName === "archive") {
    const activeIds = new Set(claudeSessions().filter((s) => s.state === "active").map((s) => s.itemId));
    itemIds = itemIds.filter((id) => activeIds.has(id));
    if (itemIds.length === 0) {
      showFeedback("No active sessions selected to archive.", "error");
      return;
    }
  }
  if (actionName === "unarchive") {
    const archivedIds = new Set(claudeSessions().filter((s) => s.state === "archived").map((s) => s.itemId));
    itemIds = itemIds.filter((id) => archivedIds.has(id));
    if (itemIds.length === 0) {
      showFeedback("No archived sessions selected to unarchive.", "error");
      return;
    }
  }

  if (actionName === "delete") {
    const accepted = await requestConfirmation({
      title: "Move sessions to trash?",
      message: `Move ${itemIds.length} Claude session(s) to trash?\n\nThis is a soft delete and can be restored until expiration.`,
      confirmLabel: "Move To Trash",
      cancelLabel: "Keep Sessions",
      danger: true
    });
    if (!accepted) {
      return;
    }
  }

  const report = await requestJson(`/api/sessions/${actionName}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ itemIds })
  });

  showFeedback(`${actionName}: ${summarizeReport(report)}`, report.failedCount ? "error" : "ok");
  selectedSet.clear();
  await Promise.all([loadSessions(), loadTrash()]);
  sanitizeSelections();
  renderAll();
}

async function requestClaudeExport(itemIds, options = {}) {
  return requestJson("/api/claude/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      itemIds,
      ownershipConfirmed: true,
      includeSubagents: true,
      compression: "three-layer",
      budgetStrategy: "layered-trim",
      handoffToCodex: Boolean(options.handoffToCodex),
      launchCodexApp: options.launchCodexApp !== false
    })
  });
}

async function runClaudeExportByItemIds(itemIds, confirmationTitle, confirmationMessage, options = {}) {
  if (itemIds.length === 0) {
    showFeedback("No Claude sessions selected.", "error");
    return;
  }

  const accepted = await requestConfirmation({
    title: confirmationTitle,
    message: confirmationMessage,
    confirmLabel: options.confirmLabel || "Export",
    cancelLabel: "Cancel",
    danger: false,
    requireCheckboxLabel: "I confirm these sessions belong to me and were generated on this device."
  });
  if (!accepted) {
    return;
  }

  const exported = await requestClaudeExport(itemIds, options);

  state.claudeExportResult = exported;
  state.claudeExportPrompt = exported.promptText || "";
  renderClaudeExportResult();
  if (exported.codexHandoff && exported.codexHandoff.ok) {
    const threadSuffix = exported.codexHandoff.threadId ? ` (thread ${exported.codexHandoff.threadId})` : "";
    showFeedback(
      `transfer: created Codex session${threadSuffix}. sessions ${exported.stats?.sessionCount || 0}, events ${exported.stats?.eventCount || 0}`,
      "ok"
    );
  } else if (exported.codexHandoff && exported.codexHandoff.ok === false) {
    showFeedback(
      `transfer: exported locally, but auto handoff failed (${exported.codexHandoff.error})`,
      "error"
    );
  } else {
    showFeedback(
      `export: sessions ${exported.stats?.sessionCount || 0}, events ${exported.stats?.eventCount || 0}, evidence ${exported.stats?.selectedEvidenceCount || 0}`,
      "ok"
    );
  }
  await loadSessions();
  sanitizeSelections();
  renderAll();
}

async function runClaudeExport() {
  const itemIds = Array.from(state.selected.claude);
  const confirmationTitle = "Export selected Claude sessions?";
  const confirmationMessage =
    `Create a local Codex continuation package from ${itemIds.length} selected Claude session(s)?\n\n` +
    "This writes local files only and does not upload any session content.";
  await runClaudeExportByItemIds(itemIds, confirmationTitle, confirmationMessage);
}

async function runClaudeTransferActive() {
  state.claudeExportResult = null;
  state.claudeExportPrompt = "";
  renderClaudeExportResult();

  const sessionsToTransfer = activeClaudeSessionsForSelectedProjects();
  if (sessionsToTransfer.length === 0) {
    showFeedback("Select at least one active Claude project first.", "error");
    return;
  }

  const grouped = new Map();
  for (const session of sessionsToTransfer) {
    const key = claudeProjectKey(session);
    if (!grouped.has(key)) {
      grouped.set(key, {
        projectName: session.projectName || "(unknown-project)",
        itemIds: []
      });
    }
    grouped.get(key).itemIds.push(session.itemId);
  }

  const groups = Array.from(grouped.values());
  const projectCount = groups.length;
  const sessionCount = sessionsToTransfer.length;

  const confirmationTitle = "Transfer Claude Code active sessions to Codex?";
  const confirmationMessage =
    `Transfer ${sessionCount} active Claude session(s) from ${projectCount} selected project(s) now?\n\n` +
    "Session Hub will create 1 new Codex session per Claude project (not one giant merged session).";

  const accepted = await requestConfirmation({
    title: confirmationTitle,
    message: confirmationMessage,
    confirmLabel: "Transfer",
    cancelLabel: "Cancel",
    danger: false,
    requireCheckboxLabel: "I confirm these sessions belong to me and were generated on this device."
  });
  if (!accepted) {
    return;
  }

  const batch = {
    projectCount: groups.length,
    sessionCount: sessionsToTransfer.length,
    exportedProjects: 0,
    failedProjects: 0,
    handoffSuccessCount: 0,
    handoffFailureCount: 0,
    launchedCodexAppCount: 0,
    eventCount: 0,
    threadRefs: [],
    errors: []
  };

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    try {
      const exported = await requestClaudeExport(group.itemIds, {
        handoffToCodex: true,
        launchCodexApp: index === 0
      });

      batch.exportedProjects += 1;
      batch.eventCount += exported.stats?.eventCount || 0;

      if (exported.codexHandoff && exported.codexHandoff.ok) {
        batch.handoffSuccessCount += 1;
        if (exported.codexHandoff.launchedCodexApp) {
          batch.launchedCodexAppCount += 1;
        }
        if (exported.codexHandoff.threadId) {
          batch.threadRefs.push(`${group.projectName}: ${exported.codexHandoff.threadId}`);
        }
      } else if (exported.codexHandoff && exported.codexHandoff.ok === false) {
        batch.handoffFailureCount += 1;
        batch.errors.push(`${group.projectName}: ${exported.codexHandoff.error}`);
      }
    } catch (error) {
      batch.failedProjects += 1;
      batch.errors.push(`${group.projectName}: ${toError(error)}`);
    }
  }

  if (batch.failedProjects === 0 && batch.handoffFailureCount === 0) {
    const cliHint = batch.launchedCodexAppCount === 0
      ? " App not opened? run `codex resume --all`."
      : "";
    showFeedback(
      `transfer: ${batch.sessionCount} session(s) across ${batch.projectCount} project(s), created ${batch.handoffSuccessCount} Codex session(s).${cliHint}`,
      "ok"
    );
  } else {
    showFeedback(
      `transfer: partial success (${batch.handoffSuccessCount}/${batch.projectCount} projects created). See details below.`,
      "error"
    );
  }

  await loadSessions();
  sanitizeSelections();
  renderAll();
}

async function runGeminiAction(actionName) {
  const selectedSet = state.selected.gemini;
  let itemIds = Array.from(selectedSet);
  if (itemIds.length === 0) {
    showFeedback("No sessions selected.", "error");
    return;
  }

  if (actionName === "archive") {
    const activeIds = new Set(geminiSessions().filter((s) => s.state === "active").map((s) => s.itemId));
    itemIds = itemIds.filter((id) => activeIds.has(id));
    if (itemIds.length === 0) {
      showFeedback("No active sessions selected to archive.", "error");
      return;
    }
  }
  if (actionName === "unarchive") {
    const archivedIds = new Set(geminiSessions().filter((s) => s.state === "archived").map((s) => s.itemId));
    itemIds = itemIds.filter((id) => archivedIds.has(id));
    if (itemIds.length === 0) {
      showFeedback("No archived sessions selected to unarchive.", "error");
      return;
    }
  }

  if (actionName === "delete") {
    const accepted = await requestConfirmation({
      title: "Move sessions to trash?",
      message: `Move ${itemIds.length} Gemini session(s) to trash?\n\nThis is a soft delete and can be restored until expiration.`,
      confirmLabel: "Move To Trash",
      cancelLabel: "Keep Sessions",
      danger: true
    });
    if (!accepted) {
      return;
    }
  }

  const report = await requestJson(`/api/sessions/${actionName}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ itemIds })
  });

  showFeedback(`${actionName}: ${summarizeReport(report)}`, report.failedCount ? "error" : "ok");
  selectedSet.clear();
  await Promise.all([loadSessions(), loadTrash()]);
  sanitizeSelections();
  renderAll();
}

async function runTrashAction(actionName) {
  const trashIds = Array.from(state.selected.trash);
  if (trashIds.length === 0) {
    showFeedback("No trash items selected.", "error");
    return;
  }

  if (actionName === "purge") {
    const accepted = await requestConfirmation({
      title: "Permanently delete trash?",
      message: `Permanently delete ${trashIds.length} trash item(s)?\n\nThis action cannot be undone.`,
      confirmLabel: "Permanent Delete",
      cancelLabel: "Cancel",
      danger: true
    });
    if (!accepted) {
      return;
    }
  }

  const report = await requestJson(`/api/trash/${actionName}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ trashIds })
  });

  const failedCount = report.failedCount || report.failed?.length || 0;
  const succeededCount = report.succeededCount || report.succeeded?.length || 0;
  showFeedback(
    `${actionName}: success ${succeededCount}, failed ${failedCount}`,
    failedCount > 0 ? "error" : "ok"
  );
  state.selected.trash.clear();
  await Promise.all([loadSessions(), loadTrash()]);
  sanitizeSelections();
  renderAll();
}

/* ── event wiring ─────────────────────────────────────── */

function wireEvents() {
  if (!state.confirmKeyListenerBound) {
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.confirmResolve) {
        event.preventDefault();
        closeConfirmModal(false);
      }
    });
    state.confirmKeyListenerBound = true;
  }

  dom.confirmBackdrop.addEventListener("click", () => closeConfirmModal(false));
  dom.confirmCancel.addEventListener("click", () => closeConfirmModal(false));
  dom.confirmAccept.addEventListener("click", () => closeConfirmModal(true));
  dom.confirmCheckInput.addEventListener("change", () => {
    if (!state.confirmCheckboxRequired) {
      dom.confirmAccept.disabled = false;
      return;
    }
    dom.confirmAccept.disabled = !dom.confirmCheckInput.checked;
  });

  // Theme toggle
  document.getElementById("theme-toggle").addEventListener("click", () => {
    const current = getStoredTheme() || "light";
    const next = current === "dark" ? "light" : "dark";
    setStoredTheme(next);
    applyTheme(next);
  });

  // Tab switching
  dom.tabCodex.addEventListener("click", () => setCurrentView("codex"));
  dom.tabClaude.addEventListener("click", () => setCurrentView("claude"));
  dom.tabGemini.addEventListener("click", () => setCurrentView("gemini"));
  dom.tabTrash.addEventListener("click", () => setCurrentView("trash"));

  // Global actions
  dom.refreshAll.addEventListener("click", () => {
    refreshAll()
      .then(() => showFeedback("Refreshed.", "ok"))
      .catch((error) => showFeedback(toError(error), "error"));
  });

  dom.cleanupExpired.addEventListener("click", () => {
    requestJson("/api/trash/cleanup", { method: "POST" })
      .then((report) => {
        showFeedback(
          `cleanup complete: candidates ${report.expiredCandidates}, deleted ${report.succeeded.length}, failed ${report.failed.length}`,
          report.failed.length > 0 ? "error" : "ok"
        );
        return refreshAll();
      })
      .catch((error) => showFeedback(toError(error), "error"));
  });

  // State filter buttons
  document.querySelectorAll(".state-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const filterGroup = btn.getAttribute("data-filter");
      const filterState = btn.getAttribute("data-state");
      state.stateFilter[filterGroup] = filterState;
      setActiveStateFilter(filterGroup, filterState);
      if (filterGroup === "codex") renderCodex();
      else if (filterGroup === "claude") renderClaude();
      else if (filterGroup === "gemini") renderGemini();
    });
  });

  // Codex view
  dom.codexQuery.addEventListener("input", (event) => {
    state.queries.codex = event.target.value;
    renderCodex();
  });
  dom.codexSelectFiltered.addEventListener("click", () => {
    applySelection(state.selected.codex, filteredCodex(), "itemId", true);
    renderCodex();
  });
  dom.codexClearSelection.addEventListener("click", () => {
    state.selected.codex.clear();
    renderCodex();
  });
  dom.codexCheckAll.addEventListener("change", (event) => {
    applySelection(state.selected.codex, filteredCodex(), "itemId", event.target.checked);
    renderCodex();
  });
  dom.codexActionArchive.addEventListener("click", () => {
    runCodexAction("archive").catch((error) => showFeedback(toError(error), "error"));
  });
  dom.codexActionUnarchive.addEventListener("click", () => {
    runCodexAction("unarchive").catch((error) => showFeedback(toError(error), "error"));
  });
  dom.codexActionDelete.addEventListener("click", () => {
    runCodexAction("delete").catch((error) => showFeedback(toError(error), "error"));
  });

  // Claude view
  dom.claudeQuery.addEventListener("input", (event) => {
    state.queries.claude = event.target.value;
    renderClaude();
  });
  dom.claudeSelectFiltered.addEventListener("click", () => {
    if (IS_TRANSFER_MODE) {
      setFilteredClaudeProjectSelection(true);
    } else {
      applySelection(state.selected.claude, filteredClaude(), "itemId", true);
    }
    renderClaude();
  });
  dom.claudeClearSelection.addEventListener("click", () => {
    state.selected.claude.clear();
    renderClaude();
  });
  dom.claudeCheckAll.addEventListener("change", (event) => {
    if (IS_TRANSFER_MODE) {
      setFilteredClaudeProjectSelection(event.target.checked);
    } else {
      applySelection(state.selected.claude, filteredClaude(), "itemId", event.target.checked);
    }
    renderClaude();
  });
  dom.claudeActionArchive.addEventListener("click", () => {
    runClaudeAction("archive").catch((error) => showFeedback(toError(error), "error"));
  });
  dom.claudeActionUnarchive.addEventListener("click", () => {
    runClaudeAction("unarchive").catch((error) => showFeedback(toError(error), "error"));
  });
  dom.claudeActionDelete.addEventListener("click", () => {
    runClaudeAction("delete").catch((error) => showFeedback(toError(error), "error"));
  });
  dom.claudeActionExport.addEventListener("click", () => {
    runClaudeExport().catch((error) => showFeedback(toError(error), "error"));
  });
  dom.claudeActionTransferActive.addEventListener("click", () => {
    runClaudeTransferActive().catch((error) => showFeedback(toError(error), "error"));
  });
  dom.claudeCopyPrompt.addEventListener("click", () => {
    copyTextToClipboard(state.claudeExportPrompt)
      .then(() => showFeedback("Copied Codex import prompt.", "ok"))
      .catch((error) => showFeedback(toError(error), "error"));
  });

  // Gemini view
  dom.geminiQuery.addEventListener("input", (event) => {
    state.queries.gemini = event.target.value;
    renderGemini();
  });
  dom.geminiSelectFiltered.addEventListener("click", () => {
    applySelection(state.selected.gemini, filteredGemini(), "itemId", true);
    renderGemini();
  });
  dom.geminiClearSelection.addEventListener("click", () => {
    state.selected.gemini.clear();
    renderGemini();
  });
  dom.geminiCheckAll.addEventListener("change", (event) => {
    applySelection(state.selected.gemini, filteredGemini(), "itemId", event.target.checked);
    renderGemini();
  });
  dom.geminiActionArchive.addEventListener("click", () => {
    runGeminiAction("archive").catch((error) => showFeedback(toError(error), "error"));
  });
  dom.geminiActionUnarchive.addEventListener("click", () => {
    runGeminiAction("unarchive").catch((error) => showFeedback(toError(error), "error"));
  });
  dom.geminiActionDelete.addEventListener("click", () => {
    runGeminiAction("delete").catch((error) => showFeedback(toError(error), "error"));
  });

  // Trash view
  dom.trashQuery.addEventListener("input", (event) => {
    state.queries.trash = event.target.value;
    renderTrash();
  });
  dom.trashSelectFiltered.addEventListener("click", () => {
    applySelection(state.selected.trash, filteredTrash(), "trashId", true);
    renderTrash();
  });
  dom.trashClearSelection.addEventListener("click", () => {
    state.selected.trash.clear();
    renderTrash();
  });
  dom.trashCheckAll.addEventListener("change", (event) => {
    applySelection(state.selected.trash, filteredTrash(), "trashId", event.target.checked);
    renderTrash();
  });
  dom.actionRestore.addEventListener("click", () => {
    runTrashAction("restore").catch((error) => showFeedback(toError(error), "error"));
  });
  dom.actionPurge.addEventListener("click", () => {
    runTrashAction("purge").catch((error) => showFeedback(toError(error), "error"));
  });
}

configureTransferModeUI();
wireEvents();
setCurrentView(INITIAL_VIEW);
refreshAll().catch((error) => showFeedback(toError(error), "error"));
