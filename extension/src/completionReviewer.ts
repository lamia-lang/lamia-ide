/**
 * Completion reviewer for Lamia IDE.
 *
 * Layer 1: Deterministic workflow gate checks using tool call data.
 * Runs after every proc.send() response -- zero cost, instant.
 * When flags are raised, Layer 2 (LLM judge) confirms before acting.
 *
 */

import { FileWrite } from "./lamiaProcess";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ToolCallInfo {
  tool: string;
  args: Record<string, unknown>;
  success?: boolean;
  error?: string;
}

export interface ReviewInput {
  userMessage: string;
  responseText: string;
  toolCalls: ToolCallInfo[];
  fileWrites: FileWrite[];
}

export type FlagType =
  | "lint_unresolved"
  | "write_failed"
  | "empty_response"
  | "no_op_turn"
  | "internal_context_leak";

export interface ReviewFlag {
  type: FlagType;
  detail: string;
  evidence: Record<string, unknown>;
}

export interface ReviewResult {
  verdict: "pass" | "flag";
  flags: ReviewFlag[];
}

// ── Constants ────────────────────────────────────────────────────────────────

const WRITE_TOOLS = new Set(["write_file", "patch_file", "delete_file"]);
const MAX_REVIEW_ROUNDS = 2;

/**
 * Keywords in user messages that indicate a request for changes (not just questions).
 * If none of these appear, the no-op check is skipped since the user may just
 * be asking about the codebase.
 */
