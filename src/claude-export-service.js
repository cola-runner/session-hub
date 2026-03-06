const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  isClaudeItemId
} = require("./claude-session-store");
const {
  handoffToCodexThread
} = require("./codex-handoff");
const {
  ensureDir,
  normalizeRelativePath,
  pathExists
} = require("./fs-utils");

const SUPPORTED_COMPRESSION = new Set(["three-layer"]);
const SUPPORTED_BUDGET = new Set(["layered-trim"]);
const EVIDENCE_MAX_ITEMS = 120;
const EVIDENCE_MAX_CHARS = 12000;
const INLINE_HANDOFF_MAX_CHARS = 8000;
const INLINE_SESSION_LINE_LIMIT = 6;
const MAX_THREAD_NAME_CHARS = 96;
const INTERRUPTED_PLACEHOLDER_RE = /^\[Request interrupted by user for tool use\]$/i;

/**
 * @typedef {Object} SourceRef
 * @property {string} sessionId
 * @property {string} file
 * @property {number} line
 */

/**
 * @typedef {Object} NormalizedClaudeEvent
 * @property {string} eventId
 * @property {string} sessionId
 * @property {string} eventType
 * @property {string} signalType
 * @property {string|null} timestamp
 * @property {number|null} timestampMs
 * @property {SourceRef} sourceRef
 * @property {string} summary
 * @property {string|null} detail
 * @property {string|null} command
 * @property {boolean} isError
 * @property {number} scoreHint
 * @property {number} sequence
 */

/**
 * @typedef {Object} EvidenceEntry
 * @property {string} id
 * @property {string} label
 * @property {string} excerpt
 * @property {SourceRef} sourceRef
 * @property {string|null} timestamp
 * @property {number} score
 */

/**
 * @typedef {Object} CodexPromptPack
 * @property {string} goal
 * @property {string} currentState
 * @property {string[]} nextSteps
 * @property {string[]} decisions
 * @property {string[]} commandTrace
 * @property {string[]} failures
 * @property {string[]} todos
 * @property {EvidenceEntry[]} selectedEvidence
 * @property {EvidenceEntry[]} overflowEvidence
 * @property {string} startPrompt
 */

/**
 * @typedef {Object} ExportManifest
 * @property {string} exportId
 * @property {string} generatedAt
 * @property {Object[]} sessions
 * @property {Object} options
 * @property {Object} stats
 * @property {Object[]} parseWarnings
 */

function toIsoOrNull(value) {
  const epoch = Date.parse(String(value || ""));
  if (!Number.isFinite(epoch)) {
    return {
      iso: null,
      ms: null
    };
  }
  return {
    iso: new Date(epoch).toISOString(),
    ms: epoch
  };
}

function toOneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clipText(value, maxLength = 260) {
  const oneLine = toOneLine(value);
  if (!oneLine) {
    return "";
  }
  const chars = Array.from(oneLine);
  if (chars.length <= maxLength) {
    return oneLine;
  }
  return `${chars.slice(0, maxLength - 1).join("")}…`;
}

function projectNameFromPath(value) {
  return String(value || "")
    .split(/[\\/]+/)
    .filter(Boolean)
    .pop() || "";
}

function countChars(value) {
  return Array.from(String(value || "")).length;
}

function isInterruptedPlaceholder(value) {
  return INTERRUPTED_PLACEHOLDER_RE.test(toOneLine(value));
}

function sanitizeSignalText(value, maxLength = 260) {
  if (isInterruptedPlaceholder(value)) {
    return "";
  }
  return clipText(value, maxLength);
}

function isInterruptedContent(value) {
  if (typeof value === "string") {
    return isInterruptedPlaceholder(value);
  }
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }
  return value.every((part) => {
    if (typeof part === "string") {
      return isInterruptedPlaceholder(part);
    }
    if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
      return isInterruptedPlaceholder(part.text);
    }
    return false;
  });
}

