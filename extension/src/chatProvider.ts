import * as vscode from "vscode";
import { LamiaProcess } from "./lamiaProcess";
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
} from "./chatStore";
import { NoPythonError } from "./lamiaInstaller";
import { getChatConfigPath, writeSelectedModel, readSelectedModel, ensureChatConfig } from "./chatConfig";
import { filterFiles } from "./fileContext";

// ── Types ────────────────────────────────────────────────────────────────────

type WebviewMessage =
  | { type: "send"; message: string; model: string; files?: string[] }
  | { type: "changeModel"; model: string }
  | { type: "saveApiKey"; provider: string; key: string }
  | { type: "insertSnippet"; code: string }
  | { type: "getFiles"; query: string }
  | { type: "ready" }
  | { type: "newChat" }
  | { type: "loadChat"; id: string };

type HostMessage =
  | { type: "response"; text: string; model?: string }
  | { type: "error"; text: string }
  | { type: "thinking"; active: boolean }
  | { type: "toolProgress"; tool: string; label: string }
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
    };

const SYSTEM_HINT = "You are an assistant in Lamia Studio, an IDE for the Lamia programming language. " +
  "If the user asks about Lamia syntax, .lm files, .hu files, config.yaml, model chains, or Lamia-specific features, " +
  "use your tools to look up the relevant documentation before answering. " +
  "When writing Lamia code, use Lamia syntax - not plain Python.";

const TOOL_LABELS: Record<string, { verb: string; argKey?: string }> = {
  get_docs:    { verb: "Reading docs",  argKey: "topic" },
  read_file:   { verb: "Reading file",  argKey: "path" },
  list_files:  { verb: "Listing files", argKey: "directory" },
  write_file:  { verb: "Writing file",  argKey: "path" },
};

