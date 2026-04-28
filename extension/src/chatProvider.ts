import * as vscode from "vscode";
import { LamiaProcess, FileWrite } from "./lamiaProcess";
import { setApiKey, getConfiguredProviders } from "./envHelper";
import {
  readAllProviderModels,
  fetchFallbackModels,
  buildModelDropdown,
  ensureGlobalConfig,
  ModelList,
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
  | { type: "dropFile"; uri: string };

type HostMessage =
  | { type: "response"; text: string; model?: string; tokens?: { input: number; output: number } }
  | { type: "clipboardContext"; snippet: CopiedSnippet | null }
  | { type: "error"; text: string }
  | { type: "thinking"; active: boolean }
  | { type: "toolProgress"; tool: string; label: string }
  | { type: "toolResult"; tool: string; success: boolean; error?: string }
  | { type: "fileChanges"; files: { path: string; action: string; original?: string }[] }
  | { type: "populateInput"; text: string }
  | { type: "stopped" }
  | { type: "addFile"; file: { name: string; relativePath: string; absolutePath: string } }
  | {
      type: "init";
      models: { value: string; label: string }[];
      configuredProviders: string[];
      selectedModel: string | null;
      messages: ChatMessage[];
      chatTitle: string;
    }
  | {
      type: "fileList";
      files: { name: string; relativePath: string; absolutePath: string }[];
    }
  | {
      type: "chatList";
      chats: { id: string; title: string; updated: number }[];
      currentId: string;
    };


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
  "Use your browser tools for web testing and automation when the user asks to test, verify, or interact with web pages.";

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

// ── Helpers ──────────────────────────────────────────────────────────────────

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let r = "";
  for (let i = 0; i < 32; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return r;
}

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

  constructor(private readonly _context: vscode.ExtensionContext) {
    this._chat = loadLatestChat() || newChat();
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };

    webviewView.webview.html = this._getHtmlForWebview();

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
    if (message.role !== "assistant" || !message.turnContext) {
      return message.text;
    }

    const hasToolCalls = Array.isArray(message.turnContext.toolCalls) && message.turnContext.toolCalls.length > 0;
    const hasFileWrites = Array.isArray(message.turnContext.fileWrites) && message.turnContext.fileWrites.length > 0;
    if (!hasToolCalls && !hasFileWrites) {
      return message.text;
    }

    const contextJson = JSON.stringify(message.turnContext, null, 2);
    return `${message.text}\n\n<turn_context_json>\n${contextJson}\n</turn_context_json>`;
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
          const llmMessage = snippetPrefix ? `${snippetPrefix}\n\n${message.message}` : message.message;

          const history = this._buildHistoryForLLM();

          const response = await proc.send(llmMessage, {
            system: SYSTEM_HINT,
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

          if (response.type === "response" && response.text) {
            const responseTs = Date.now();
            const fileWriteTs = responseTs + 1;
            const assistantMsg: ChatMessage = {
              role: "assistant",
              text: response.text,
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
                fileWrites: response.files?.map((f, i) => ({
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
            this._post({ type: "response", text: response.text, model: response.model, tokens: response.tokens });

            this._maybeCompressInBackground();

            if (response.files && response.files.length > 0) {
              this._post({
                type: "fileChanges",
                files: response.files.map(f => ({
                  path: f.path,
                  action: f.action,
                  original: f.original,
                })),
              });
              this._lastFileWrites = response.files;
            }
          } else if (response.type === "error") {
            this._savePartialProgress(completedTools, response.message || "Unknown error");
            this._post({ type: "error", text: response.message || "Unknown error" });
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
    const configuredProviders = getConfiguredProviders();
    const { chain, providerModels } = readAllProviderModels();
    const fallback = await fetchFallbackModels();
    const models = buildModelDropdown(chain, providerModels, fallback, configuredProviders);

    const selectedModel = readSelectedModel();

    this._post({
      type: "init",
      models,
      configuredProviders,
      selectedModel,
      messages: this._chat.messages,
      chatTitle: this._chat.title,
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

  private _getHtmlForWebview(): string {
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lamia Chat</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

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

    /* ── Setup panel ───────────────────────────────────────────────────── */
    #setup-panel {
      padding: 12px;
      border-bottom: 1px solid var(--vscode-panel-border, #444);
      flex-shrink: 0;
    }
    #setup-panel.hidden { display: none; }
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

    /* ── Chat history panel ──────────────────────────────────────────── */
    #chat-history-panel {
      border-bottom: 1px solid var(--vscode-panel-border, #444);
      max-height: 50vh; overflow-y: auto; flex-shrink: 0;
    }
    #chat-history-panel.hidden { display: none; }
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

    /* ── Tool progress ──────────────────────────────────────────────────── */
    .tool-progress {
      display: flex; flex-direction: column; gap: 3px;
      padding: 4px 10px;
    }
    .tool-step {
      display: flex; align-items: center; gap: 6px;
      font-size: 12px; opacity: 0.7; line-height: 1.4;
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
      font-size: 11px; opacity: 0.6;
      color: var(--vscode-charts-red, #e44);
      margin-left: 2px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      max-width: 260px;
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
  </style>
</head>
<body>

  <!-- Header: model selector + settings -->
  <div id="header-bar">
    <label for="model-select">Model:</label>
    <select id="model-select"></select>
    <button class="icon-btn" id="new-chat-btn" title="New chat">&#43;</button>
    <button class="icon-btn" id="history-btn" title="Chat history"><svg width="12" height="12" viewBox="0 0 16 16" style="vertical-align:-1px"><circle cx="8" cy="8" r="6.5" stroke="currentColor" fill="none" stroke-width="1.4"/><line x1="8" y1="5" x2="8" y2="8.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><line x1="8" y1="8.5" x2="10.5" y2="8.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>
    <button class="icon-btn" id="settings-btn" title="API key settings">&#9881;</button>
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

  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();

    let allModels = [];
    let configuredProviders = [];

    function formatMeta(model, tokens) {
      let meta = "";
      if (model) meta += model;
      if (tokens) {
        meta += (meta ? " | " : "") + (tokens.input || 0).toLocaleString() + " in / " + (tokens.output || 0).toLocaleString() + " out tokens";
      }
      return meta;
    }

    // ── Setup / Settings ────────────────────────────────────────────────── 

    function toggleSetup() {
      const panel = document.getElementById("setup-panel");
      panel.classList.toggle("hidden");
      updateSetupStatus();
    }

    function onProviderChange() {
      document.getElementById("setup-key").value = "";
      updateSetupStatus();
    }

    function updateSetupStatus() {
      const el = document.getElementById("setup-status");
      const lines = [];
      if (configuredProviders.includes("anthropic")) {
        lines.push('<span class="configured">Anthropic: configured</span>');
      }
      if (configuredProviders.includes("openai")) {
        lines.push('<span class="configured">OpenAI: configured</span>');
      }
      if (lines.length === 0) {
        lines.push("No API keys configured yet.");
      }
      el.innerHTML = lines.join(" &nbsp;|&nbsp; ");
    }

    function saveApiKey() {
      const provider = document.getElementById("setup-provider").value;
      const key = document.getElementById("setup-key").value.trim();
      if (!key) return;
      vscodeApi.postMessage({ type: "saveApiKey", provider, key });
      document.getElementById("setup-key").value = "";
    }

    // ── Model dropdown ────────────────────────────────────────────────────

    function populateModels(serverSelectedModel) {
      const sel = document.getElementById("model-select");
      const prev = serverSelectedModel || sel.value || (vscodeApi.getState() || {}).selectedModel || "";
      sel.innerHTML = "";

      let hasOptions = false;
      for (const m of allModels) {
        const opt = document.createElement("option");
        opt.value = m.value;
        opt.textContent = m.label;
        if (opt.value === prev) opt.selected = true;
        sel.appendChild(opt);
        hasOptions = true;
      }

      if (!hasOptions) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "-- set an API key first --";
        opt.disabled = true;
        sel.appendChild(opt);
      }
    }

    // ── Messages ──────────────────────────────────────────────────────────

    let thinkingEl = null;

    function hideEmptyState() {
      const es = document.getElementById("empty-state");
      if (es) es.remove();
    }

    function appendMessage(role, text, meta) {
      hideEmptyState();
      removeThinking();

      const container = document.getElementById("chat-messages");
      const wrapper = document.createElement("div");
      wrapper.className = "message " + role;

      const label = document.createElement("div");
      label.className = "message-label";
      label.textContent = role === "user" ? "You" : role === "error" ? "Error" : "Assistant";
      wrapper.appendChild(label);

      const bubble = document.createElement("div");
      bubble.className = "message-bubble";
      bubble.textContent = text;
      if (role === "assistant" && text.length > 3500) {
        bubble.classList.add("compact-more");
      } else if (role === "assistant" && text.length > 1800) {
        bubble.classList.add("compact");
      }
      wrapper.appendChild(bubble);

      if (meta) {
        const metaEl = document.createElement("div");
        metaEl.className = "message-meta";
        metaEl.textContent = meta;
        wrapper.appendChild(metaEl);
      }

      container.appendChild(wrapper);
      container.scrollTop = container.scrollHeight;
      return wrapper;
    }

    var isGenerating = false;

    function setGenerating(on) {
      isGenerating = on;
      document.getElementById("send-btn").style.display = on ? "none" : "";
      document.getElementById("stop-btn").style.display = on ? "inline-block" : "none";
    }

    function showThinking() {
      hideEmptyState();
      removeThinking();
      const container = document.getElementById("chat-messages");
      thinkingEl = document.createElement("div");
      thinkingEl.className = "thinking";
      for (let i = 0; i < 3; i++) {
        const dot = document.createElement("span");
        dot.className = "thinking-dot";
        thinkingEl.appendChild(dot);
      }
      container.appendChild(thinkingEl);
      container.scrollTop = container.scrollHeight;
      setGenerating(true);
    }

    function removeThinking() {
      if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
    }

    function clearMessages() {
      const container = document.getElementById("chat-messages");
      container.innerHTML = '<div id="empty-state"><div class="icon">&#128172;</div><p>Ask anything. Lamia syntax help is automatic<br>when your question is about Lamia.</p></div>';
    }

    function restoreMessages(messages) {
      if (!messages || messages.length === 0) return;
      for (const msg of messages) {
        if (msg.role !== "assistant" || !msg.turnContext) {
          const meta = formatMeta(msg.model, msg.tokens);
          appendMessage(msg.role, msg.text, meta || undefined);
          continue;
        }
        var tc = msg.turnContext;
        var items = [];
        if (Array.isArray(tc.toolCalls)) {
          tc.toolCalls.forEach(function(t) {
            items.push({ kind: "tool", data: t, ts: t.ts || 0 });
          });
        }
        items.push({ kind: "response", data: msg, ts: tc.responseTs || msg.ts || 0 });
        if (Array.isArray(tc.fileWrites)) {
          tc.fileWrites.forEach(function(f) {
            items.push({ kind: "file", data: f, ts: f.ts || 0 });
          });
        }
        items.sort(function(a, b) { return a.ts - b.ts; });
        var toolBatch = [];
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          if (it.kind === "tool") {
            toolBatch.push(it.data);
          } else {
            if (toolBatch.length > 0) {
              renderCompletedToolCalls(toolBatch);
              toolBatch = [];
            }
            if (it.kind === "response") {
              var meta = formatMeta(msg.model, msg.tokens);
              appendMessage(msg.role, msg.text, meta || undefined);
            } else if (it.kind === "file") {
              renderFileChanges([it.data]);
            }
          }
        }
        if (toolBatch.length > 0) {
          renderCompletedToolCalls(toolBatch);
        }
      }
    }

    // ── Tool progress ──────────────────────────────────────────────────────

    let toolProgressEl = null;

    function escapeHtml(s) {
      const text = String(s ?? "");
      return text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    }

    function addToolProgress(label) {
      hideEmptyState();
      removeThinking();

      const container = document.getElementById("chat-messages");

      if (!toolProgressEl) {
        toolProgressEl = document.createElement("div");
        toolProgressEl.className = "tool-progress";
        container.appendChild(toolProgressEl);
      }

      // If a previous spinner is still active (tool_result not received), mark it done
      toolProgressEl.querySelectorAll(".ts-spinner").forEach(function(s) {
        var icon = document.createElement("span");
        icon.className = "ts-check";
        icon.textContent = "\\u2713";
        s.replaceWith(icon);
      });

      const step = document.createElement("div");
      step.className = "tool-step";
      step.innerHTML = '<span class="ts-spinner"></span><span>' + escapeHtml(label) + '</span>';
      toolProgressEl.appendChild(step);
      container.scrollTop = container.scrollHeight;
    }

    function markLastToolResult(success, error) {
      if (!toolProgressEl) return;
      var spinners = toolProgressEl.querySelectorAll(".ts-spinner");
      if (spinners.length === 0) return;
      var last = spinners[spinners.length - 1];
      var icon = document.createElement("span");
      icon.className = success ? "ts-check" : "ts-fail";
      icon.textContent = success ? "\\u2713" : "\\u2717";
      last.replaceWith(icon);
      if (!success && error) {
        var step = icon.closest(".tool-step");
        if (step) {
          var errEl = document.createElement("span");
          errEl.className = "ts-error-detail";
          errEl.textContent = error;
          step.appendChild(errEl);
        }
      }
    }

    function completeToolProgress() {
      if (!toolProgressEl) return;
      toolProgressEl.querySelectorAll(".ts-spinner").forEach(function(s) {
        var icon = document.createElement("span");
        icon.className = "ts-check";
        icon.textContent = "\\u2713";
        s.replaceWith(icon);
      });
      toolProgressEl = null;
    }

    function renderCompletedToolCalls(toolCalls) {
      const container = document.getElementById("chat-messages");
      const wrapper = document.createElement("div");
      wrapper.className = "tool-progress";
      toolCalls.forEach(function(t) {
        const step = document.createElement("div");
        step.className = "tool-step";
        const label = t && t.label ? t.label : (t && t.tool ? "Using tool: " + t.tool : "Using tool");
        var ok = t.success !== false;
        var cls = ok ? "ts-check" : "ts-fail";
        var sym = ok ? "\\u2713" : "\\u2717";
        step.innerHTML = '<span class="' + cls + '">' + sym + '</span><span>' + escapeHtml(label) + '</span>';
        if (!ok && t.error) {
          var errEl = document.createElement("span");
          errEl.className = "ts-error-detail";
          errEl.textContent = t.error;
          step.appendChild(errEl);
        }
        wrapper.appendChild(step);
      });
      container.appendChild(wrapper);
      container.scrollTop = container.scrollHeight;
    }

    // ── File changes ────────────────────────────────────────────────────

    function renderFileChanges(files) {
      const container = document.getElementById("chat-messages");
      const wrapper = document.createElement("div");
      wrapper.className = "file-changes";

      files.forEach(function(f) {
        var basename = f.path.split("/").pop() || f.path;
        var item = document.createElement("div");
        item.className = "file-change-item";

        var icon = document.createElement("span");
        icon.className = "fc-icon " + f.action;
        icon.textContent = f.action === "create" ? "+" : f.action === "delete" ? "\\u2212" : "\\u270e";
        item.appendChild(icon);

        var label = f.action === "create" ? "Created: " : f.action === "delete" ? "Deleted: " : "Modified: ";
        var name = document.createElement("span");
        name.className = "fc-name";
        name.title = f.path;
        name.textContent = label + basename;
        item.appendChild(name);

        if (f.action === "modify" && f.original != null) {
          var diffBtn = document.createElement("button");
          diffBtn.className = "fc-btn";
          diffBtn.textContent = "View Diff";
          diffBtn.addEventListener("click", function() {
            vscodeApi.postMessage({ type: "openDiff", path: f.path, original: f.original });
          });
          item.appendChild(diffBtn);
        }

        if (f.action !== "delete") {
          var openBtn = document.createElement("button");
          openBtn.className = "fc-btn";
          openBtn.textContent = "Open";
          openBtn.addEventListener("click", function() {
            vscodeApi.postMessage({ type: "openFile", path: f.path });
          });
          item.appendChild(openBtn);
        }

        wrapper.appendChild(item);
      });

      container.appendChild(wrapper);
      container.scrollTop = container.scrollHeight;
    }

    // ── Send ──────────────────────────────────────────────────────────────

    function sendMessage() {
      const input = document.getElementById("user-input");
      const text = input.value.trim();
      if (!text) return;

      const model = document.getElementById("model-select").value;
      if (!model) {
        appendMessage("error", "No model selected. Click the gear icon to configure an API key first.", undefined);
        return;
      }

      appendMessage("user", text, undefined);
      const filePaths = attachedFiles.map(f => f.absolutePath);
      const snippets = attachedSnippets.slice();
      attachedFiles = [];
      attachedSnippets = [];
      renderFileChips();
      input.value = "";
      input.style.height = "";
      document.getElementById("send-btn").disabled = true;
      vscodeApi.postMessage({
        type: "send",
        message: text,
        model,
        files: filePaths.length > 0 ? filePaths : undefined,
        snippets: snippets.length > 0 ? snippets : undefined,
      });
    }

    // ── State ─────────────────────────────────────────────────────────────

    function onModelChange() {
      const model = document.getElementById("model-select")?.value;
      if (model) {
        vscodeApi.postMessage({ type: "changeModel", model });
        vscodeApi.setState({ selectedModel: model });
      }
    }

    // ── File chips (attached files) ────────────────────────────────────────

    let attachedFiles = [];
    let attachedSnippets = [];

    function addFileChip(file) {
      if (attachedFiles.some(f => f.absolutePath === file.absolutePath)) return;
      attachedFiles.push(file);
      renderFileChips();
    }

    function removeFileChip(idx) {
      attachedFiles.splice(idx, 1);
      renderFileChips();
    }

    function addSnippetChip(snippet) {
      attachedSnippets.push(snippet);
      renderFileChips();
    }

    function removeSnippetChip(idx) {
      attachedSnippets.splice(idx, 1);
      renderFileChips();
    }

    function renderFileChips() {
      const container = document.getElementById("file-chips");
      container.innerHTML = "";
      attachedFiles.forEach((f, i) => {
        const chip = document.createElement("span");
        chip.className = "file-chip";
        chip.textContent = f.name;
        const rm = document.createElement("span");
        rm.className = "remove";
        rm.textContent = "\\u00d7";
        rm.addEventListener("click", () => removeFileChip(i));
        chip.appendChild(rm);
        container.appendChild(chip);
      });
      attachedSnippets.forEach((s, i) => {
        const chip = document.createElement("span");
        chip.className = "snippet-chip";
        const lines = s.startLine === s.endLine ? ":" + s.startLine : ":" + s.startLine + "-" + s.endLine;
        chip.textContent = s.fileName + lines;
        const rm = document.createElement("span");
        rm.className = "remove";
        rm.textContent = "\\u00d7";
        rm.addEventListener("click", () => removeSnippetChip(i));
        chip.appendChild(rm);
        container.appendChild(chip);
      });
    }

    // ── @-mention popup ────────────────────────────────────────────────────

    let mentionFiles = [];
    let mentionIdx = 0;
    let mentionStart = -1;

    function showMentionPopup(files) {
      mentionFiles = files;
      mentionIdx = 0;
      const popup = document.getElementById("mention-popup");
      popup.innerHTML = "";
      files.forEach((f, i) => {
        const item = document.createElement("div");
        item.className = "mention-item" + (i === 0 ? " active" : "");
        item.innerHTML = '<span>' + f.name + '</span><span class="path">' + f.relativePath + '</span>';
        item.addEventListener("click", () => selectMention(f));
        popup.appendChild(item);
      });
      popup.classList.remove("hidden");
    }

    function hideMentionPopup() {
      document.getElementById("mention-popup").classList.add("hidden");
      mentionFiles = [];
      mentionStart = -1;
    }

    function selectMention(file) {
      addFileChip(file);
      const input = document.getElementById("user-input");
      const val = input.value;
      input.value = val.slice(0, mentionStart) + val.slice(input.selectionStart);
      hideMentionPopup();
      input.focus();
    }

    // ── Code block rendering ───────────────────────────────────────────────

    function renderCodeBlocks(el) {
      const codeBlockRegex = /\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g;
      const html = el.innerHTML;
      el.innerHTML = html.replace(codeBlockRegex, function(match, lang, code) {
        return '<div class="code-block-wrapper">' +
          '<div class="code-actions">' +
          '<button class="copy-btn" data-code="' + code.replace(/"/g, '&quot;') + '">Copy</button>' +
          '<button class="insert-btn" data-code="' + code.replace(/"/g, '&quot;') + '">Insert</button>' +
          '</div>' +
          '<pre><code>' + code.replace(/</g, '&lt;') + '</code></pre></div>';
      });
      el.querySelectorAll(".copy-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          navigator.clipboard.writeText(btn.dataset.code);
          btn.textContent = "Copied!";
          setTimeout(() => { btn.textContent = "Copy"; }, 1500);
        });
      });
      el.querySelectorAll(".insert-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          vscodeApi.postMessage({ type: "insertSnippet", code: btn.dataset.code });
        });
      });
    }

    // ── Chat history ──────────────────────────────────────────────────────

    function toggleHistory() {
      const panel = document.getElementById("chat-history-panel");
      if (panel.classList.contains("hidden")) {
        vscodeApi.postMessage({ type: "listChats" });
        panel.classList.remove("hidden");
      } else {
        panel.classList.add("hidden");
      }
    }

    function renderChatList(chats, currentId) {
      const panel = document.getElementById("chat-history-panel");
      panel.innerHTML = "";
      if (chats.length === 0) {
        panel.innerHTML = '<div style="padding:10px;font-size:12px;opacity:0.5">No saved chats</div>';
        return;
      }
      for (var i = 0; i < chats.length; i++) {
        (function(chat) {
          var item = document.createElement("div");
          item.className = "chat-item" + (chat.id === currentId ? " active" : "");

          var title = document.createElement("span");
          title.className = "chat-item-title";
          title.textContent = chat.title;

          var date = document.createElement("span");
          date.className = "chat-item-date";
          var d = new Date(chat.updated);
          date.textContent = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });

          var del = document.createElement("button");
          del.className = "chat-item-delete";
          del.textContent = "\\u00d7";
          del.title = "Delete chat";
          del.addEventListener("click", function(e) {
            e.stopPropagation();
            vscodeApi.postMessage({ type: "deleteChat", id: chat.id });
          });

          item.appendChild(title);
          item.appendChild(date);
          item.appendChild(del);
          item.addEventListener("click", function() {
            document.getElementById("chat-history-panel").classList.add("hidden");
            vscodeApi.postMessage({ type: "loadChat", id: chat.id });
          });
          panel.appendChild(item);
        })(chats[i]);
      }
    }

    // ── Event wiring ──────────────────────────────────────────────────────

    document.getElementById("new-chat-btn").addEventListener("click", function() {
      document.getElementById("chat-history-panel").classList.add("hidden");
      vscodeApi.postMessage({ type: "newChat" });
    });
    document.getElementById("history-btn").addEventListener("click", toggleHistory);
    document.getElementById("settings-btn").addEventListener("click", toggleSetup);
    document.getElementById("model-select").addEventListener("change", onModelChange);
    document.getElementById("setup-provider").addEventListener("change", onProviderChange);
    document.getElementById("save-key-btn").addEventListener("click", saveApiKey);
    document.getElementById("send-btn").addEventListener("click", sendMessage);
    document.getElementById("stop-btn").addEventListener("click", function() {
      // Emergency local unstick even if extension host is delayed.
      completeToolProgress();
      removeThinking();
      setGenerating(false);
      document.getElementById("send-btn").disabled = false;
      vscodeApi.postMessage({ type: "stop" });
    });

    const userInput = document.getElementById("user-input");

    userInput.addEventListener("keydown", function(e) {
      if (mentionFiles.length > 0) {
        if (e.key === "ArrowDown") { e.preventDefault(); mentionIdx = Math.min(mentionIdx + 1, mentionFiles.length - 1); updateMentionActive(); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); mentionIdx = Math.max(mentionIdx - 1, 0); updateMentionActive(); return; }
        if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); selectMention(mentionFiles[mentionIdx]); return; }
        if (e.key === "Escape") { hideMentionPopup(); return; }
      }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });

    function updateMentionActive() {
      const items = document.getElementById("mention-popup").querySelectorAll(".mention-item");
      items.forEach((it, i) => it.classList.toggle("active", i === mentionIdx));
    }

    userInput.addEventListener("input", function() {
      this.style.height = "auto";
      this.style.height = Math.min(this.scrollHeight, 140) + "px";

      const val = this.value;
      const cursor = this.selectionStart;
      const before = val.slice(0, cursor);
      const atIdx = before.lastIndexOf("@");

      if (atIdx >= 0 && (atIdx === 0 || before[atIdx - 1] === " " || before[atIdx - 1] === "\\n")) {
        const query = before.slice(atIdx + 1);
        if (query.length <= 40 && !query.includes(" ")) {
          mentionStart = atIdx;
          vscodeApi.postMessage({ type: "getFiles", query });
          return;
        }
      }
      hideMentionPopup();
    });

    userInput.addEventListener("paste", function() {
      vscodeApi.postMessage({ type: "getClipboardContext" });
    });

    // ── Drag and drop ──────────────────────────────────────────────────────

    const inputArea = document.getElementById("input-area");
    function onDragOver(e) {
      e.preventDefault();
      inputArea.style.outline = "2px dashed var(--vscode-focusBorder)";
    }
    function onDragLeave() {
      inputArea.style.outline = "";
    }
    function handleDrop(e) {
      e.preventDefault();
      inputArea.style.outline = "";

      // 1) VSCode/Electron file drop from explorer/editor
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        for (var i = 0; i < e.dataTransfer.files.length; i++) {
          var filePath = e.dataTransfer.files[i].path;
          if (filePath) {
            vscodeApi.postMessage({ type: "dropFile", uri: filePath });
          }
        }
        return;
      }

      // 2) VSCode explorer custom payload
      var explorerPayload = e.dataTransfer.getData("application/vnd.code.tree.explorer");
      if (explorerPayload) {
        try {
          var parsed = JSON.parse(explorerPayload);
          var items = Array.isArray(parsed) ? parsed : [parsed];
          items.forEach(function(it) {
            if (it && typeof it.resourceUri === "string") {
              vscodeApi.postMessage({ type: "dropFile", uri: it.resourceUri });
            }
          });
          return;
        } catch {
          // ignore and continue with other mime types
        }
      }

      // 3) Generic URI list
      var uriList = e.dataTransfer.getData("text/uri-list");
      if (uriList) {
        uriList.split("\\n").forEach(function(uri) {
          uri = uri.trim();
          if (uri && !uri.startsWith("#")) {
            vscodeApi.postMessage({ type: "dropFile", uri: uri });
          }
        });
        return;
      }

      // 4) Plain path fallback
      var plain = e.dataTransfer.getData("text/plain");
      if (plain) {
        plain.split("\\n").forEach(function(line) {
          line = line.trim();
          if (line) {
            vscodeApi.postMessage({ type: "dropFile", uri: line });
          }
        });
      }
    }

    inputArea.addEventListener("dragover", onDragOver);
    inputArea.addEventListener("dragleave", onDragLeave);
    inputArea.addEventListener("drop", handleDrop);
    userInput.addEventListener("dragover", onDragOver);
    userInput.addEventListener("dragleave", onDragLeave);
    userInput.addEventListener("drop", handleDrop);

    // ── Message listener ───────────────────────────────────────────────────

    window.addEventListener("message", event => {
      try {
        const msg = event.data;
        switch (msg.type) {
        case "init":
          allModels = msg.models;
          configuredProviders = msg.configuredProviders;
          populateModels(msg.selectedModel);
          updateSetupStatus();
          clearMessages();
          restoreMessages(msg.messages);
          if (configuredProviders.length === 0) {
            document.getElementById("setup-panel").classList.remove("hidden");
          } else {
            document.getElementById("setup-panel").classList.add("hidden");
          }
          break;
        case "toolProgress":
          addToolProgress(msg.label);
          break;
        case "toolResult":
          markLastToolResult(msg.success, msg.error);
          break;
        case "fileChanges":
          renderFileChanges(msg.files);
          break;
        case "response": {
          completeToolProgress();
          removeThinking();
          setGenerating(false);
          const meta = formatMeta(msg.model, msg.tokens);
          const el = appendMessage("assistant", msg.text, meta || undefined);
          if (el) renderCodeBlocks(el.querySelector(".message-bubble"));
          document.getElementById("send-btn").disabled = false;
          break;
        }
        case "error": {
          completeToolProgress();
          removeThinking();
          setGenerating(false);
          const errEl = appendMessage("error", msg.text, undefined);
          if (errEl) {
            var retryBtn = document.createElement("button");
            retryBtn.className = "fc-btn";
            retryBtn.textContent = "Retry";
            retryBtn.style.marginTop = "6px";
            retryBtn.addEventListener("click", function() {
              vscodeApi.postMessage({ type: "retry" });
            });
            errEl.querySelector(".message-bubble").appendChild(retryBtn);
          }
          document.getElementById("send-btn").disabled = false;
          break;
        }
        case "populateInput": {
          var inp = document.getElementById("user-input");
          inp.value = msg.text;
          inp.style.height = "auto";
          inp.style.height = Math.min(inp.scrollHeight, 140) + "px";
          inp.focus();
          break;
        }
        case "stopped": {
          completeToolProgress();
          removeThinking();
          setGenerating(false);
          document.getElementById("send-btn").disabled = false;
          break;
        }
        case "thinking":
          if (msg.active) showThinking();
          else { removeThinking(); setGenerating(false); }
          break;
        case "fileList":
          if (msg.files.length > 0) showMentionPopup(msg.files);
          else hideMentionPopup();
          break;
        case "clipboardContext":
          if (msg.snippet) addSnippetChip(msg.snippet);
          break;
        case "chatList":
          renderChatList(msg.chats, msg.currentId);
          break;
        case "addFile":
          addFileChip(msg.file);
          break;
        }
      } catch (err) {
        console.error("Lamia chat webview message handler failed:", err);
        // Keep UI operable even if one message payload is malformed.
        completeToolProgress();
        removeThinking();
        setGenerating(false);
        document.getElementById("send-btn").disabled = false;
      }
    });

    // ── Init ──────────────────────────────────────────────────────────────

    vscodeApi.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}