function stableNowStamp(date) {
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function isWeakThreadTitleCandidate(value) {
  const normalized = toOneLine(value).toLowerCase();
  return (
    !normalized
    || normalized === "continue"
    || normalized === "continue here"
    || normalized === "continue from here"
    || normalized === "resume"
    || normalized === "resume here"
  );
}

function buildCodexThreadName({ sessions = [], pack, handoffCwd } = {}) {
  const titledSession = sessions.find((session) => !isWeakThreadTitleCandidate(session.title));
  const projectSession = sessions.find((session) => toOneLine(session.projectName));
  const projectName = toOneLine(projectSession ? projectSession.projectName : projectNameFromPath(handoffCwd));
  const sessionTitle = clipText(titledSession ? titledSession.title : "", 72);
  const goalTitle = clipText(pack && pack.goal, 72);

  const summary = [sessionTitle, goalTitle]
    .map((value) => toOneLine(value))
    .find((value) => value && !isWeakThreadTitleCandidate(value)) || "";

  const fallback = projectName
    ? `Imported from Claude: ${projectName}`
    : "Imported from Claude";
  if (!summary) {
    return clipText(fallback, MAX_THREAD_NAME_CHARS);
  }
  if (!projectName) {
    return clipText(summary, MAX_THREAD_NAME_CHARS);
  }
  if (summary.toLowerCase().includes(projectName.toLowerCase())) {
    return clipText(summary, MAX_THREAD_NAME_CHARS);
  }
  return clipText(`${projectName} · ${summary}`, MAX_THREAD_NAME_CHARS);
}

function createExportId(now = new Date()) {
  return `${stableNowStamp(now)}-${crypto.randomBytes(4).toString("hex")}`;
}

function defaultExportRoot() {
  return path.join(os.homedir(), ".session-hub", "exports");
}

function sourceLabel(sourceRef) {
  return `${sourceRef.sessionId}:${sourceRef.line} (${sourceRef.file})`;
}

function toolResultPreview(content) {
  if (typeof content === "string") {
    return sanitizeSignalText(content, 220);
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const parts = [];
  for (const item of content) {
    if (item && typeof item === "object") {
      if (item.type === "text" && typeof item.text === "string") {
        const text = sanitizeSignalText(item.text, 120);
        if (text) {
          parts.push(text);
        }
        continue;
      }
      if (item.type === "image") {
        parts.push("[image]");
        continue;
      }
      parts.push(`[${item.type || "object"}]`);
      continue;
    }
    if (typeof item === "string") {
      const text = sanitizeSignalText(item, 120);
      if (text) {
        parts.push(text);
      }
    }
  }
  return clipText(parts.join(" | "), 220);
}

function asCommand(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = clipText(value, 220);
  return normalized || null;
}

function extractAssistantSignals(record, base) {
  const signals = [];
  const content = record && record.message ? record.message.content : null;

  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }

      if (part.type === "text" && typeof part.text === "string") {
        const text = sanitizeSignalText(part.text, 320);
        if (text) {
          signals.push({
            ...base,
            signalType: "assistant_text",
            summary: text,
            detail: text,
            command: null,
            isError: false,
            scoreHint: 56
          });
        }
        continue;
      }

      if (part.type === "tool_use") {
        const toolName = clipText(part.name || "tool", 48) || "tool";
        const command = asCommand(part.input && part.input.command);
        const summary = command
          ? `Tool call ${toolName}: ${command}`
          : `Tool call ${toolName}`;

        signals.push({
          ...base,
          signalType: "tool_use",
          summary,
          detail: clipText(
            command || JSON.stringify(part.input || {}, null, 0),
            320
          ),
          command,
          isError: false,
          scoreHint: 88
        });
        continue;
      }

      if (part.type === "thinking") {
        const count = typeof part.thinking === "string"
          ? Array.from(part.thinking).length
          : 0;
        signals.push({
          ...base,
          signalType: "assistant_thinking",
          summary: `Assistant reasoning trace (${count} chars)`,
          detail: null,
          command: null,
          isError: false,
          scoreHint: 18
        });
      }
    }
  } else if (typeof content === "string") {
    const text = sanitizeSignalText(content, 320);
    if (text) {
      signals.push({
        ...base,
        signalType: "assistant_text",
        summary: text,
        detail: text,
        command: null,
        isError: false,
        scoreHint: 56
      });
    }
  }

  if (record && record.error) {
    signals.push({
      ...base,
      signalType: "assistant_error",
      summary: `Assistant error: ${clipText(record.error, 220)}`,
      detail: clipText(record.error, 320),
      command: null,
      isError: true,
      scoreHint: 94
    });
  }

  if (signals.length === 0) {
    signals.push({
      ...base,
      signalType: "assistant_event",
      summary: "Assistant event",
      detail: null,
      command: null,
      isError: false,
      scoreHint: 12
    });
  }

  return signals;
}

function extractUserSignals(record, base) {
  const signals = [];
  const content = record && record.message ? record.message.content : null;

  if (typeof content === "string") {
    const text = sanitizeSignalText(content, 320);
    if (text) {
      signals.push({
        ...base,
        signalType: "user_text",
        summary: text,
        detail: text,
        command: null,
        isError: false,
        scoreHint: 74
      });
    }
  }

  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }

      if (part.type === "text" && typeof part.text === "string") {
        const text = sanitizeSignalText(part.text, 320);
        if (text) {
          signals.push({
            ...base,
            signalType: "user_text",
            summary: text,
            detail: text,
            command: null,
            isError: false,
            scoreHint: 74
          });
        }
        continue;
      }

      if (part.type === "tool_result") {
        if (isInterruptedContent(part.content)) {
          continue;
        }
        const preview = toolResultPreview(part.content);
        const toolUseId = clipText(part.tool_use_id || "", 48);
        const prefix = part.is_error ? "Tool result error" : "Tool result";
        const summaryBits = [prefix];
        if (toolUseId) {
          summaryBits.push(`(${toolUseId})`);
        }
        if (preview) {
          summaryBits.push(`- ${preview}`);
        }

        signals.push({
          ...base,
          signalType: "tool_result",
          summary: clipText(summaryBits.join(" "), 320),
          detail: preview || null,
          command: null,
          isError: Boolean(part.is_error),
          scoreHint: part.is_error ? 82 : 24
        });
      }
    }
  }

  if (signals.length === 0) {
    signals.push({
      ...base,
      signalType: "user_event",
      summary: "User event",
      detail: null,
      command: null,
      isError: false,
      scoreHint: 10
    });
  }

  return signals;
}

