import * as vscode from "vscode";
import { LamiaProcess, LamiaResponse, FileWrite } from "./lamiaProcess";
import { setApiKey, getConfiguredProviders, validateApiKey, getApiKeyInfo, ApiKeyInfo } from "./envHelper";
import {
  readAllProviderModels,
  fetchRuntimeProviderModels,
  fetchFallbackModels,
  buildModelDropdown,
  ensureGlobalConfig,
  ModelOption,
} from "./configHelper";
import {
  Chat,
  ChatMessage,
  newChat,
  saveChat,
  loadLatestChat,
  listChats,
  loadChat,
  deleteChat,
} from "./chatStore";
import { NoPythonError } from "./lamiaInstaller";
import { getChatConfigPath, writeSelectedModel, readSelectedModel, ensureChatConfig } from "./chatConfig";
import { filterFiles } from "./fileContext";
import { getLastCopied, clearLastCopied, CopiedSnippet } from "./clipboardStore";
import {
  reviewCompletion,
  buildJudgePrompt,
  buildEscalatingFeedback,
  MAX_REVIEW_ROUNDS,
  ReviewFlag,
  ToolCallInfo,
  ReviewResult,
} from "./completionReviewer";
import { sanitizeAssistantResponseText } from "./responseSanitizer";
import { McpManager, McpServerInfo } from "./mcpManager";

// ── Types ────────────────────────────────────────────────────────────────────

type WebviewMessage =
  | { type: "send"; message: string; model: string; files?: string[]; snippets?: CopiedSnippet[] }
  | { type: "changeModel"; model: string }
  | { type: "saveApiKey"; provider: string; key: string }
  | { type: "insertSnippet"; code: string }
  | { type: "getFiles"; query: string }
  | { type: "getClipboardContext" }
  | { type: "openFile"; path: string }
  | { type: "openDiff"; path: string; original: string }
  | { type: "ready" }
  | { type: "newChat" }
  | { type: "loadChat"; id: string }
  | { type: "deleteChat"; id: string }
  | { type: "listChats" }
  | { type: "retry" }
  | { type: "stop" }
  | { type: "dropFile"; uri: string }
  | { type: "command"; command: string }
  | { type: "openExternal"; url: string }
  | { type: "getMcpServers" }
  | { type: "saveMcpServer"; name: string; oldName?: string; config: string }
  | { type: "deleteMcpServer"; name: string }
  | { type: "toggleMcpServer"; name: string; enabled: boolean };

type HostMessage =
  | { type: "response"; text: string; model?: string; tokens?: { input: number; output: number } }
  | { type: "clipboardContext"; snippet: CopiedSnippet | null }
  | { type: "error"; text: string; errorType?: string }
  | { type: "thinking"; active: boolean }
  | { type: "toolProgress"; tool: string; label: string }
  | { type: "toolResult"; tool: string; success: boolean; error?: string }
  | { type: "fileChanges"; files: { path: string; action: string; original?: string }[] }
  | { type: "populateInput"; text: string }
  | { type: "stopped" }
  | { type: "addFile"; file: { name: string; relativePath: string; absolutePath: string } }
  | {
      type: "init";
      models: ModelOption[];
      allModels: ModelOption[];
      configuredProviders: string[];
      keyInfos: Record<string, { source: string; masked: string }>;
      selectedModel: string | null;
      messages: ChatMessage[];
      chatTitle: string;
    }
  | {
      type: "updateModels";
      models: ModelOption[];
      allModels: ModelOption[];
      configuredProviders: string[];
      keyInfos: Record<string, { source: string; masked: string }>;
    }
  | {
      type: "fileList";
      files: { name: string; relativePath: string; absolutePath: string }[];
    }
  | {
      type: "chatList";
      chats: { id: string; title: string; updated: number }[];
      currentId: string;
    }
  | {
      type: "mcpServers";
      servers: McpServerInfo[];
    }
  | {
      type: "mcpActionResult";
      ok: boolean;
      message: string;
      final?: boolean;
    }
  | {
      type: "apiKeyValidation";
      provider: string;
      valid: boolean;
      error?: string;
    }
;


const SYSTEM_HINT = "You are an assistant in Lamia Studio, an IDE for the Lamia programming language. " +
  "If the user asks for code changes, perform the changes using tools. Do not only propose code. " +
  "When modifying or creating files, ALWAYS use your file tools - never just show code in your response. " +
  "IMPORTANT: When editing existing files, make MINIMAL targeted changes. " +
  "Prefer using .hu files for code changes when possible. Only complicated logic like orchestration changes will be in .lm files. " +
  "Use your tools to look up the relevant documentation before answering. " +
  "Do not create new files if you can edit existing ones. " +
  "When writing .lm files, use Lamia syntax as much as possible - as few plain Python lines as possible.\n\n" +
  "Do NOT rewrite entire files when only a few lines need changing. " +
  "Do NOT add boilerplate, emojis, verbose commentary, or decorative formatting. " +
  ".hu files are concise prompt templates - keep them short and readable. " +
  "Do NOT add YAML front matter (---name/model/temperature---) unless the file already has it. " +
  "Read the file first, then change only what the user asked for. " +
  "When asked to copy or move files/directories, ALWAYS use the appropriate file tools - never recreate files manually. " +
  "Use your search and file-finding tools when exploring the codebase. " +
  "Use your browser tools for web testing and automation when the user asks to test, verify, or interact with web pages.\n\n" +
  "Before showing Lamia code (.lm or .hu) in chat, run lint_code and fix any errors. " +
  "If the user asks to present or show code, return it in chat and do not write files unless they explicitly ask for file changes.";

function buildSnippetPrefix(snippets: CopiedSnippet[] | undefined): string {
  if (!snippets || snippets.length === 0) return "";
  return snippets
    .map((s) => {
      const lineInfo = s.startLine === s.endLine
        ? `line ${s.startLine}`
        : `lines ${s.startLine}-${s.endLine}`;
      return [
        `<copied_snippet file="${s.filePath}" ${lineInfo}>`,
        s.text,
        "</copied_snippet>",
      ].join("\n");
    })
    .join("\n\n");
}

export function buildFileContextPrefix(filePaths: string[] | undefined): string {
  if (!filePaths || filePaths.length === 0) return "";
  const path = require("path");
  return filePaths
    .map((fp) => {
      const dir = path.dirname(fp);
      return `<attached_file path="${fp}" directory="${dir}">` +
        `Relative paths in this file resolve from ${dir}` +
        `</attached_file>`;
    })
    .join("\n");
}