const CHANGE_REQUEST_WORDS = [
  "fix", "edit", "update", "change", "modify", "add", "create", "remove",
  "delete", "refactor", "implement", "write", "rewrite", "move", "rename",
  "replace", "improve", "patch", "merge", "build", "install", "upgrade",
  "migrate", "convert", "deploy", "configure", "setup", "set up",
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function isChangeRequest(userMessage: string): boolean {
  const lower = userMessage.toLowerCase();
  return CHANGE_REQUEST_WORDS.some(w => lower.includes(w));
}

function getToolPath(args: Record<string, unknown>): string {
  return (args.path as string) || "";
}

// ── Checks ───────────────────────────────────────────────────────────────────

function checkLintUnresolved(toolCalls: ToolCallInfo[]): ReviewFlag | null {
  const writeCalls = toolCalls.filter(t => WRITE_TOOLS.has(t.tool));
  if (writeCalls.length === 0) return null;

  for (let i = writeCalls.length - 1; i >= 0; i--) {
    const call = writeCalls[i];
    if (call.success === false) {
      const failedPath = getToolPath(call.args);
      const laterSuccess = writeCalls.slice(i + 1).some(
        later => later.success !== false && getToolPath(later.args) === failedPath
      );
      if (!laterSuccess) {
        return {
          type: "lint_unresolved",
          detail: `write/patch to "${failedPath}" failed (likely lint errors) and was not retried`,
          evidence: { path: failedPath, error: call.error },
        };
      }
    }
  }
  return null;
}

function checkWriteFailed(toolCalls: ToolCallInfo[]): ReviewFlag | null {
  const failedWrites = toolCalls.filter(
    t => WRITE_TOOLS.has(t.tool) && t.success === false
  );
  if (failedWrites.length === 0) return null;

  for (const failed of failedWrites) {
    const failedPath = getToolPath(failed.args);
    const retried = toolCalls.some(
      t => t !== failed
        && WRITE_TOOLS.has(t.tool)
        && getToolPath(t.args) === failedPath
        && t.success !== false
        && (t as any).ts > (failed as any).ts
    );
    if (!retried) {
      return {
        type: "write_failed",
        detail: `${failed.tool} on "${failedPath}" failed and was never retried`,
        evidence: { tool: failed.tool, path: failedPath, error: failed.error },
      };
    }
  }
  return null;
}

function checkEmptyResponse(
  responseText: string,
  toolCalls: ToolCallInfo[]
): ReviewFlag | null {
  if (toolCalls.length > 0 && responseText.trim().length < 30) {
    return {
      type: "empty_response",
      detail: `Response is only ${responseText.trim().length} chars after ${toolCalls.length} tool calls`,
      evidence: { responseLength: responseText.trim().length, toolCount: toolCalls.length },
    };
  }
  return null;
}

function checkNoOpTurn(
  userMessage: string,
  responseText: string,
  toolCalls: ToolCallInfo[],
  fileWrites: FileWrite[]
): ReviewFlag | null {
  if (!isChangeRequest(userMessage)) return null;

  const hasWriteCall = toolCalls.some(t => WRITE_TOOLS.has(t.tool));
  const hasFileWrites = fileWrites.length > 0;

  if (!hasWriteCall && !hasFileWrites && toolCalls.length > 0 && responseText.length > 100) {
    return {
      type: "no_op_turn",
      detail: "User asked for changes but only read operations were performed",
      evidence: {
        toolsUsed: [...new Set(toolCalls.map(t => t.tool))],
        totalTools: toolCalls.length,
        fileWriteCount: 0,
      },
    };
  }
  return null;
}

function checkInternalContextLeak(responseText: string): ReviewFlag | null {
  const markers = [
    "<turn_context_json>",
    "</turn_context_json>",
    "\"toolCalls\"",
    "\"fileWrites\"",
    "\"responseTs\"",
  ];
  const lower = responseText.toLowerCase();
  const hit = markers.find(m => lower.includes(m.toLowerCase()));
  if (!hit) return null;
  return {
    type: "internal_context_leak",
    detail: `Response leaked internal execution context (${hit})`,
    evidence: { marker: hit },
  };
}

// ── Main review function ─────────────────────────────────────────────────────

export function reviewCompletion(input: ReviewInput): ReviewResult {
  const flags: ReviewFlag[] = [];

  const lint = checkLintUnresolved(input.toolCalls);
  if (lint) flags.push(lint);

  const writeFail = checkWriteFailed(input.toolCalls);
  if (writeFail && !lint) flags.push(writeFail);

  const empty = checkEmptyResponse(input.responseText, input.toolCalls);
  if (empty) flags.push(empty);

  const noOp = checkNoOpTurn(
    input.userMessage, input.responseText, input.toolCalls, input.fileWrites
  );
  if (noOp) flags.push(noOp);

  const contextLeak = checkInternalContextLeak(input.responseText);
  if (contextLeak) flags.push(contextLeak);

  return {
    verdict: flags.length > 0 ? "flag" : "pass",
    flags,
  };
}

// ── Judge prompt builder ─────────────────────────────────────────────────────

export function buildJudgePrompt(
  userMessage: string,
  responseText: string,
  toolCalls: ToolCallInfo[],
  fileWrites: FileWrite[],
  flags: ReviewFlag[]
): string {
  const toolSummary = toolCalls
    .map(t => {
      const status = t.success === false ? " [FAILED]" : "";
      const path = getToolPath(t.args);
      return `- ${t.tool}${path ? ` (${path})` : ""}${status}`;
    })
    .join("\n");

  const fileSummary = fileWrites
    .map(f => `- ${f.action}: ${f.path}`)
    .join("\n") || "(none)";

  const flagSummary = flags
    .map(f => `- [${f.type}] ${f.detail}`)
    .join("\n");

  return `You are verifying whether an AI coding agent completed its task correctly.

User's request:
${userMessage}

Agent's response:
${responseText}

Tool calls made:
${toolSummary || "(none)"}

Files modified:
${fileSummary}

Flags raised by automated checks:
${flagSummary}

Evaluate: Did the agent actually address the user's request?
Consider the flags above -- are they real problems or false positives?

Return JSON only:
{
  "verdict": "PASS" or "FAIL",
  "reason": "brief explanation",
  "feedback": "what the agent should do next (only if FAIL, otherwise empty string)"
}`;
}

// ── Escalating feedback ──────────────────────────────────────────────────────

export function buildEscalatingFeedback(
  round: number,
  flags: ReviewFlag[],
  judgeFeedback?: string
): string {
  const flagList = flags.map(f => `- ${f.detail}`).join("\n");

  if (round === 1) {
    return [
      "Your previous response had issues that need to be addressed:",
      "",
      flagList,
      "",
      judgeFeedback || "",
      "",
      "Please fix these issues and continue.",
    ].filter(Boolean).join("\n");
  }

  return [
    "FINAL ATTEMPT: Your response still has unresolved issues:",
    "",
    flagList,
    "",
    judgeFeedback || "",
    "",
    "This is your last chance. Either fix the issues now or explain clearly what is blocking you.",
    "Do NOT re-read files or re-plan. Implement the fix or explain why you cannot.",
  ].filter(Boolean).join("\n");
}

export { MAX_REVIEW_ROUNDS };