function extractProgressSignals(record, base) {
  const data = record && typeof record.data === "object" ? record.data : {};
  const signals = [];

  const command = asCommand(data.command);
  if (command) {
    signals.push({
      ...base,
      signalType: "progress_command",
      summary: `Progress command: ${command}`,
      detail: command,
      command,
      isError: false,
      scoreHint: 66
    });
  }

  if (typeof data.message === "string") {
    const message = clipText(data.message, 280);
    if (message) {
      signals.push({
        ...base,
        signalType: "progress_message",
        summary: `Progress note: ${message}`,
        detail: message,
        command: null,
        isError: false,
        scoreHint: 22
      });
    }
  }

  if (typeof data.hookName === "string") {
    const hookName = clipText(data.hookName, 90);
    const hookEvent = clipText(data.hookEvent || "", 60);
    signals.push({
      ...base,
      signalType: "progress_hook",
      summary: `Hook ${hookName}${hookEvent ? ` (${hookEvent})` : ""}`,
      detail: null,
      command: null,
      isError: false,
      scoreHint: 12
    });
  }

  if (signals.length === 0) {
    signals.push({
      ...base,
      signalType: "progress_event",
      summary: "Progress event",
      detail: null,
      command: null,
      isError: false,
      scoreHint: 8
    });
  }

  return signals;
}

function extractSystemSignals(record, base) {
  const bits = [];
  if (record.subtype) {
    bits.push(`subtype=${clipText(record.subtype, 40)}`);
  }
  if (record.level) {
    bits.push(`level=${clipText(record.level, 16)}`);
  }
  if (record.cause) {
    bits.push(`cause=${clipText(record.cause, 80)}`);
  }
  if (record.error) {
    bits.push(`error=${clipText(record.error, 120)}`);
  }

  return [{
    ...base,
    signalType: record.error ? "system_error" : "system_event",
    summary: bits.length > 0 ? `System: ${bits.join(" ")}` : "System event",
    detail: record.error ? clipText(record.error, 280) : null,
    command: null,
    isError: Boolean(record.error),
    scoreHint: record.error ? 90 : 10
  }];
}

function extractQueueSignals(record, base) {
  const op = clipText(record.operation || "", 64);
  const content = clipText(record.content || "", 220);
  const summary = op
    ? `Queue operation ${op}${content ? `: ${content}` : ""}`
    : `Queue operation${content ? `: ${content}` : ""}`;
  return [{
    ...base,
    signalType: "queue_operation",
    summary,
    detail: content || null,
    command: null,
    isError: false,
    scoreHint: 8
  }];
}

function extractSnapshotSignals(record, base) {
  const messageId = clipText(record.messageId || "", 64);
  const summary = messageId
    ? `File snapshot update for ${messageId}`
    : "File snapshot update";
  return [{
    ...base,
    signalType: "file_snapshot",
    summary,
    detail: null,
    command: null,
    isError: false,
    scoreHint: 4
  }];
}

function extractSignalsFromRecord(record, base) {
  const type = record && typeof record.type === "string"
    ? record.type
    : "unknown";

  if (type === "assistant") {
    return extractAssistantSignals(record, base);
  }
  if (type === "user") {
    return extractUserSignals(record, base);
  }
  if (type === "progress") {
    return extractProgressSignals(record, base);
  }
  if (type === "system") {
    return extractSystemSignals(record, base);
  }
  if (type === "queue-operation") {
    return extractQueueSignals(record, base);
  }
  if (type === "file-history-snapshot") {
    return extractSnapshotSignals(record, base);
  }

  return [{
    ...base,
    signalType: "unknown",
    summary: `Unknown event type: ${clipText(type, 48)}`,
    detail: null,
    command: null,
    isError: false,
    scoreHint: 6
  }];
}

function scoreEvidence(event, index, total) {
  const recencyBoost = total > 0 ? Math.round((index / total) * 12) : 0;
  let score = event.scoreHint + recencyBoost;
  if (event.isError) {
    score += 22;
  }
  if (event.command) {
    score += 12;
  }
  if (event.signalType === "user_text") {
    score += 7;
  }
  return score;
}

function uniquePush(list, value, seen, limit) {
  const normalized = clipText(value, 300);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  list.push(normalized);
  if (list.length > limit) {
    list.pop();
  }
}

function buildNextSteps(events, errorEvents, commandEvents, userTexts) {
  const nextSteps = [];
  const seen = new Set();

  if (errorEvents.length > 0) {
    uniquePush(
      nextSteps,
      `Investigate and resolve: ${errorEvents[0].summary}`,
      seen,
      5
    );
  }

  for (const commandEvent of commandEvents.slice(0, 3)) {
    if (!commandEvent.command) {
      continue;
    }
    uniquePush(
      nextSteps,
      `Continue from command: \`${commandEvent.command}\``,
      seen,
      5
    );
  }

  if (userTexts.length > 0) {
    uniquePush(
      nextSteps,
      `Complete the latest user request: ${userTexts[0].summary}`,
      seen,
      5
    );
  }

  uniquePush(
    nextSteps,
    "Run validation/tests after each substantive change and capture outcomes.",
    seen,
    5
  );
  uniquePush(
    nextSteps,
    "Update docs or notes for decisions that affect future implementation.",
    seen,
    5
  );

  return nextSteps.slice(0, 5);
}