export function deduplicateFileWrites(files: FileWrite[]): FileWrite[] {
  const seen = new Map<string, FileWrite>();
  const order: string[] = [];

  for (const f of files) {
    if (seen.has(f.path)) {
      const prev = seen.get(f.path)!;
      prev.content = f.content;

      // Keep "create" sticky across same-turn follow-up writes.
      // If a file is first created and then written again, users still expect
      // the final badge to say "Created", not "Modified".
      if (!(prev.action === "create" && f.action === "modify")) {
        prev.action = f.action;
      }
    } else {
      seen.set(f.path, { ...f });
      order.push(f.path);
    }
  }

  return order.map((p) => seen.get(p)!);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// ── Provider ─────────────────────────────────────────────────────────────────

const HISTORY_CHAR_BUDGET = 40_000;
const RECENT_TURNS_KEEP = 6;
const COMPRESS_THRESHOLD = 6_000;

type ToolCallRecord = {
  tool: string;
  label: string;
  args: Record<string, unknown>;
  success?: boolean;
  error?: string;
  ts: number;
};

export class LamiaChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "lamia.chatView";
  private _view?: vscode.WebviewView;
  private _process: LamiaProcess | null = null;
  private _chat: Chat;
  private _lastFileWrites: FileWrite[] = [];
  private _generating = false;

  private _historySummary: string | null = null;
  private _summarizedCount = 0;
  private _compressing = false;
  private _reviewRound = 0;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _mcpManager?: McpManager,
  ) {
    this._chat = loadLatestChat() || newChat();

    this._context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this._refreshModels())
    );

    const configWatcher = vscode.workspace.createFileSystemWatcher("**/config.yaml");
    configWatcher.onDidChange(() => this._refreshModels());
    configWatcher.onDidCreate(() => this._refreshModels());
    configWatcher.onDidDelete(() => this._refreshModels());
    this._context.subscriptions.push(configWatcher);
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, "media")],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this._handleMessage(msg),
      undefined,
      this._context.subscriptions
    );

    webviewView.onDidDispose(() => {
      this._process?.dispose();
      this._process = null;
    });
  }

  public dispose(): void {
    this._process?.dispose();
    this._process = null;
  }

  // ── History compression ────────────────────────────────────────────────────

  private _buildHistoryForLLM(): { role: string; text: string }[] {
    const meaningful = this._chat.messages
      .slice(0, -1)
      .filter(m => m.role !== "error");
    if (meaningful.length === 0) { return []; }
    if (meaningful.length <= RECENT_TURNS_KEEP) {
      return meaningful.map(m => ({ role: m.role, text: this._messageTextForHistory(m) }));
    }

    const older = meaningful.slice(0, -RECENT_TURNS_KEEP);
    const recent = meaningful.slice(-RECENT_TURNS_KEEP);

    if (this._historySummary && this._summarizedCount >= older.length) {
      return [
        { role: "system", text: this._historySummary },
        ...recent.map(m => ({ role: m.role, text: this._messageTextForHistory(m) })),
      ];
    }

    return meaningful.map(m => ({ role: m.role, text: this._messageTextForHistory(m) }));
  }

  private _messageTextForHistory(message: ChatMessage): string {
    return message.text;
  }

  private _sanitizeAssistantResponse(text: string): string {
    return sanitizeAssistantResponseText(text);
  }

  // ── MCP fallback for unknown tools ──────────────────────────────────────

  private async _retryFailedToolsViaMcp(
    response: LamiaResponse,
    completedTools: ToolCallRecord[],
    proc: LamiaProcess,
    systemHint: string,
    files: string[] | undefined,
    history: { role: string; text: string }[],
  ): Promise<{ response: LamiaResponse; extraTools: ToolCallRecord[] } | null> {
    if (!this._mcpManager || response.type !== "response") return null;

    const failedMcpTools = completedTools.filter(
      t => t.success === false
        && t.error?.startsWith("Unknown tool")
        && this._mcpManager!.hasTool(t.tool)
    );
    if (failedMcpTools.length === 0) return null;

    const mcpResults: { tool: string; args: Record<string, unknown>; result: string; success: boolean }[] = [];
    const extraTools: ToolCallRecord[] = [];

    for (const failed of failedMcpTools) {
      this._post({ type: "toolProgress", tool: failed.tool, label: `MCP: ${failed.tool.replace(/_/g, " ")}` });
      const mcpResult = await this._mcpManager!.callTool(failed.tool, failed.args);
      mcpResults.push({ tool: failed.tool, args: failed.args, ...mcpResult });
      extraTools.push({
        tool: failed.tool,
        label: `MCP: ${failed.tool.replace(/_/g, " ")}`,
        args: failed.args,
        success: mcpResult.success,
        error: mcpResult.success ? undefined : mcpResult.result,
        ts: Date.now(),
      });
      this._post({ type: "toolResult", tool: failed.tool, success: mcpResult.success, error: mcpResult.success ? undefined : mcpResult.result });
    }

    const successfulResults = mcpResults.filter(r => r.success);
    if (successfulResults.length === 0) return null;

    const resultsBlock = successfulResults.map(r =>
      `Tool "${r.tool}" result:\n${r.result}`
    ).join("\n\n");

    const followUp =
      `The following tools were executed via MCP and returned results:\n\n` +
      `${resultsBlock}\n\n` +
      `Please incorporate these results into your response to the user.`;

    const updatedHistory = [
      ...history,
      { role: "assistant", text: response.text ?? "" },
    ];

    const retryResponse = await proc.send(followUp, {
      system: systemHint,
      files,
      messages: updatedHistory,
    });

    return { response: retryResponse, extraTools };
  }

  // ── Completion reviewer ──────────────────────────────────────────────────

  private _toToolCallInfos(records: ToolCallRecord[]): ToolCallInfo[] {
    return records.map(r => ({
      tool: r.tool,
      args: r.args,
      success: r.success,
      error: r.error,
    }));
  }

  private async _runLLMJudge(
    userMessage: string,
    responseText: string,
    toolCalls: ToolCallInfo[],
    fileWrites: FileWrite[],
    flags: ReviewFlag[]
  ): Promise<{ verdict: string; reason: string; feedback: string }> {
    const prompt = buildJudgePrompt(userMessage, responseText, toolCalls, fileWrites, flags);
    const proc = await this._ensureProcess();
    const result = await proc.send(prompt, {
      system: "You are a strict code review judge. Return ONLY valid JSON, nothing else.",
    });
    try {
      const text = (result.text || "").trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch {
      // fall through
    }
    return { verdict: "PASS", reason: "Judge parse error — defaulting to pass", feedback: "" };
  }

  private async _reviewAndMaybeRetry(
    userMessage: string,
    responseText: string,
    completedTools: ToolCallRecord[],
    fileWrites: FileWrite[]
  ): Promise<boolean> {
    const toolInfos = this._toToolCallInfos(completedTools);
    const review: ReviewResult = reviewCompletion({
      userMessage,
      responseText,
      toolCalls: toolInfos,
      fileWrites,
    });

    if (review.verdict === "pass") {
      this._reviewRound = 0;
      return true;
    }

    const judgeResult = await this._runLLMJudge(
      userMessage, responseText, toolInfos, fileWrites, review.flags
    );

    if (judgeResult.verdict === "PASS") {
      this._reviewRound = 0;
      return true;
    }

    this._reviewRound++;
    if (this._reviewRound >= MAX_REVIEW_ROUNDS) {
      this._reviewRound = 0;
      const failedDetails = review.flags.map(f => `• ${f.detail}`).join("\n");
      this._post({
        type: "error",
        text: `Review detected unresolved issues:\n${failedDetails}`,
        errorType: "warning",
      });
      return true;
    }

    const feedback = buildEscalatingFeedback(
      this._reviewRound,
      review.flags,
      judgeResult.feedback
    );

    this._handleMessage({
      type: "send",
      message: feedback,
      model: "",
    });
    return false;
  }

  private _savePartialProgress(tools: ToolCallRecord[], errorText: string): void {
    if (tools.length > 0) {
      const summary = tools.map(t => `- ${t.label} \u2713`).join("\n");
      const partialMsg: ChatMessage = {
        role: "assistant",
        text: `Completed steps before the error:\n${summary}`,
        ts: Date.now(),
      };
      this._chat.messages.push(partialMsg);
    }
    const errorMsg: ChatMessage = {
      role: "error",
      text: errorText,
      ts: Date.now(),
    };
    this._chat.messages.push(errorMsg);
    saveChat(this._chat);
  }

  private _maybeCompressInBackground(): void {
    if (this._compressing) { return; }
    const all = this._chat.messages.filter(m => m.role !== "error");
    if (all.length <= RECENT_TURNS_KEEP) { return; }

    const older = all.slice(0, -RECENT_TURNS_KEEP);
    if (this._summarizedCount >= older.length) { return; }

    const olderChars = older.reduce((n, m) => n + m.text.length, 0);
    if (olderChars < COMPRESS_THRESHOLD) { return; }

    const totalChars = all.reduce((n, m) => n + m.text.length, 0);
    if (this._historySummary && totalChars < HISTORY_CHAR_BUDGET) { return; }

    this._compressing = true;
    const olderForSummary = older;
    const existingSummary = this._historySummary;
    const countToSummarize = older.length;

    const doCompress = async () => {
      try {
        const proc = await this._ensureProcess();
        let block = "";
        if (existingSummary) {
          block += `[Previous summary]\n${existingSummary}\n\n`;
        }
        block += olderForSummary
          .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${this._messageTextForHistory(m)}`)
          .join("\n\n");

        const summaryPrompt =
          "Summarize the following conversation history into a concise summary " +
          "that preserves all key decisions, requests, code changes, file paths, " +
          "and context needed for continuing the conversation. " +
          "Keep it under 500 words.\n\n" +
          block;

        const resp = await proc.send(summaryPrompt);
        if (resp.type === "response" && resp.text) {
          this._historySummary = `[Summary of earlier conversation]\n${resp.text.trim()}`;
          this._summarizedCount = countToSummarize;
        }
      } catch {
        // Compression failed; next request uses raw history
      } finally {
        this._compressing = false;
      }
    };

    doCompress();
  }

  // ── Process lifecycle ──────────────────────────────────────────────────────

  private async _ensureProcess(): Promise<LamiaProcess> {
    if (this._process) return this._process;

    const cliPath = await LamiaProcess.resolveCliPath();

    ensureGlobalConfig();
    ensureChatConfig();
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
    const cwd = LamiaProcess.resolveWorkingDirForFile(activeFile);
    const logFile = LamiaProcess.resolveLogFile();
    const configPath = getChatConfigPath();

    this._process = new LamiaProcess(cliPath, cwd, logFile, configPath);
    return this._process;
  }

  switchProjectIfNeeded(filePath: string): void {
    if (!this._process) return;
    const newCwd = LamiaProcess.resolveWorkingDirForFile(filePath);
    if (newCwd !== this._process.cwd) {
      this._process.restart(newCwd);
    }
  }

  // ── Message handling ───────────────────────────────────────────────────────

  private async _handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        await this._sendInit();
        break;

      case "command": {
        if (message.command) vscode.commands.executeCommand(message.command);
        break;
      }

      case "openExternal": {
        vscode.env.openExternal(vscode.Uri.parse(message.url));
        break;
      }

      case "changeModel": {
        writeSelectedModel(message.model);
        if (this._process) {
          this._process.restart();
        }
        break;
      }

      case "saveApiKey": {
        setApiKey(message.provider, message.key);
        if (this._process) {
          this._process.restart();
        }
        await this._sendInit();
        validateApiKey(message.provider, message.key).then((result) => {
          this._post({
            type: "apiKeyValidation",
            provider: message.provider,
            valid: result.valid,
            error: result.valid ? undefined : result.error,
          });
        });
        break;
      }

      case "newChat": {
        this._chat = newChat();
        this._historySummary = null;
        this._summarizedCount = 0;
        await this._sendInit();
        break;
      }

      case "loadChat": {
        const loaded = loadChat(message.id);
        if (loaded) {
          this._chat = loaded;
          this._historySummary = null;
          this._summarizedCount = 0;
          await this._sendInit();
        }
        break;
      }

      case "deleteChat": {
        deleteChat(message.id);
        if (this._chat.id === message.id) {
          this._chat = newChat();
          this._historySummary = null;
          this._summarizedCount = 0;
          await this._sendInit();
        }
        this._sendChatList();
        break;
      }

      case "listChats": {
        this._sendChatList();
        break;
      }

      case "getMcpServers": {
        const servers = this._mcpManager?.getServerList() ?? [];
        this._post({ type: "mcpServers", servers });
        break;
      }

      case "saveMcpServer": {
        if (!this._mcpManager) break;
        try {
          const config = JSON.parse(message.config);
          if (!config || typeof config !== "object") {
            throw new Error("Config must be a JSON object");
          }
          const hasCommand = typeof config.command === "string" && config.command.trim();
          const hasUrl = typeof config.url === "string" && config.url.trim();
          if (!hasCommand && !hasUrl) {
            throw new Error("Config must have either a 'command' (stdio) or 'url' (HTTP) field");
          }
          if (config.args && !Array.isArray(config.args)) {
            throw new Error("'args' must be an array of strings");
          }
          this._post({ type: "mcpActionResult", ok: true, message: "Starting..." });
          await this._mcpManager.saveServer(message.name, config, message.oldName);
          await this._mcpManager.reload((serverName, step) => {
            this._post({ type: "mcpActionResult", ok: true, message: `${serverName}: ${step}` });
          });
          this._post({ type: "mcpServers", servers: this._mcpManager.getServerList() });
          const servers = this._mcpManager.getServerList();
          const thisServer = servers.find(s => s.name === message.name.trim());
          if (thisServer && !thisServer.connected && thisServer.lastError) {
            this._post({ type: "mcpActionResult", ok: false, message: thisServer.lastError, final: true });
          } else {
            this._post({ type: "mcpActionResult", ok: true, final: true, message: thisServer?.connected
              ? `${message.name}: running (${thisServer.toolCount} tools)`
              : "MCP server saved." });
          }
        } catch (err: any) {
          const errorText = err.message.startsWith("Config must")
            ? err.message
            : `Failed: ${err.message}`;
          this._post({ type: "mcpActionResult", ok: false, message: errorText, final: true });
        }
        break;
      }

      case "deleteMcpServer": {
        if (!this._mcpManager) break;
        await this._mcpManager.deleteServer(message.name);
        this._post({ type: "mcpServers", servers: this._mcpManager.getServerList() });
        this._post({ type: "mcpActionResult", ok: true, message: "MCP server removed.", final: true });
        break;
      }

      case "toggleMcpServer": {
        if (!this._mcpManager) break;
        await this._mcpManager.toggleServer(message.name, message.enabled);
        await this._mcpManager.reload((serverName, step) => {
          this._post({ type: "mcpActionResult", ok: true, message: `${serverName}: ${step}` });
        });
        this._post({ type: "mcpServers", servers: this._mcpManager.getServerList() });
        this._post({
          type: "mcpActionResult",
          ok: true,
          final: true,
          message: message.enabled ? "MCP server enabled." : "MCP server disabled.",
        });
        break;
      }

      case "send": {
        this._generating = true;
        this._post({ type: "thinking", active: true });
        const completedTools: ToolCallRecord[] = [];
        try {
          // Keep backend config in sync with the model used for this turn.
          if (message.model) {
            const selected = readSelectedModel();
            if (selected !== message.model) {
              writeSelectedModel(message.model);
              if (this._process) {
                this._process.restart();
              }
            }
          }

          const proc = await this._ensureProcess();

          const userMsg: ChatMessage = {
            role: "user",
            text: message.message,
            ts: Date.now(),
          };
          this._chat.messages.push(userMsg);
          saveChat(this._chat);

          const files = message.files && message.files.length > 0 ? message.files : undefined;
          const snippetPrefix = buildSnippetPrefix(message.snippets);
          const fileContextPrefix = buildFileContextPrefix(files);
          let llmMessage = message.message;
          if (fileContextPrefix) llmMessage = `${fileContextPrefix}\n\n${llmMessage}`;
          if (snippetPrefix) llmMessage = `${snippetPrefix}\n\n${llmMessage}`;

          const history = this._buildHistoryForLLM();

          const mcpToolsHint = this._mcpManager?.getToolDefinitionsForPrompt() || "";
          const systemHint = mcpToolsHint
            ? SYSTEM_HINT + "\n\n" + mcpToolsHint
            : SYSTEM_HINT;
          const response = await proc.send(llmMessage, {
            system: systemHint,
            files,
            messages: history,
            onToolUse: (tool, args, label) => {
              const displayLabel = label || tool.replace(/_/g, " ");
              completedTools.push({ tool, label: displayLabel, args, ts: Date.now() });
              this._post({
                type: "toolProgress",
                tool,
                label: displayLabel,
              });
            },
            onToolResult: (tool, success, error) => {
              for (let i = completedTools.length - 1; i >= 0; i--) {
                if (completedTools[i].tool === tool && completedTools[i].success === undefined) {
                  completedTools[i].success = success;
                  if (error) completedTools[i].error = error;
                  break;
                }
              }
              this._post({ type: "toolResult", tool, success, error });
            },
          });

          const mcpRetried = await this._retryFailedToolsViaMcp(response, completedTools, proc, systemHint, files, history);
          if (mcpRetried) {
            Object.assign(response, mcpRetried.response);
            completedTools.push(...mcpRetried.extraTools);
          }

          if (response.type === "response" && response.text) {
            const dedupedFiles = response.files ? deduplicateFileWrites(response.files) : undefined;
            const accepted = await this._reviewAndMaybeRetry(
              message.message,
              response.text,
              completedTools,
              dedupedFiles || []
            );
            if (accepted) {
              const responseTs = Date.now();
              const fileWriteTs = responseTs + 1;
              const safeResponseText = this._sanitizeAssistantResponse(response.text);
              const assistantMsg: ChatMessage = {
                role: "assistant",
                text: safeResponseText,
                model: response.model,
                tokens: response.tokens,
                turnContext: {
                  toolCalls: completedTools.map(t => ({
                    tool: t.tool,
                    label: t.label,
                    args: t.args,
                    success: t.success,
                    error: t.error,
                    ts: t.ts,
                  })),
                  responseTs,
                  fileWrites: dedupedFiles?.map((f, i) => ({
                    path: f.path,
                    action: f.action,
                    content: f.content,
                    original: f.original,
                    ts: fileWriteTs + i,
                  })),
                },
                ts: responseTs,
              };
              this._chat.messages.push(assistantMsg);
              saveChat(this._chat);
              this._post({ type: "response", text: safeResponseText, model: response.model, tokens: response.tokens });

              this._maybeCompressInBackground();

              if (dedupedFiles && dedupedFiles.length > 0) {
                this._post({
                  type: "fileChanges",
                  files: dedupedFiles.map(f => ({
                    path: f.path,
                    action: f.action,
                    original: f.original,
                  })),
                });
                this._lastFileWrites = dedupedFiles;
              }
            }
          } else if (response.type === "error") {
            this._savePartialProgress(completedTools, response.message || "Unknown error");
            this._post({
              type: "error",
              text: response.message || "Unknown error",
              errorType: response.error_type,
            });
          }
        } catch (err: any) {
          if (err.message === "Aborted") {
            // User stopped generation - nothing to report
          } else if (err instanceof NoPythonError) {
            this._post({
              type: "error",
              text: "Python 3.10+ is not installed. The chat and code execution require Python. "
                + "Please install Python and restart the IDE.",
            });
          } else {
            this._savePartialProgress(completedTools, err.message);
            this._post({ type: "error", text: err.message });
          }
        } finally {
          this._generating = false;
          this._post({ type: "thinking", active: false });
        }
        break;
      }

      case "retry": {
        const lastUser = [...this._chat.messages].reverse().find(m => m.role === "user");
        if (!lastUser) break;

        const msgs = this._chat.messages;
        const hasPartialProgress = msgs.length >= 2
          && msgs[msgs.length - 1].role === "error"
          && msgs[msgs.length - 2].role === "assistant"
          && msgs[msgs.length - 2].text.startsWith("Completed steps before the error:");

        if (hasPartialProgress) {
          this._handleMessage({
            type: "send",
            message: "Continue from where you left off. Do not repeat the steps that already succeeded.",
            model: "",
          });
        } else {
          this._post({ type: "populateInput", text: lastUser.text });
        }
        break;
      }

      case "stop": {
        if (this._generating) {
          this._generating = false;
          this._post({ type: "thinking", active: false });
          if (this._process) {
            this._process.abort();
          }
          this._post({ type: "stopped" });
          const lastUser = [...this._chat.messages].reverse().find(m => m.role === "user");
          if (lastUser) {
            this._post({ type: "populateInput", text: lastUser.text });
          }
        }
        break;
      }

      case "getFiles": {
        const files = filterFiles(message.query).slice(0, 50).map(f => ({
          name: f.name,
          relativePath: f.relativePath,
          absolutePath: f.absolutePath,
        }));
        this._post({ type: "fileList", files });
        break;
      }

      case "getClipboardContext": {
        const snippet = getLastCopied();
        clearLastCopied();
        this._post({ type: "clipboardContext", snippet: snippet ?? null });
        break;
      }

      case "insertSnippet": {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage("Open a .lm file to insert a snippet");
          return;
        }
        editor.insertSnippet(new vscode.SnippetString((message as any).code));
        break;
      }

      case "dropFile": {
        const dropUri = message.uri;
        let fsPath = "";
        try {
          fsPath = vscode.Uri.parse(dropUri).fsPath;
        } catch {
          // plain path (not a URI)
          fsPath = dropUri;
        }
        if (fsPath) {
          const path = await import("path");
          const normalizedDrop = path.normalize(fsPath);
          const projectFiles = filterFiles("");
          const existing = projectFiles.find(
            (f) => path.normalize(f.absolutePath) === normalizedDrop
          );
          if (existing) {
            this._post({ type: "addFile", file: existing });
            break;
          }

          const folders = vscode.workspace.workspaceFolders;
          const root = folders?.[0]?.uri.fsPath || "";
          const rel = root ? path.relative(root, fsPath) : path.basename(fsPath);
          this._post({
            type: "addFile",
            file: {
              name: path.basename(fsPath),
              relativePath: rel,
              absolutePath: fsPath,
            },
          });
        }
        break;
      }

      case "openFile": {
        const uri = vscode.Uri.file(message.path);
        vscode.commands.executeCommand("vscode.open", uri);
        break;
      }

      case "openDiff": {
        const filePath = message.path;
        const original = message.original;
        const fs = await import("fs");
        const os = await import("os");
        const path = await import("path");

        const tmpFile = path.join(
          os.tmpdir(),
          `lamia-orig-${Date.now()}-${path.basename(filePath)}`
        );
        fs.writeFileSync(tmpFile, original, "utf8");

        const origUri = vscode.Uri.file(tmpFile);
        const modUri = vscode.Uri.file(filePath);
        const title = `${path.basename(filePath)} (before \u2194 after)`;
        vscode.commands.executeCommand("vscode.diff", origUri, modUri, title);
        break;
      }
    }
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  private async _sendInit(): Promise<void> {
    ensureChatConfig();
    const configuredProviders = getConfiguredProviders();
    const { chain, providerModels } = readAllProviderModels();
    const runtimeModels = await fetchRuntimeProviderModels(getChatConfigPath());
    const mergedProviderModels: Record<string, string[]> = {};
    for (const source of [runtimeModels, providerModels]) {
      for (const [provider, models] of Object.entries(source)) {
        if (!mergedProviderModels[provider]) {
          mergedProviderModels[provider] = [];
        }
        for (const model of models) {
          if (!mergedProviderModels[provider].includes(model)) {
            mergedProviderModels[provider].push(model);
          }
        }
      }
    }
    const fallback = await fetchFallbackModels();
    const dropdown = buildModelDropdown(chain, mergedProviderModels, fallback, configuredProviders);

    const selectedModel = readSelectedModel();

    const keyInfos: Record<string, { source: string; masked: string }> = {};
    for (const p of configuredProviders) {
      const info = getApiKeyInfo(p);
      if (info) keyInfos[p] = { source: info.sourceLabel, masked: info.masked };
    }

    this._post({
      type: "init",
      models: dropdown.defaultModels,
      allModels: dropdown.allModels,
      configuredProviders,
      keyInfos,
      selectedModel,
      messages: this._chat.messages.map(m => (
        m.role === "assistant" ? { ...m, text: this._sanitizeAssistantResponse(m.text) } : m
      )),
      chatTitle: this._chat.title,
    });
  }

  private async _refreshModels(): Promise<void> {
    if (!this._view) return;
    ensureChatConfig();
    const configuredProviders = getConfiguredProviders();
    const { chain, providerModels } = readAllProviderModels();
    const runtimeModels = await fetchRuntimeProviderModels(getChatConfigPath());
    const mergedProviderModels: Record<string, string[]> = {};
    for (const source of [runtimeModels, providerModels]) {
      for (const [provider, models] of Object.entries(source)) {
        if (!mergedProviderModels[provider]) {
          mergedProviderModels[provider] = [];
        }
        for (const model of models) {
          if (!mergedProviderModels[provider].includes(model)) {
            mergedProviderModels[provider].push(model);
          }
        }
      }
    }
    const fallback = await fetchFallbackModels();
    const dropdown = buildModelDropdown(chain, mergedProviderModels, fallback, configuredProviders);
    const keyInfos: Record<string, { source: string; masked: string }> = {};
    for (const p of configuredProviders) {
      const info = getApiKeyInfo(p);
      if (info) keyInfos[p] = { source: info.sourceLabel, masked: info.masked };
    }
    this._post({
      type: "updateModels",
      models: dropdown.defaultModels,
      allModels: dropdown.allModels,
      configuredProviders,
      keyInfos,
    });
  }

  private _sendChatList(): void {
    this._post({
      type: "chatList",
      chats: listChats(),
      currentId: this._chat.id,
    });
  }

  private _post(msg: HostMessage): void {
    this._view?.webview.postMessage(msg);
  }


  // ── Webview HTML ───────────────────────────────────────────────────────────

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, "media", "webview.js")
    );

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src ${webview.cspSource}; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lamia Chat</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    .hidden { display: none !important; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    body.settings-mode #chat-history-panel,
    body.settings-mode #chat-messages,
    body.settings-mode #input-area {
      display: none;
    }
    body.history-mode #setup-panel,
    body.history-mode #chat-messages,
    body.history-mode #input-area {
      display: none;
    }

    /* ── Header bar ────────────────────────────────────────────────────── */
    #header-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-panel-border, #444);
      flex-shrink: 0;
    }
    #header-bar label { font-size: 11px; opacity: 0.7; white-space: nowrap; }

    #model-select {
      flex: 1; min-width: 0;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 3px; padding: 3px 6px;
      font-size: 12px; font-family: inherit; outline: none;
    }
    #model-select:focus { border-color: var(--vscode-focusBorder); }

    .icon-btn {
      background: none; border: none;
      color: var(--vscode-foreground);
      cursor: pointer; opacity: 0.6;
      font-size: 14px; padding: 2px 4px;
      border-radius: 3px; flex-shrink: 0;
    }
    .icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
    .icon-btn.active { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }

    /* ── Setup panel ───────────────────────────────────────────────────── */
    #setup-panel {
      padding: 12px;
      border-bottom: 1px solid var(--vscode-panel-border, #444);
      flex-shrink: 0;
    }
    #setup-panel.hidden { display: none; }
    body.settings-mode #setup-panel {
      display: block;
      flex: 1;
      overflow-y: auto;
      border-bottom: none;
    }
    #setup-panel h3 { font-size: 12px; margin-bottom: 8px; }
    .setup-row { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
    .setup-row label { font-size: 11px; opacity: 0.7; }
    .setup-row select, .setup-row input {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 3px; padding: 5px 8px;
      font-size: 12px; font-family: inherit; outline: none;
    }
    .setup-row select:focus, .setup-row input:focus {
      border-color: var(--vscode-focusBorder);
    }
    #save-key-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; border-radius: 4px;
      padding: 5px 14px; font-size: 12px;
      font-family: inherit; cursor: pointer;
    }
    #save-key-btn:hover { background: var(--vscode-button-hoverBackground); }
    .setup-status { font-size: 11px; opacity: 0.6; margin-top: 4px; }
    .setup-status .configured { color: var(--vscode-charts-green, #4ec); }
    .setup-status .key-invalid { color: var(--vscode-errorForeground, #f44); }

    /* ── MCP settings ────────────────────────────────────────────────── */
    .mcp-item {
      display: flex; align-items: center; gap: 6px;
      padding: 5px 6px; margin-bottom: 2px;
      border-radius: 3px; font-size: 12px;
      cursor: pointer;
    }
    .mcp-item:hover { background: var(--vscode-list-hoverBackground); }
    .mcp-item input[type="checkbox"] { margin: 0; cursor: pointer; flex-shrink: 0; }
    .mcp-item-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mcp-item-status {
      font-size: 10px; opacity: 0.6; flex-shrink: 0;
    }
    .mcp-item-status.running { color: var(--vscode-charts-green, #4ec); opacity: 1; }
    .mcp-item-status.failed { color: var(--vscode-errorForeground, #f44); opacity: 1; cursor: help; }
    .mcp-tools-list {
      font-size: 10px; opacity: 0.5; padding: 2px 0 4px 28px;
      line-height: 1.5; word-break: break-word;
    }
    .mcp-add-btn {
      width: 100%; padding: 4px; margin-top: 4px;
      background: transparent; color: var(--vscode-textLink-foreground);
      border: 1px dashed var(--vscode-input-border, #555);
      border-radius: 3px; font-size: 11px; cursor: pointer;
      font-family: inherit;
    }
    .mcp-add-btn:hover { background: var(--vscode-list-hoverBackground); }
    .mcp-add-btn:disabled,
    #mcp-save-btn:disabled,
    #mcp-delete-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    #mcp-delete-btn {
      background: transparent;
      color: var(--vscode-errorForeground, #f44);
      border: 1px solid var(--vscode-errorForeground, #f44);
      border-radius: 3px; padding: 4px 10px; font-size: 12px;
      font-family: inherit; cursor: pointer;
    }
    #mcp-config {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 3px; padding: 6px; font-size: 11px;
      font-family: var(--vscode-editor-font-family, monospace);
      resize: vertical; width: 100%; box-sizing: border-box;
    }
    #mcp-name {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 3px; padding: 4px 6px; font-size: 12px;
      font-family: inherit; width: 100%; box-sizing: border-box;
    }
    #mcp-save-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; border-radius: 3px; padding: 4px 10px;
      font-size: 12px; font-family: inherit; cursor: pointer;
    }
    #mcp-save-btn:hover { background: var(--vscode-button-hoverBackground); }
    #mcp-status {
      margin-top: 6px;
      font-size: 11px;
      opacity: 0.75;
      min-height: 16px;
    }
    #mcp-status.error { color: var(--vscode-errorForeground, #f44); }
    #mcp-status.ok { color: var(--vscode-charts-green, #4ec); }

    /* ── Chat history panel ──────────────────────────────────────────── */
    #chat-history-panel {
      border-bottom: 1px solid var(--vscode-panel-border, #444);
      max-height: 50vh; overflow-y: auto; flex-shrink: 0;
    }
    #chat-history-panel.hidden { display: none; }
    body.history-mode #chat-history-panel {
      display: block;
      flex: 1;
      max-height: none;
      overflow-y: auto;
      border-bottom: none;
    }
    .chat-item {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 10px; cursor: pointer; font-size: 12px;
      border-bottom: 1px solid var(--vscode-panel-border, #333);
    }
    .chat-item:hover { background: var(--vscode-list-hoverBackground); }
    .chat-item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .chat-item-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chat-item-date { font-size: 10px; opacity: 0.5; white-space: nowrap; }
    .chat-item-delete {
      background: none; border: none; color: var(--vscode-foreground);
      opacity: 0.3; cursor: pointer; font-size: 12px; padding: 0 2px;
      flex-shrink: 0;
    }
    .chat-item-delete:hover { opacity: 0.9; color: var(--vscode-errorForeground, #f44); }

    /* ── Messages ──────────────────────────────────────────────────────── */
    #chat-messages {
      flex: 1; overflow-y: auto; overflow-x: hidden; padding: 10px 8px;
      display: flex; flex-direction: column; gap: 10px;
    }
    .message { max-width: 100%; word-break: break-word; }
    .message-bubble {
      display: inline-block; padding: 7px 10px;
      border-radius: 8px; line-height: 1.5; font-size: 13px;
      max-width: 100%;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .message.user { text-align: right; }
    .message.user .message-bubble {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
      border-radius: 8px 8px 2px 8px;
    }
    .message.assistant .message-bubble {
      background: var(--vscode-editor-inactiveSelectionBackground, rgba(255,255,255,0.06));
      border-radius: 8px 8px 8px 2px; white-space: pre-wrap;
    }
    .message.error .message-bubble {
      background: var(--vscode-inputValidation-errorBackground, rgba(200,0,0,0.15));
      color: var(--vscode-errorForeground); border-radius: 8px;
      border: 1px solid var(--vscode-inputValidation-errorBorder, #f00);
    }
    .message.error.error-auth .message-bubble {
      background: rgba(200,0,0,0.18);
      border-color: var(--vscode-inputValidation-errorBorder, #f00);
    }
    .message.error.error-warning .message-bubble,
    .message.error.error-rate_limit .message-bubble,
    .message.error.error-timeout .message-bubble,
    .message.error.error-network .message-bubble {
      background: var(--vscode-inputValidation-warningBackground, rgba(200,150,0,0.15));
      border-color: var(--vscode-inputValidation-warningBorder, #fa0);
      color: var(--vscode-editorWarning-foreground, #fa0);
    }
    .error-action-btn {
      display: inline-block; margin-top: 6px; padding: 3px 10px;
      font-size: 11px; border-radius: 3px; cursor: pointer; border: none;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    }
    .error-action-btn:hover { background: var(--vscode-button-hoverBackground); }
    .message-label {
      font-size: 10px; opacity: 0.5; margin-bottom: 3px;
      text-transform: uppercase; letter-spacing: 0.04em;
    }
    .message.user .message-label { text-align: right; }
    .message-meta {
      font-size: 10px; opacity: 0.35; margin-top: 2px;
    }
    .message.user .message-meta { text-align: right; }
    .message.assistant .message-bubble.compact { font-size: 12px; line-height: 1.45; }
    .message.assistant .message-bubble.compact-more { font-size: 11px; line-height: 1.4; }

    /* ── Thinking dots ─────────────────────────────────────────────────── */
    .thinking { display: flex; align-items: center; gap: 4px; padding: 8px 10px; }
    .thinking-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--vscode-foreground); opacity: 0.4;
      animation: bounce 1.2s ease-in-out infinite;
    }
    .thinking-dot:nth-child(2) { animation-delay: 0.2s; }
    .thinking-dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes bounce {
      0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
      30% { transform: translateY(-5px); opacity: 0.9; }
    }

    /* ── Input area ────────────────────────────────────────────────────── */
    #input-area {
      display: flex; flex-direction: column; gap: 6px; padding: 8px;
      border-top: 1px solid var(--vscode-panel-border, #444); flex-shrink: 0;
    }
    #user-input {
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px; padding: 7px 10px;
      font-family: inherit; font-size: 13px;
      resize: none; outline: none; line-height: 1.5;
      min-height: 60px; max-height: 140px;
    }
    #user-input:focus { border-color: var(--vscode-focusBorder); }
    #user-input::placeholder { opacity: 0.5; }
    #input-footer { display: flex; justify-content: space-between; align-items: center; }
    #input-hint { font-size: 10px; opacity: 0.4; }
    #send-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none; border-radius: 4px;
      padding: 5px 14px; font-size: 12px;
      font-family: inherit; cursor: pointer;
    }
    #send-btn:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    #send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    #stop-btn {
      background: var(--vscode-errorForeground, #f44);
      color: #fff;
      border: none; border-radius: 4px;
      padding: 5px 14px; font-size: 12px;
      font-family: inherit; cursor: pointer;
      display: none;
    }
    #stop-btn:hover { opacity: 0.85; }

    /* ── @-mention popup ──────────────────────────────────────────────── */
    #input-wrapper { position: relative; }
    #mention-popup {
      position: absolute; bottom: 100%; left: 0; right: 0;
      max-height: 160px; overflow-y: auto;
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 4px; z-index: 10;
    }
    #mention-popup.hidden { display: none; }
    .mention-item {
      padding: 4px 8px; font-size: 12px; cursor: pointer;
      display: flex; justify-content: space-between;
    }
    .mention-item:hover, .mention-item.active {
      background: var(--vscode-list-hoverBackground);
    }
    .mention-item .path { opacity: 0.5; font-size: 10px; }

    /* ── File chips ───────────────────────────────────────────────────── */
    #file-chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 0 4px 0; }
    #file-chips:empty { display: none; }
    .file-chip {
      display: inline-flex; align-items: center; gap: 4px;
      background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
      border-radius: 3px; padding: 2px 6px; font-size: 11px;
    }
    .file-chip .remove {
      cursor: pointer; opacity: 0.6; font-size: 10px;
    }
    .file-chip .remove:hover { opacity: 1; }
    .snippet-chip {
      display: inline-flex; align-items: center; gap: 4px;
      background: var(--vscode-editorInfo-background, rgba(0,122,204,0.18));
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-focusBorder, rgba(0,122,204,0.4));
      border-radius: 3px; padding: 2px 6px; font-size: 11px;
    }
    .snippet-chip .remove { cursor: pointer; opacity: 0.6; font-size: 10px; }
    .snippet-chip .remove:hover { opacity: 1; }

    /* ── Code block actions ────────────────────────────────────────────── */
    .code-block-wrapper { position: relative; margin: 6px 0; }
    .code-block-wrapper pre {
      margin: 0; padding: 8px; border-radius: 4px;
      background: var(--vscode-textCodeBlock-background);
      overflow-x: auto; font-size: 12px;
    }
    .code-actions {
      position: absolute; top: 4px; right: 4px;
      display: flex; gap: 4px;
    }
    .code-actions button {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none; border-radius: 3px; padding: 2px 8px;
      font-size: 10px; cursor: pointer; opacity: 0.7;
    }
    .code-actions button:hover { opacity: 1; }
    .code-lang-badge {
      position: absolute; top: 4px; left: 8px;
      font-size: 9px; opacity: 0.5; text-transform: uppercase;
      font-family: var(--vscode-editor-font-family);
    }

    /* ── Tool progress ──────────────────────────────────────────────────── */
    .tool-progress {
      display: flex; flex-direction: column; gap: 3px;
      padding: 4px 10px;
    }
    .tool-step {
      display: flex; align-items: baseline; gap: 6px;
      flex-wrap: wrap;
      font-size: 12px; opacity: 0.7; line-height: 1.4;
      min-width: 0;
    }
    .tool-step .ts-label {
      min-width: 0; flex: 1;
      white-space: normal;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .tool-step .ts-spinner {
      width: 12px; height: 12px; flex-shrink: 0;
      border: 1.5px solid var(--vscode-foreground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      opacity: 0.5;
    }
    .tool-step .ts-check {
      flex-shrink: 0; font-size: 12px;
      color: var(--vscode-charts-green, #4ec);
      opacity: 0.7;
    }
    .tool-step .ts-fail {
      flex-shrink: 0; font-size: 12px;
      color: var(--vscode-charts-red, #e44);
      opacity: 0.7;
    }
    .tool-step .ts-error-detail {
      display: block;
      flex-basis: 100%;
      margin-left: 18px;
      font-size: 11px; opacity: 0.7;
      color: var(--vscode-charts-red, #e44);
      white-space: normal;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── File changes ───────────────────────────────────────────────────── */
    .file-changes {
      display: flex; flex-direction: column; gap: 3px;
      padding: 6px 10px;
    }
    .file-change-item {
      display: flex; align-items: center; gap: 6px;
      font-size: 12px; padding: 4px 8px;
      border-radius: 4px;
      background: var(--vscode-editor-inactiveSelectionBackground, rgba(255,255,255,0.04));
    }
    .file-change-item .fc-icon {
      flex-shrink: 0; font-size: 13px; opacity: 0.8;
    }
    .file-change-item .fc-icon.create {
      color: var(--vscode-charts-green, #4ec);
    }
    .file-change-item .fc-icon.modify {
      color: var(--vscode-charts-yellow, #ee0);
    }
    .file-change-item .fc-icon.delete {
      color: var(--vscode-charts-red, #e44);
    }
    .file-change-item .fc-name {
      flex: 1; min-width: 0; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap;
      opacity: 0.85;
    }
    .file-change-item .fc-btn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none; border-radius: 3px;
      padding: 2px 8px; font-size: 10px;
      cursor: pointer; opacity: 0.7; white-space: nowrap;
    }
    .file-change-item .fc-btn:hover { opacity: 1; }

    /* ── Empty state ───────────────────────────────────────────────────── */
    #empty-state {
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; flex: 1; opacity: 0.4;
      text-align: center; padding: 20px; gap: 8px;
    }
    #empty-state .icon { font-size: 32px; }
    #empty-state p { font-size: 12px; line-height: 1.5; }

    /* ── Add Models dialog ─────────────────────────────────────────────── */
    #add-models-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.45);
      z-index: 1000;
      display: flex; align-items: center; justify-content: center;
    }
    #add-models-overlay.hidden { display: none; }
    #add-models-dialog {
      background: var(--vscode-editor-background, #1e1e1e);
      border: 1px solid var(--vscode-panel-border, #444);
      border-radius: 6px;
      width: 90%; max-width: 420px; max-height: 70vh;
      display: flex; flex-direction: column;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    }
    #add-models-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 12px;
      border-bottom: 1px solid var(--vscode-panel-border, #444);
      font-size: 13px; font-weight: 600;
    }
    #add-models-list {
      overflow-y: auto; flex: 1;
      padding: 4px 0;
    }
    .add-model-row {
      padding: 6px 14px;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .add-model-row:hover {
      background: var(--vscode-list-hoverBackground, #2a2d2e);
    }
    .add-model-row.selected {
      background: var(--vscode-list-activeSelectionBackground, #094771);
      color: var(--vscode-list-activeSelectionForeground, #fff);
    }
  </style>
</head>
<body>

  <!-- Header: model selector + settings -->
  <div id="header-bar">
    <label for="model-select">Model:</label>
    <select id="model-select"></select>
    <button class="icon-btn" id="back-to-chat-btn" title="Back to chat" style="display:none;"><svg width="12" height="12" viewBox="0 0 16 16" style="vertical-align:-1px"><path d="M10 2L4 8l6 6" stroke="currentColor" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    <button class="icon-btn" id="new-chat-btn" title="New chat">&#43;</button>
    <button class="icon-btn" id="history-btn" title="Chat history"><svg width="12" height="12" viewBox="0 0 16 16" style="vertical-align:-1px"><circle cx="8" cy="8" r="6.5" stroke="currentColor" fill="none" stroke-width="1.4"/><line x1="8" y1="5" x2="8" y2="8.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="8" y1="8.5" x2="10.5" y2="8.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>
    <button class="icon-btn" id="settings-btn" title="Settings">&#9881;</button>
  </div>

  <!-- Add Models dialog -->
  <div id="add-models-overlay" class="hidden">
    <div id="add-models-dialog">
      <div id="add-models-header">
        <span>All Available Models</span>
        <button class="icon-btn" id="close-models-btn" title="Close">&times;</button>
      </div>
      <div id="add-models-list"></div>
    </div>
  </div>

  <!-- Chat history -->
  <div id="chat-history-panel" class="hidden"></div>

  <!-- API key setup -->
  <div id="setup-panel" class="hidden">
    <h3>Configure API Key</h3>
    <div class="setup-row">
      <label>Provider</label>
      <select id="setup-provider">
        <option value="anthropic">Anthropic</option>
        <option value="openai">OpenAI</option>
      </select>
    </div>
    <div class="setup-row">
      <label>API Key</label>
      <input id="setup-key" type="password" placeholder="sk-..." />
    </div>
    <button id="save-key-btn">Save Key</button>
    <div id="setup-status" class="setup-status"></div>

    <h3 style="margin-top: 16px;">MCP Servers</h3>
    <div id="mcp-list"></div>
    <button id="mcp-add-btn" class="mcp-add-btn">+ Add MCP Server</button>

    <div id="mcp-editor" class="hidden">
      <div class="setup-row">
        <label>Server Name</label>
        <input id="mcp-name" type="text" placeholder="e.g. playwright" />
      </div>
      <div class="setup-row">
        <label>Command <span style="opacity:0.5;font-weight:normal">(npx package or full path)</span></label>
        <input id="mcp-command" type="text" placeholder="npx @playwright/mcp@latest" />
      </div>
      <div class="setup-row hidden" id="mcp-env-row">
        <label>Environment Variables <span style="opacity:0.5;font-weight:normal">(KEY=VALUE per line)</span></label>
        <textarea id="mcp-env" rows="2" placeholder="KEY=value"></textarea>
      </div>
      <div style="margin-top:4px;">
        <a id="mcp-advanced-toggle" href="#" style="font-size:11px;opacity:0.7;">Show advanced (JSON)</a>
      </div>
      <div class="setup-row hidden" id="mcp-json-row">
        <label>Configuration (JSON)</label>
        <textarea id="mcp-config" rows="5" placeholder='{"command":"npx","args":["@playwright/mcp@latest"]}'></textarea>
      </div>
      <div style="display: flex; gap: 6px; margin-top: 4px;">
        <button id="mcp-save-btn">Save</button>
        <button id="mcp-delete-btn" class="hidden">Delete Server</button>
      </div>
    </div>

    <div style="margin-top: 8px; font-size: 11px; opacity: 0.7;">
      <a href="#" id="mcp-docs-link" style="color: var(--vscode-textLink-foreground); text-decoration: none;">MCP Guide</a>
    </div>
    <div id="mcp-status"></div>
  </div>

  <!-- Message history -->
  <div id="chat-messages">
    <div id="empty-state">
      <div class="icon">&#128172;</div>
      <p>Ask anything. Lamia syntax help is automatic<br>when your question is about Lamia.</p>
    </div>
  </div>

  <!-- Input -->
  <div id="input-area">
    <div id="file-chips"></div>
    <div id="input-wrapper">
      <textarea id="user-input" rows="3" placeholder="Ask anything... @ to reference files or Shift+drag and drop files (Enter to send, Shift+Enter newline)"></textarea>
      <div id="mention-popup" class="hidden"></div>
    </div>
    <div id="input-footer">
      <span id="input-hint">Shift+Enter newline &middot; @ to attach files</span>
      <button id="stop-btn">Stop &#9632;</button>
      <button id="send-btn">Send &#8594;</button>
    </div>
  </div>

  <script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