function toolProgressLabel(tool: string, args: Record<string, unknown>): string {
  const def = TOOL_LABELS[tool];
  if (!def) return `Using tool: ${tool}`;
  const detail = def.argKey && args[def.argKey] ? String(args[def.argKey]) : "";
  return detail ? `${def.verb}: ${detail}` : def.verb;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let r = "";
  for (let i = 0; i < 32; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return r;
}

// ── Provider ─────────────────────────────────────────────────────────────────

export class LamiaChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "lamia.chatView";
  private _view?: vscode.WebviewView;
  private _process: LamiaProcess | null = null;
  private _chat: Chat;

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
        await this._sendInit();
        break;
      }

      case "loadChat": {
        const loaded = loadChat(message.id);
        if (loaded) {
          this._chat = loaded;
          await this._sendInit();
        }
        break;
      }

      case "send": {
        this._post({ type: "thinking", active: true });
        try {
          const proc = await this._ensureProcess();

          const userMsg: ChatMessage = {
            role: "user",
            text: message.message,
            ts: Date.now(),
          };
          this._chat.messages.push(userMsg);
          saveChat(this._chat);

          const files = message.files && message.files.length > 0 ? message.files : undefined;
          const response = await proc.send(message.message, {
            system: SYSTEM_HINT,
            files,
            onToolUse: (tool, args) => {
              this._post({
                type: "toolProgress",
                tool,
                label: toolProgressLabel(tool, args),
              });
            },
          });

          if (response.type === "response" && response.text) {
            const assistantMsg: ChatMessage = {
              role: "assistant",
              text: response.text,
              model: response.model,
              tokens: response.tokens,
              ts: Date.now(),
            };
            this._chat.messages.push(assistantMsg);
            saveChat(this._chat);
            this._post({ type: "response", text: response.text, model: response.model });
          } else if (response.type === "error") {
            const errorMsg: ChatMessage = {
              role: "error",
              text: response.message || "Unknown error",
              ts: Date.now(),
            };
            this._chat.messages.push(errorMsg);
            saveChat(this._chat);
            this._post({ type: "error", text: response.message || "Unknown error" });
          }
        } catch (err: any) {
          if (err instanceof NoPythonError) {
            this._post({
              type: "error",
              text: "Python 3.10+ is not installed. The chat and code execution require Python. "
                + "Please install Python and restart the IDE.",
            });
          } else {
            this._post({ type: "error", text: err.message });
          }
        } finally {
          this._post({ type: "thinking", active: false });
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

      case "insertSnippet": {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage("Open a .lm file to insert a snippet");
          return;
        }
        editor.insertSnippet(new vscode.SnippetString((message as any).code));
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

    /* ── Messages ──────────────────────────────────────────────────────── */
    #chat-messages {
      flex: 1; overflow-y: auto; padding: 10px 8px;
      display: flex; flex-direction: column; gap: 10px;
    }
    .message { max-width: 100%; word-break: break-word; }
    .message-bubble {
      display: inline-block; padding: 7px 10px;
      border-radius: 8px; line-height: 1.5; font-size: 13px;
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
    @keyframes spin { to { transform: rotate(360deg); } }

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
    <button class="icon-btn" id="settings-btn" title="API key settings">&#9881;</button>
  </div>

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
      <textarea id="user-input" rows="3" placeholder="Ask anything... @ to reference files (Ctrl+Enter to send)"></textarea>
      <div id="mention-popup" class="hidden"></div>
    </div>
    <div id="input-footer">
      <span id="input-hint">Ctrl+Enter to send &middot; @ to attach files &middot; drop files here</span>
      <button id="send-btn">Send &#8594;</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();

    let allModels = [];
    let configuredProviders = [];

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
        let meta = "";
        if (msg.model) meta += msg.model;
        if (msg.tokens) meta += (meta ? " | " : "") + msg.tokens.input + "/" + msg.tokens.output + " tokens";
        appendMessage(msg.role, msg.text, meta || undefined);
      }
    }

    // ── Tool progress ──────────────────────────────────────────────────────

    let toolProgressEl = null;

    function escapeHtml(s) {
      return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
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

      toolProgressEl.querySelectorAll(".ts-spinner").forEach(function(s) {
        const check = document.createElement("span");
        check.className = "ts-check";
        check.textContent = "\\u2713";
        s.replaceWith(check);
      });

      const step = document.createElement("div");
      step.className = "tool-step";
      step.innerHTML = '<span class="ts-spinner"></span><span>' + escapeHtml(label) + '</span>';
      toolProgressEl.appendChild(step);
      container.scrollTop = container.scrollHeight;
    }

    function completeToolProgress() {
      if (!toolProgressEl) return;
      toolProgressEl.querySelectorAll(".ts-spinner").forEach(function(s) {
        const check = document.createElement("span");
        check.className = "ts-check";
        check.textContent = "\\u2713";
        s.replaceWith(check);
      });
      toolProgressEl = null;
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
      attachedFiles = [];
      renderFileChips();
      input.value = "";
      input.style.height = "";
      document.getElementById("send-btn").disabled = true;
      vscodeApi.postMessage({ type: "send", message: text, model, files: filePaths.length > 0 ? filePaths : undefined });
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

    function addFileChip(file) {
      if (attachedFiles.some(f => f.absolutePath === file.absolutePath)) return;
      attachedFiles.push(file);
      renderFileChips();
    }

    function removeFileChip(idx) {
      attachedFiles.splice(idx, 1);
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

    // ── Event wiring ──────────────────────────────────────────────────────

    document.getElementById("settings-btn").addEventListener("click", toggleSetup);
    document.getElementById("model-select").addEventListener("change", onModelChange);
    document.getElementById("setup-provider").addEventListener("change", onProviderChange);
    document.getElementById("save-key-btn").addEventListener("click", saveApiKey);
    document.getElementById("send-btn").addEventListener("click", sendMessage);

    const userInput = document.getElementById("user-input");

    userInput.addEventListener("keydown", function(e) {
      if (mentionFiles.length > 0) {
        if (e.key === "ArrowDown") { e.preventDefault(); mentionIdx = Math.min(mentionIdx + 1, mentionFiles.length - 1); updateMentionActive(); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); mentionIdx = Math.max(mentionIdx - 1, 0); updateMentionActive(); return; }
        if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); selectMention(mentionFiles[mentionIdx]); return; }
        if (e.key === "Escape") { hideMentionPopup(); return; }
      }
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendMessage(); }
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

    // ── Drag and drop ──────────────────────────────────────────────────────

    const inputArea = document.getElementById("input-area");
    inputArea.addEventListener("dragover", (e) => { e.preventDefault(); inputArea.style.outline = "2px dashed var(--vscode-focusBorder)"; });
    inputArea.addEventListener("dragleave", () => { inputArea.style.outline = ""; });
    inputArea.addEventListener("drop", (e) => {
      e.preventDefault();
      inputArea.style.outline = "";
    });

    // ── Message listener ───────────────────────────────────────────────────

    window.addEventListener("message", event => {
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
        case "response": {
          completeToolProgress();
          const el = appendMessage("assistant", msg.text, msg.model || undefined);
          if (el) renderCodeBlocks(el.querySelector(".message-bubble"));
          document.getElementById("send-btn").disabled = false;
          break;
        }
        case "error":
          completeToolProgress();
          appendMessage("error", msg.text, undefined);
          document.getElementById("send-btn").disabled = false;
          break;
        case "thinking":
          if (msg.active) showThinking();
          else removeThinking();
          break;
        case "fileList":
          if (msg.files.length > 0) showMentionPopup(msg.files);
          else hideMentionPopup();
          break;
      }
    });

    // ── Init ──────────────────────────────────────────────────────────────

    vscodeApi.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}
