const state = {
  config: null,
  sessions: [],
  trash: [],
  currentView: "active",
  queries: {
    active: "",
    archived: "",
    trash: ""
  },
  selected: {
    active: new Set(),
    archived: new Set(),
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

  tabActive: document.getElementById("tab-active"),
  tabArchived: document.getElementById("tab-archived"),
  tabTrash: document.getElementById("tab-trash"),

  viewActive: document.getElementById("view-active"),
  viewArchived: document.getElementById("view-archived"),
  viewTrash: document.getElementById("view-trash"),

  activeQuery: document.getElementById("active-query"),
  activeSelectFiltered: document.getElementById("active-select-filtered"),
  activeClearSelection: document.getElementById("active-clear-selection"),
  activeSelectionMeta: document.getElementById("active-selection-meta"),
  activeCheckAll: document.getElementById("active-check-all"),
  activeBody: document.getElementById("active-body"),
  activeActionArchive: document.getElementById("active-action-archive"),
  activeActionDelete: document.getElementById("active-action-delete"),

  archivedQuery: document.getElementById("archived-query"),
  archivedSelectFiltered: document.getElementById("archived-select-filtered"),
  archivedClearSelection: document.getElementById("archived-clear-selection"),
  archivedSelectionMeta: document.getElementById("archived-selection-meta"),
  archivedCheckAll: document.getElementById("archived-check-all"),
  archivedBody: document.getElementById("archived-body"),
  archivedActionUnarchive: document.getElementById("archived-action-unarchive"),
  archivedActionDelete: document.getElementById("archived-action-delete"),

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

const SESSION_VIEWS = {
  active: {
    body: dom.activeBody,
    checkAll: dom.activeCheckAll,
    clearSelection: dom.activeClearSelection,
    query: dom.activeQuery,
    selectFiltered: dom.activeSelectFiltered,
    selectionMeta: dom.activeSelectionMeta
  },
  archived: {
    body: dom.archivedBody,
    checkAll: dom.archivedCheckAll,
    clearSelection: dom.archivedClearSelection,
    query: dom.archivedQuery,
    selectFiltered: dom.archivedSelectFiltered,
    selectionMeta: dom.archivedSelectionMeta
  }
};

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

function filteredSessions(viewName) {
  const query = state.queries[viewName].trim().toLowerCase();
  return state.sessions.filter((session) => {
    if (session.state !== viewName) {
      return false;
    }
    if (!query) {
      return true;
    }
    const text = `${session.title || ""} ${session.threadId} ${session.fileName} ${
      session.relativePath
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
      }`.toLowerCase();
    return text.includes(query);
  });
}

function setCurrentView(viewName) {
  state.currentView = viewName;

  const activeView = viewName === "active";
  const archivedView = viewName === "archived";
  const trashView = viewName === "trash";

  dom.viewActive.classList.toggle("hidden", !activeView);
  dom.viewArchived.classList.toggle("hidden", !archivedView);
  dom.viewTrash.classList.toggle("hidden", !trashView);

  dom.tabActive.classList.toggle("active", activeView);
  dom.tabArchived.classList.toggle("active", archivedView);
  dom.tabTrash.classList.toggle("active", trashView);

  dom.tabActive.setAttribute("aria-selected", String(activeView));
  dom.tabArchived.setAttribute("aria-selected", String(archivedView));
  dom.tabTrash.setAttribute("aria-selected", String(trashView));
}

function renderSessionRows(rows, targetBody, selectedSet) {
  targetBody.innerHTML = "";
  for (const session of rows) {
    const title = session.title || "Untitled session";
    const displayTitle = truncateText(title, 62);
    const displayThreadId = truncateText(session.threadId, 14);

    const row = document.createElement("tr");
    row.innerHTML = `
      <td><input type="checkbox" data-session-id="${session.itemId}" /></td>
      <td class="title-cell" title="${escapeHtml(title)}">${escapeHtml(displayTitle)}</td>
      <td title="${escapeHtml(session.threadId)}">${escapeHtml(displayThreadId)}</td>
      <td title="${escapeHtml(session.fileName)}">${escapeHtml(truncateText(session.fileName, 34))}</td>
      <td>${formatDate(session.updatedAt)}</td>
      <td>${formatBytes(session.sizeBytes)}</td>
      <td title="${escapeHtml(session.relativePath)}">${escapeHtml(
      truncateText(session.relativePath, 56)
    )}</td>
    `;
    targetBody.appendChild(row);
  }

  targetBody.querySelectorAll("input[type=checkbox]").forEach((checkbox) => {
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
}

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

function sessionCount(viewName) {
  return state.sessions.filter((item) => item.state === viewName).length;
}

function sessionIdSet(viewName) {
  return new Set(state.sessions.filter((item) => item.state === viewName).map((item) => item.itemId));
}

function pruneSelectionSet(selectedSet, validIds) {
  for (const selected of Array.from(selectedSet)) {
    if (!validIds.has(selected)) {
      selectedSet.delete(selected);
    }
  }
}

function renderSessionView(viewName) {
  const rows = filteredSessions(viewName);
  const view = SESSION_VIEWS[viewName];
  const selectedSet = state.selected[viewName];

  renderSessionRows(rows, view.body, selectedSet);

  const selectedInRows = countSelectedRows(selectedSet, rows, "itemId");
  view.checkAll.checked = rows.length > 0 && selectedInRows === rows.length;
  renderSelectionMeta();
}

function renderActive() {
  renderSessionView("active");
}

function renderArchived() {
  renderSessionView("archived");
}

function renderTrash() {
  const rows = filteredTrash();
  dom.trashBody.innerHTML = "";

  for (const item of rows) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><input type="checkbox" data-trash-id="${item.trashId}" /></td>
      <td>${trashExpiryPill(item.expired)}</td>
      <td title="${escapeHtml(item.threadId || "-")}">${escapeHtml(
      truncateText(item.threadId || "-", 16)
    )}</td>
      <td>${formatDate(item.deletedAt)}</td>
      <td>${formatDate(item.expiresAt)}</td>
      <td>${formatBytes(item.sizeBytes)}</td>
      <td title="${escapeHtml(item.originalRelativePath || "")}">${escapeHtml(
      truncateText(item.originalRelativePath || "-", 48)
    )}</td>
      <td title="${escapeHtml(item.trashId)}">${escapeHtml(truncateText(item.trashId, 16))}</td>
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

function renderSelectionMeta() {
  SESSION_VIEWS.active.selectionMeta.textContent = `${state.selected.active.size} selected / ${sessionCount(
    "active"
  )} active`;
  SESSION_VIEWS.archived.selectionMeta.textContent = `${state.selected.archived.size} selected / ${sessionCount(
    "archived"
  )} archived`;
  dom.trashSelectionMeta.textContent = `${state.selected.trash.size} selected / ${state.trash.length} total`;

  dom.activeActionArchive.disabled = state.selected.active.size === 0;
  dom.activeActionDelete.disabled = state.selected.active.size === 0;
  dom.archivedActionUnarchive.disabled = state.selected.archived.size === 0;
  dom.archivedActionDelete.disabled = state.selected.archived.size === 0;
  dom.actionRestore.disabled = state.selected.trash.size === 0;
  dom.actionPurge.disabled = state.selected.trash.size === 0;
}

function renderTabCounts() {
  const activeCount = sessionCount("active");
  const archivedCount = sessionCount("archived");
  const trashCount = state.trash.length;

  dom.tabActive.textContent = `Active (${activeCount})`;
  dom.tabArchived.textContent = `Archived (${archivedCount})`;
  dom.tabTrash.textContent = `Trash (${trashCount})`;
}

function sanitizeSelections() {
  const activeIds = sessionIdSet("active");
  const archivedIds = sessionIdSet("archived");
  const trashIds = new Set(state.trash.map((item) => item.trashId));

  pruneSelectionSet(state.selected.active, activeIds);
  pruneSelectionSet(state.selected.archived, archivedIds);
  pruneSelectionSet(state.selected.trash, trashIds);
}

async function loadConfig() {
  state.config = await requestJson("/api/config");
  dom.configInfo.textContent = `codex-home: ${state.config.codexHome} | trash: ${state.config.trashRoot} | retention: ${state.config.retentionDays} days`;
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
  renderActive();
  renderArchived();
  renderTrash();
}

async function refreshAll() {
  await Promise.all([loadConfig(), loadSessions(), loadTrash()]);
  sanitizeSelections();
  renderAll();
}

async function runSessionAction(actionName, sourceView) {
  const selectedSet = state.selected[sourceView];
  const itemIds = Array.from(selectedSet);
  if (itemIds.length === 0) {
    showFeedback("No sessions selected.", "error");
    return;
  }

  if (actionName === "delete") {
    const accepted = await requestConfirmation({
      title: "Move sessions to trash?",
      message: `Move ${itemIds.length} ${sourceView} session(s) to trash?\n\nThis is a soft delete and can be restored until expiration.`,
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

function toError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function bindSessionViewEvents(viewName) {
  const view = SESSION_VIEWS[viewName];

  view.query.addEventListener("input", (event) => {
    state.queries[viewName] = event.target.value;
    renderSessionView(viewName);
  });

  view.selectFiltered.addEventListener("click", () => {
    applySelection(state.selected[viewName], filteredSessions(viewName), "itemId", true);
    renderSessionView(viewName);
  });

  view.clearSelection.addEventListener("click", () => {
    state.selected[viewName].clear();
    renderSessionView(viewName);
  });

  view.checkAll.addEventListener("change", (event) => {
    applySelection(
      state.selected[viewName],
      filteredSessions(viewName),
      "itemId",
      event.target.checked
    );
    renderSessionView(viewName);
  });
}

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

  dom.tabActive.addEventListener("click", () => setCurrentView("active"));
  dom.tabArchived.addEventListener("click", () => setCurrentView("archived"));
  dom.tabTrash.addEventListener("click", () => setCurrentView("trash"));

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

  bindSessionViewEvents("active");
  bindSessionViewEvents("archived");

  dom.trashQuery.addEventListener("input", (event) => {
    state.queries.trash = event.target.value;
    renderTrash();
  });

  dom.activeActionArchive.addEventListener("click", () => {
    runSessionAction("archive", "active").catch((error) => showFeedback(toError(error), "error"));
  });
  dom.activeActionDelete.addEventListener("click", () => {
    runSessionAction("delete", "active").catch((error) => showFeedback(toError(error), "error"));
  });
  dom.archivedActionUnarchive.addEventListener("click", () => {
    runSessionAction("unarchive", "archived").catch((error) =>
      showFeedback(toError(error), "error")
    );
  });
  dom.archivedActionDelete.addEventListener("click", () => {
    runSessionAction("delete", "archived").catch((error) => showFeedback(toError(error), "error"));
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
setCurrentView("active");
refreshAll().catch((error) => showFeedback(toError(error), "error"));