/**
 * Build a three-layer Codex continuation pack from normalized events.
 *
 * @param {NormalizedClaudeEvent[]} normalizedEvents
 * @param {"layered-trim"} budgetStrategy
 * @returns {CodexPromptPack}
 */
function buildThreeLayerPack(normalizedEvents, budgetStrategy = "layered-trim") {
  if (!SUPPORTED_BUDGET.has(budgetStrategy)) {
    throw new Error(`unsupported budgetStrategy: ${budgetStrategy}`);
  }

  const events = Array.from(normalizedEvents).sort((left, right) => {
    if (left.timestampMs === null && right.timestampMs === null) {
      return left.sequence - right.sequence;
    }
    if (left.timestampMs === null) {
      return 1;
    }
    if (right.timestampMs === null) {
      return -1;
    }
    if (left.timestampMs === right.timestampMs) {
      return left.sequence - right.sequence;
    }
    return left.timestampMs - right.timestampMs;
  });

  const reversed = Array.from(events).reverse();
  const userTexts = reversed.filter((event) => event.signalType === "user_text");
  const assistantTexts = reversed.filter((event) => event.signalType === "assistant_text");
  const commandEvents = reversed.filter((event) =>
    event.signalType === "tool_use" || event.signalType === "progress_command"
  );
  const errorEvents = reversed.filter((event) => event.isError);

  const goal = userTexts[0]
    ? userTexts[0].summary
    : "Continue implementation using the migrated Claude Code context.";
  const currentState = assistantTexts[0]
    ? assistantTexts[0].summary
    : commandEvents[0]
      ? commandEvents[0].summary
      : "Recent conversational state is available via the evidence index.";
  const nextSteps = buildNextSteps(events, errorEvents, commandEvents, userTexts);

  const decisionKeywords = /(decid|approach|strategy|because|should|plan|tradeoff|constraint)/i;
  const decisions = [];
  const decisionSeen = new Set();
  for (const event of assistantTexts) {
    if (!event.detail || !decisionKeywords.test(event.detail)) {
      continue;
    }
    uniquePush(decisions, event.detail, decisionSeen, 8);
  }
  if (decisions.length === 0) {
    for (const event of assistantTexts.slice(0, 5)) {
      if (event.detail) {
        uniquePush(decisions, event.detail, decisionSeen, 8);
      }
    }
  }
  if (decisions.length === 0) {
    decisions.push("No explicit decision statement was detected from assistant text.");
  }

  const commandTrace = [];
  const commandSeen = new Set();
  for (const event of commandEvents) {
    const content = event.command || event.summary;
    uniquePush(commandTrace, content, commandSeen, 12);
  }
  if (commandTrace.length === 0) {
    commandTrace.push("No explicit command trace was detected.");
  }

  const failures = [];
  const failureSeen = new Set();
  for (const event of errorEvents) {
    uniquePush(failures, event.summary, failureSeen, 10);
  }
  if (failures.length === 0) {
    failures.push("No explicit error events detected in selected sessions.");
  }

  const todoPattern = /\b(todo|next|fixme|follow[- ]?up|pending)\b/i;
  const todos = [];
  const todoSeen = new Set();
  for (const event of userTexts.concat(assistantTexts)) {
    if (!event.detail || !todoPattern.test(event.detail)) {
      continue;
    }
    uniquePush(todos, event.detail, todoSeen, 10);
  }
  if (todos.length === 0) {
    for (const step of nextSteps) {
      uniquePush(todos, step, todoSeen, 10);
    }
  }

  const evidenceEntries = events.map((event, index) => ({
    id: `E${String(index + 1).padStart(4, "0")}`,
    label: event.signalType,
    excerpt: clipText(event.detail || event.summary, 220),
    sourceRef: event.sourceRef,
    timestamp: event.timestamp,
    score: scoreEvidence(event, index + 1, events.length)
  }));

  const rankedEvidence = evidenceEntries.sort((left, right) => {
    if (left.score === right.score) {
      const leftEpoch = Date.parse(left.timestamp || "") || 0;
      const rightEpoch = Date.parse(right.timestamp || "") || 0;
      return rightEpoch - leftEpoch;
    }
    return right.score - left.score;
  });

  const selectedEvidence = [];
  const overflowEvidence = [];
  let usedChars = 0;
  for (const evidence of rankedEvidence) {
    const line = `${evidence.id} ${evidence.label} ${evidence.excerpt} ${sourceLabel(evidence.sourceRef)}`;
    if (
      selectedEvidence.length < EVIDENCE_MAX_ITEMS &&
      usedChars + line.length <= EVIDENCE_MAX_CHARS
    ) {
      selectedEvidence.push(evidence);
      usedChars += line.length;
      continue;
    }
    overflowEvidence.push(evidence);
  }

  const startPromptLines = [
    "You are continuing engineering work migrated from Claude Code.",
    "",
    `Primary goal: ${goal}`,
    `Current state: ${currentState}`,
    "",
    "Execute the next steps in order and keep outputs concise.",
    "If any detail is missing, reference evidence IDs from L3 and request the specific source snippet.",
    "",
    "Immediate next steps:",
    ...nextSteps.map((step, index) => `${index + 1}. ${step}`)
  ];

  return {
    goal,
    currentState,
    nextSteps,
    decisions,
    commandTrace,
    failures,
    todos,
    selectedEvidence,
    overflowEvidence,
    startPrompt: startPromptLines.join("\n")
  };
}

