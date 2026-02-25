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

const state = {
  config: null,
  sessions: [],
  trash: [],
  currentView: "codex",
  queries: {
    codex: "",
    claude: "",
    trash: ""
  },
  selected: {
    codex: new Set(),
    claude: new Set(),
    trash: new Set()
  },
  confirmResolve: null,
  confirmKeyListenerBound: false,
  lastFocusedElement: null
};

const dom = {
  configInfo: document.getElementById("config-info"),
  feedback: document.getElementById("feedback"),
  refreshAll: document.getElementById("refresh-all"),
  cleanupExpired: document.getElementById("cleanup-expired"),

  tabCodex: document.getElementById("tab-codex"),
  tabClaude: document.getElementById("tab-claude"),
  tabTrash: document.getElementById("tab-trash"),

  viewCodex: document.getElementById("view-codex"),
  viewClaude: document.getElementById("view-claude"),
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
  claudeActionDelete: document.getElementById("claude-action-delete"),

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
  confirmCancel: document.getElementById("confirm-cancel"),
  confirmAccept: document.getElementById("confirm-accept")
};

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

  resolver(Boolean(accepted));
}

function requestConfirmation({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = true
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

function filteredCodex() {
  const query = state.queries.codex.trim().toLowerCase();
  return codexSessions().filter((session) => {
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
  return claudeSessions().filter((session) => {
    if (!query) {
      return true;
    }
    const text = `${session.title || ""} ${session.threadId} ${session.projectName || ""} ${
      session.gitBranch || ""
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
  dom.viewTrash.classList.toggle("hidden", viewName !== "trash");

  dom.tabCodex.classList.toggle("active", viewName === "codex");
  dom.tabClaude.classList.toggle("active", viewName === "claude");
  dom.tabTrash.classList.toggle("active", viewName === "trash");

  dom.tabCodex.setAttribute("aria-selected", String(viewName === "codex"));
  dom.tabClaude.setAttribute("aria-selected", String(viewName === "claude"));
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
  const rows = filteredClaude();
  const selectedSet = state.selected.claude;

  dom.claudeBody.innerHTML = "";
  for (const session of rows) {
    const title = session.title || "Untitled session";
    const displayTitle = truncateText(title, 62);
    const project = session.projectName || "-";
    const branch = session.gitBranch || "-";

    const row = document.createElement("tr");
    row.innerHTML = `
      <td><input type="checkbox" data-session-id="${session.itemId}" /></td>
      <td class="title-cell" title="${escapeHtml(title)}">${escapeHtml(displayTitle)}</td>
      <td title="${escapeHtml(project)}">${escapeHtml(truncateText(project, 30))}</td>
      <td>${escapeHtml(truncateText(branch, 20))}</td>
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
      renderSelectionMeta();
    });
  });

  const selectedInRows = countSelectedRows(selectedSet, rows, "itemId");
  dom.claudeCheckAll.checked = rows.length > 0 && selectedInRows === rows.length;
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

  dom.codexSelectionMeta.textContent = `${state.selected.codex.size} selected / ${codexTotal} total`;
  dom.claudeSelectionMeta.textContent = `${state.selected.claude.size} selected / ${claudeTotal} total`;
  dom.trashSelectionMeta.textContent = `${state.selected.trash.size} selected / ${state.trash.length} total`;

  // Codex buttons: archive only for active, unarchive only for archived
  const codexSelectedItems = codexSessions().filter((s) => state.selected.codex.has(s.itemId));
  const hasActiveSelected = codexSelectedItems.some((s) => s.state === "active");
  const hasArchivedSelected = codexSelectedItems.some((s) => s.state === "archived");

  dom.codexActionArchive.disabled = !hasActiveSelected;
  dom.codexActionUnarchive.disabled = !hasArchivedSelected;
  dom.codexActionDelete.disabled = state.selected.codex.size === 0;

  dom.claudeActionDelete.disabled = state.selected.claude.size === 0;
  dom.actionRestore.disabled = state.selected.trash.size === 0;
  dom.actionPurge.disabled = state.selected.trash.size === 0;
}

function renderTabCounts() {
  const codexTotal = codexSessions().length;
  const claudeTotal = claudeSessions().length;
  const trashCount = state.trash.length;

  dom.tabCodex.textContent = `Codex (${codexTotal})`;
  dom.tabClaude.textContent = `Claude (${claudeTotal})`;
  dom.tabTrash.textContent = `Trash (${trashCount})`;
}

function sanitizeSelections() {
  const codexIds = new Set(codexSessions().map((s) => s.itemId));
  const claudeIds = new Set(claudeSessions().map((s) => s.itemId));
  const trashIds = new Set(state.trash.map((item) => item.trashId));

  pruneSelectionSet(state.selected.codex, codexIds);
  pruneSelectionSet(state.selected.claude, claudeIds);
  pruneSelectionSet(state.selected.trash, trashIds);
}

/* ── data loading ─────────────────────────────────────── */

async function loadConfig() {
  state.config = await requestJson("/api/config");
  dom.configInfo.textContent = `codex-home: ${state.config.codexHome} | claude-home: ${state.config.claudeHome} | trash: ${state.config.trashRoot} | retention: ${state.config.retentionDays} days`;
}

async function loadSessions() {
  const response = await requestJson("/api/sessions");
  state.sessions = response.items || [];
}

async function loadTrash() {
  const response = await requestJson("/api/trash");
  state.trash = response.items || [];
}

function renderAll() {
  renderTabCounts();
  renderCodex();
  renderClaude();
  renderTrash();
}

async function refreshAll() {
  await Promise.all([loadConfig(), loadSessions(), loadTrash()]);
  sanitizeSelections();
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

async function runClaudeDelete() {
  const selectedSet = state.selected.claude;
  const itemIds = Array.from(selectedSet);
  if (itemIds.length === 0) {
    showFeedback("No sessions selected.", "error");
    return;
  }

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

  const report = await requestJson("/api/sessions/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ itemIds })
  });

  showFeedback(`delete: ${summarizeReport(report)}`, report.failedCount ? "error" : "ok");
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
    applySelection(state.selected.claude, filteredClaude(), "itemId", true);
    renderClaude();
  });
  dom.claudeClearSelection.addEventListener("click", () => {
    state.selected.claude.clear();
    renderClaude();
  });
  dom.claudeCheckAll.addEventListener("change", (event) => {
    applySelection(state.selected.claude, filteredClaude(), "itemId", event.target.checked);
    renderClaude();
  });
  dom.claudeActionDelete.addEventListener("click", () => {
    runClaudeDelete().catch((error) => showFeedback(toError(error), "error"));
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

wireEvents();
setCurrentView("codex");
refreshAll().catch((error) => showFeedback(toError(error), "error"));