function renderEvidenceMarkdown(entries, title) {
  const lines = [`# ${title}`, ""];
  if (entries.length === 0) {
    lines.push("- none");
    lines.push("");
    return lines.join("\n");
  }

  for (const entry of entries) {
    const timestamp = entry.timestamp ? `${entry.timestamp} ` : "";
    lines.push(
      `- ${entry.id} [${entry.label}] ${timestamp}${entry.excerpt} :: ${sourceLabel(entry.sourceRef)}`
    );
  }
  lines.push("");
  return lines.join("\n");
}

function renderPromptMarkdown(pack, options) {
  const sessionLines = options.sessions.map((session) =>
    `- ${session.threadId} (${session.projectName || "-"}, ${session.state})`
  );

  const lines = [
    "# Codex Continuation Pack",
    "",
    `Generated at: ${options.generatedAt}`,
    "",
    "## Sessions Included",
    ...sessionLines,
    "",
    "## L1: Quick Continuation Summary",
    `- Goal: ${pack.goal}`,
    `- Current state: ${pack.currentState}`,
    "- Next steps:",
    ...pack.nextSteps.map((step, index) => `  ${index + 1}. ${step}`),
    "",
    "## L2: Engineering Context",
    "### Key decisions and rationale",
    ...pack.decisions.map((line) => `- ${line}`),
    "",
    "### Command and tool trace",
    ...pack.commandTrace.map((line) => `- ${line}`),
    "",
    "### Failures / blockers",
    ...pack.failures.map((line) => `- ${line}`),
    "",
    "### Open TODOs",
    ...pack.todos.map((line) => `- ${line}`),
    "",
    "## L3: Evidence Index (High value)",
    ...pack.selectedEvidence.map((entry) => {
      const ts = entry.timestamp ? `${entry.timestamp} ` : "";
      return `- ${entry.id} [${entry.label}] ${ts}${entry.excerpt} :: ${sourceLabel(entry.sourceRef)}`;
    }),
    "",
    "## Start Prompt For Codex",
    "",
    "```text",
    pack.startPrompt,
    "```",
    ""
  ];

  return lines.join("\n");
}

function buildInlineSessionLines(sessions) {
  const visibleSessions = Array.isArray(sessions)
    ? sessions.slice(0, INLINE_SESSION_LINE_LIMIT)
    : [];

  const lines = visibleSessions.map((session) => {
    return `- ${session.threadId} (${session.projectName || "-"}, ${session.state})`;
  });

  const hiddenCount = Array.isArray(sessions) ? sessions.length - visibleSessions.length : 0;
  if (hiddenCount > 0) {
    lines.push(`- ${hiddenCount} more session(s) included in the local export package`);
  }

  return lines;
}

function renderInlineHandoffPack(pack, options = {}) {
  const sessionLines = buildInlineSessionLines(options.sessions || []);
  let goalMax = 360;
  let currentStateMax = 640;
  let decisionLimit = pack.decisions.length;
  let decisionMax = 220;
  let failureLimit = pack.failures.length;
  let failureMax = 220;
  let commandLimit = pack.commandTrace.length;
  let commandMax = 180;
  let evidenceLimit = pack.selectedEvidence.length;
  let evidenceMax = 160;
  let trimmed = false;

  const buildText = () => {
    const lines = [
      "Claude Code migration context for this new Codex thread.",
      "",
      "## Sessions Included",
      ...sessionLines,
      "",
      "## Goal",
      clipText(pack.goal, goalMax),
      "",
      "## Current State",
      clipText(pack.currentState, currentStateMax),
      "",
      "## Immediate Next Steps",
      ...pack.nextSteps.map((step, index) => `${index + 1}. ${clipText(step, 220)}`),
      ""
    ];

    if (decisionLimit > 0) {
      lines.push("## Key Decisions");
      lines.push(...pack.decisions.slice(0, decisionLimit).map((line) => `- ${clipText(line, decisionMax)}`));
      lines.push("");
    }

    if (failureLimit > 0) {
      lines.push("## Failures / Blockers");
      lines.push(...pack.failures.slice(0, failureLimit).map((line) => `- ${clipText(line, failureMax)}`));
      lines.push("");
    }

    if (commandLimit > 0) {
      lines.push("## Command Trace");
      lines.push(...pack.commandTrace.slice(0, commandLimit).map((line) => `- ${clipText(line, commandMax)}`));
      lines.push("");
    }

    if (evidenceLimit > 0) {
      lines.push("## High-Value Evidence");
      lines.push(
        ...pack.selectedEvidence.slice(0, evidenceLimit).map((entry) => {
          const excerpt = clipText(entry.excerpt, evidenceMax);
          return `- ${entry.id} [${entry.label}] ${excerpt}`;
        })
      );
      lines.push("");
    }

    lines.push("If more detail is needed later, ask for the specific evidence ID or consult the local export files.");
    lines.push("");
    return lines.join("\n");
  };

  let text = buildText();

  const reducers = [
    () => {
      if (evidenceLimit <= 2) {
        return false;
      }
      const nextLimit = evidenceLimit > 12
        ? Math.max(2, evidenceLimit - Math.max(2, Math.ceil((evidenceLimit - 12) / 3)))
        : evidenceLimit - 1;
      evidenceLimit = nextLimit;
      return true;
    },
    () => {
      if (evidenceMax <= 120) {
        return false;
      }
      evidenceMax -= 20;
      return true;
    },
    () => {
      if (commandLimit <= 2) {
        return false;
      }
      commandLimit -= 1;
      return true;
    },
    () => {
      if (commandMax <= 120) {
        return false;
      }
      commandMax -= 20;
      return true;
    },
    () => {
      if (decisionLimit <= 2) {
        return false;
      }
      decisionLimit -= 1;
      return true;
    },
    () => {
      if (decisionMax <= 140) {
        return false;
      }
      decisionMax -= 20;
      return true;
    },
    () => {
      if (currentStateMax <= 340) {
        return false;
      }
      currentStateMax -= 60;
      return true;
    },
    () => {
      if (failureLimit <= 1) {
        return false;
      }
      failureLimit -= 1;
      return true;
    },
    () => {
      if (failureMax <= 140) {
        return false;
      }
      failureMax -= 20;
      return true;
    },
    () => {
      if (goalMax <= 220) {
        return false;
      }
      goalMax -= 20;
      return true;
    }
  ];

  let reducerIndex = 0;
  while (countChars(text) > INLINE_HANDOFF_MAX_CHARS && reducerIndex < reducers.length) {
    const changed = reducers[reducerIndex]();
    if (!changed) {
      reducerIndex += 1;
      continue;
    }
    trimmed = true;
    text = buildText();
  }

  if (countChars(text) > INLINE_HANDOFF_MAX_CHARS) {
    trimmed = true;
    const truncated = Array.from(text).slice(0, INLINE_HANDOFF_MAX_CHARS - 14).join("");
    text = `${truncated}\n\n[truncated]`;
  }

  return {
    text,
    trimmed,
    charCount: countChars(text)
  };
}

function parseBooleanFlag(value, fallbackValue) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === undefined || value === null) {
    return fallbackValue;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return fallbackValue;
}

async function parseJsonlFile(filePath, options) {
  const fileContent = await fs.readFile(filePath, "utf8");
  const lines = fileContent.split(/\r?\n/);
  const parsedEvents = [];
  const rawRecords = [];
  const parseWarnings = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }

    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      parseWarnings.push({
        file: options.sourceFile,
        line: index + 1,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    const recordSessionId = typeof record.sessionId === "string" && record.sessionId
      ? record.sessionId
      : options.fallbackSessionId;
    const parsedTime = toIsoOrNull(record.timestamp);
    const sourceRef = {
      sessionId: recordSessionId,
      file: options.sourceFile,
      line: index + 1
    };

    rawRecords.push({
      sourceRef,
      record
    });

    const base = {
      eventId: `${recordSessionId}:${options.sourceFile}:${index + 1}`,
      sessionId: recordSessionId,
      eventType: String(record.type || "unknown"),
      timestamp: parsedTime.iso,
      timestampMs: parsedTime.ms,
      sourceRef
    };

    for (const signal of extractSignalsFromRecord(record, base)) {
      parsedEvents.push(signal);
    }
  }

  return {
    events: parsedEvents,
    rawRecords,
    parseWarnings
  };
}

async function listSubagentFiles(mainSessionPath) {
  const subagentDir = path.join(path.dirname(mainSessionPath), "subagents");
  let entries;
  try {
    entries = await fs.readdir(subagentDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(subagentDir, entry.name));
}

/**
 * Collect and normalize Claude events from selected sessions.
 *
 * @param {Object[]} items
 * @param {boolean} includeSubagents
 * @param {Object} options
 * @param {string} options.claudeHome
 * @returns {Promise<{events: NormalizedClaudeEvent[], rawRecords: Object[], parseWarnings: Object[]}>}
 */
async function collectClaudeEventsFromItems(items, includeSubagents = true, options = {}) {
  const claudeHome = path.resolve(String(options.claudeHome || path.join(os.homedir(), ".claude")));
  const allEvents = [];
  const allRawRecords = [];
  const allWarnings = [];
  let sequence = 0;

  for (const item of items) {
    if (!item || !item.absolutePath) {
      continue;
    }

    if (!(await pathExists(item.absolutePath))) {
      throw new Error(`session file is missing: ${item.absolutePath}`);
    }

    const filesToParse = [item.absolutePath];
    if (includeSubagents) {
      filesToParse.push(...(await listSubagentFiles(item.absolutePath)));
    }

    for (const absoluteFilePath of filesToParse) {
      const sourceFile = normalizeRelativePath(path.relative(claudeHome, absoluteFilePath));
      const parsed = await parseJsonlFile(absoluteFilePath, {
        sourceFile,
        fallbackSessionId: item.threadId
      });

      for (const event of parsed.events) {
        sequence += 1;
        allEvents.push({
          ...event,
          sequence
        });
      }
      allRawRecords.push(...parsed.rawRecords);
      allWarnings.push(...parsed.parseWarnings);
    }
  }

  allEvents.sort((left, right) => {
    if (left.timestampMs === null && right.timestampMs === null) {
      return left.sequence - right.sequence;
    }
    if (left.timestampMs === null) {
      return 1;
    }
    if (right.timestampMs === null) {
      return -1;
    }
    if (left.timestampMs === right.timestampMs) {
      return left.sequence - right.sequence;
    }
    return left.timestampMs - right.timestampMs;
  });

  return {
    events: allEvents,
    rawRecords: allRawRecords,
    parseWarnings: allWarnings
  };
}

function normalizeStringArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.map((value) => String(value));
}

function ensureOptionValue(rawValue, supportedValues, label, fallbackValue) {
  if (rawValue === undefined || rawValue === null) {
    return fallbackValue;
  }
  const normalized = String(rawValue);
  if (!supportedValues.has(normalized)) {
    throw new Error(`unsupported ${label}: ${normalized}`);
  }
  return normalized;
}

async function resolveHandoffCwd(options, selectedItems) {
  if (options.handoffCwd !== undefined && options.handoffCwd !== null) {
    return path.resolve(String(options.handoffCwd));
  }

  const firstAbsoluteProject = selectedItems
    .map((item) => item.projectName)
    .find((projectName) => typeof projectName === "string" && projectName.startsWith("/"));

  if (firstAbsoluteProject) {
    const resolved = await resolveExistingPathOrAncestor(firstAbsoluteProject);
    if (resolved) {
      return resolved;
    }
  }

  return process.cwd();
}

async function resolveExistingPathOrAncestor(targetPath) {
  if (!targetPath || typeof targetPath !== "string" || !path.isAbsolute(targetPath)) {
    return null;
  }

  let current = path.resolve(targetPath);
  const parsedRoot = path.parse(current).root;

  while (true) {
    if (await pathExists(current)) {
      return current;
    }
    if (current === parsedRoot) {
      return null;
    }
    current = path.dirname(current);
  }
}

async function inferHandoffCwdFromRawRecords(rawRecords) {
  const counts = new Map();
  for (const entry of rawRecords) {
    const candidate = entry &&
      entry.record &&
      typeof entry.record === "object" &&
      typeof entry.record.cwd === "string"
      ? entry.record.cwd.trim()
      : "";
    if (!candidate || !path.isAbsolute(candidate)) {
      continue;
    }
    counts.set(candidate, (counts.get(candidate) || 0) + 1);
  }

  if (counts.size === 0) {
    return null;
  }

  const byCount = Array.from(counts.entries()).sort((left, right) => right[1] - left[1]);
  const ancestorCounts = new Map();
  for (const [candidate] of byCount) {
    const resolved = await resolveExistingPathOrAncestor(candidate);
    if (!resolved) {
      continue;
    }
    if (resolved === candidate) {
      return resolved;
    }
    ancestorCounts.set(resolved, (ancestorCounts.get(resolved) || 0) + (counts.get(candidate) || 0));
  }

  if (ancestorCounts.size > 0) {
    return Array.from(ancestorCounts.entries()).sort((left, right) => right[1] - left[1])[0][0];
  }
  return null;
}

/**
 * Export selected Claude sessions into a Codex continuation package.
 *
 * @param {Object} options
 * @param {string[]} options.itemIds
 * @param {boolean} options.ownershipConfirmed
 * @param {boolean} [options.includeSubagents]
 * @param {string} [options.compression]
 * @param {string} [options.budgetStrategy]
 * @param {boolean} [options.handoffToCodex]
 * @param {boolean} [options.launchCodexApp]
 * @param {boolean} [options.restartCodexApp]
 * @param {string} [options.handoffCwd]
 * @param {Function} [options.handoffFn]
 * @param {string} [options.exportRoot]
 * @param {Object} options.claudeStore
 * @param {string} options.claudeHome
 */
async function exportClaudeSessions(options) {
  const itemIds = normalizeStringArray(options.itemIds);
  if (itemIds.length === 0) {
    throw new Error("itemIds must not be empty");
  }

  if (options.ownershipConfirmed !== true) {
    throw new Error("ownership confirmation is required");
  }

  for (const itemId of itemIds) {
    if (!isClaudeItemId(itemId)) {
      throw new Error(`itemId is not a Claude session id: ${itemId}`);
    }
  }

  if (!options.claudeStore || typeof options.claudeStore.findItemsByIds !== "function") {
    throw new Error("claudeStore is required");
  }

  const includeSubagents = parseBooleanFlag(options.includeSubagents, true);
  const compression = ensureOptionValue(
    options.compression,
    SUPPORTED_COMPRESSION,
    "compression",
    "three-layer"
  );
  const budgetStrategy = ensureOptionValue(
    options.budgetStrategy,
    SUPPORTED_BUDGET,
    "budgetStrategy",
    "layered-trim"
  );
  const handoffToCodex = parseBooleanFlag(options.handoffToCodex, false);
  const launchCodexApp = parseBooleanFlag(options.launchCodexApp, true);
  const restartCodexApp = parseBooleanFlag(options.restartCodexApp, false);
  const handoffFn = typeof options.handoffFn === "function"
    ? options.handoffFn
    : handoffToCodexThread;

  const selected = await options.claudeStore.findItemsByIds(itemIds);
  if (selected.missing.length > 0) {
    throw new Error(`sessions not found: ${selected.missing.join(", ")}`);
  }

  const claudeHome = path.resolve(String(options.claudeHome || path.join(os.homedir(), ".claude")));
  const exportRoot = path.resolve(String(options.exportRoot || defaultExportRoot()));
  const exportId = createExportId();
  const exportDir = path.join(exportRoot, exportId);
  await ensureDir(exportDir);

  const collected = await collectClaudeEventsFromItems(selected.found, includeSubagents, {
    claudeHome
  });

  const promptPack = buildThreeLayerPack(collected.events, budgetStrategy);
  const generatedAt = new Date().toISOString();

  const promptMarkdown = renderPromptMarkdown(promptPack, {
    generatedAt,
    sessions: selected.found
  });
  const inlineHandoff = renderInlineHandoffPack(promptPack, {
    generatedAt,
    sessions: selected.found
  });
  const overflowMarkdown = renderEvidenceMarkdown(
    promptPack.overflowEvidence,
    "Overflow Evidence (Not Included In Main Prompt)"
  );

  const files = {
    promptMarkdown: path.join(exportDir, "codex-import-prompt.md"),
    contextJson: path.join(exportDir, "context-pack.json"),
    rawJsonl: path.join(exportDir, "raw-events.jsonl"),
    manifest: path.join(exportDir, "manifest.json"),
    overflow: path.join(exportDir, "overflow-evidence.md")
  };

  const stats = {
    sessionCount: selected.found.length,
    eventCount: collected.events.length,
    sourceBytes: Buffer.byteLength(
      collected.rawRecords.map((entry) => JSON.stringify(entry.record)).join("\n"),
      "utf8"
    ),
    selectedEvidenceCount: promptPack.selectedEvidence.length,
    overflowEvidenceCount: promptPack.overflowEvidence.length
  };

  const contextPack = {
    exportId,
    generatedAt,
    sessions: selected.found.map((item) => ({
      itemId: item.itemId,
      threadId: item.threadId,
      title: item.title,
      state: item.state,
      projectName: item.projectName || null,
      fileName: item.fileName || null,
      relativePath: item.relativePath || null
    })),
    options: {
      includeSubagents,
      compression,
      budgetStrategy,
      handoffToCodex,
      launchCodexApp,
      restartCodexApp
    },
    summary: {
      goal: promptPack.goal,
      currentState: promptPack.currentState,
      nextSteps: promptPack.nextSteps
    },
    engineering: {
      decisions: promptPack.decisions,
      commandTrace: promptPack.commandTrace,
      failures: promptPack.failures,
      todos: promptPack.todos
    },
    evidence: {
      selected: promptPack.selectedEvidence,
      overflowCount: promptPack.overflowEvidence.length
    },
    parseWarnings: collected.parseWarnings,
    stats
  };

  /** @type {ExportManifest} */
  const manifest = {
    exportId,
    generatedAt,
    sessions: contextPack.sessions,
    options: contextPack.options,
    stats,
    parseWarnings: collected.parseWarnings
  };

  const rawJsonlBody = collected.rawRecords
    .map((entry) => JSON.stringify(entry))
    .join("\n");

  await Promise.all([
    fs.writeFile(files.promptMarkdown, promptMarkdown, "utf8"),
    fs.writeFile(files.contextJson, JSON.stringify(contextPack, null, 2), "utf8"),
    fs.writeFile(
      files.rawJsonl,
      rawJsonlBody.length > 0 ? `${rawJsonlBody}\n` : "",
      "utf8"
    ),
    fs.writeFile(files.manifest, JSON.stringify(manifest, null, 2), "utf8"),
    fs.writeFile(files.overflow, overflowMarkdown, "utf8")
  ]);

  let codexHandoff = null;
  if (handoffToCodex) {
    const inferredCwd = await inferHandoffCwdFromRawRecords(collected.rawRecords);
    const handoffCwd = options.handoffCwd !== undefined && options.handoffCwd !== null
      ? path.resolve(String(options.handoffCwd))
      : inferredCwd || await resolveHandoffCwd(options, selected.found);
    const threadName = buildCodexThreadName({
      sessions: selected.found,
      pack: promptPack,
      handoffCwd
    });
    try {
      const handoff = await handoffFn({
        prompt: inlineHandoff.text,
        promptFilePath: files.promptMarkdown,
        contextFilePath: files.contextJson,
        cwd: handoffCwd,
        launchCodexApp,
        restartCodexApp,
        threadName,
        mode: "inline-pack",
        trimmed: inlineHandoff.trimmed,
        inlineChars: inlineHandoff.charCount
      });
      codexHandoff = {
        ok: true,
        cwd: handoffCwd,
        threadName,
        ...handoff,
        mode: "inline-pack",
        trimmed: inlineHandoff.trimmed,
        inlineChars: inlineHandoff.charCount
      };
    } catch (error) {
      codexHandoff = {
        ok: false,
        cwd: handoffCwd,
        threadName,
        mode: "inline-pack",
        trimmed: inlineHandoff.trimmed,
        inlineChars: inlineHandoff.charCount,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  return {
    exportId,
    exportDir,
    files,
    stats,
    promptText: promptMarkdown,
    codexHandoff
  };
}

module.exports = {
  buildThreeLayerPack,
  collectClaudeEventsFromItems,
  exportClaudeSessions,
  renderInlineHandoffPack
};
