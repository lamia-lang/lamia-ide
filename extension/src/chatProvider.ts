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

// ── Types ────────────────────────────────────────────────────────────────────

type WebviewMessage =
  | { type: "send"; message: string; model: string }
  | { type: "saveApiKey"; provider: string; key: string }
  | { type: "insertSnippet"; code: string }
  | { type: "ready" }
  | { type: "newChat" }
  | { type: "loadChat"; id: string };

type HostMessage =
  | { type: "response"; text: string; model?: string }
  | { type: "error"; text: string }
  | { type: "thinking"; active: boolean }
  | {
      type: "init";
      models: { value: string; label: string }[];
      configuredProviders: string[];
      messages: ChatMessage[];
      chatTitle: string;
    };

// ── Lamia context for syntax questions ───────────────────────────────────────

const LAMIA_CONTEXT = `You are a Lamia language assistant. Lamia is a Python-like language for AI/LLM orchestration.
Key syntax:
  - Agent call:       result = function_name(<params>) -> JSON[Model]
  - Pydantic model:   class MyModel(BaseModel): field: str = Field(description="what should be written in this field by the LLM")
  - Plain text call:  result = function_name(<params>)
  - Prompt template:  .hu files use {variable} and {@filename} placeholders, they are plain text LLM instructions. The filename is the function name for .hu functions
  - Function naming:  function names must be unique in the whole lamia project (in the .lm files). That applies to the .hu file names because they are also functions.
  - File location:    Place .lm and .hu files in the folders with semantic names and nesting. Group the semantically related files in the same folder.
  - f-string prompt:  prompt = f"Instruction. Input: {variable}"
  - Model chain:      config.yaml defines ordered fallback models use the config.yaml of your project as how to generate it. If the user does not mention desired models choose the models that will be the best for the project.
  - Imports:          Imports are needed only for python libraries. They are not needed for lamia functions.
Always respond with Lamia syntax examples when the question is about Lamia. Never plain Python.`;

const LAMIA_KEYWORDS = [
  "lamia", ".lm", ".hu", "agent", "model_chain", "model chain",
  "prompt template", "basemodel", "pydantic", "config.yaml",
  "-> json", "field(", "lamia studio",
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let r = "";
  for (let i = 0; i < 32; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return r;
}

function isLamiaRelatedKeyword(message: string): boolean {
  const lower = message.toLowerCase();
  return LAMIA_KEYWORDS.some((kw) => lower.includes(kw));
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
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
    const cwd = LamiaProcess.resolveWorkingDirForFile(activeFile);
    const logFile = LamiaProcess.resolveLogFile();

    this._process = new LamiaProcess(cliPath, cwd, logFile);
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

          let system: string | undefined;

          if (isLamiaRelatedKeyword(message.message)) {
            system = LAMIA_CONTEXT;
          } else {
            system = await this._classifyWithLlm(proc, message.message);
          }

          const response = await proc.send(message.message, system);

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

  // ── LLM-based Lamia context classifier ─────────────────────────────────────

  private async _classifyWithLlm(proc: LamiaProcess, message: string): Promise<string | undefined> {
    try {
      const classifyPrompt =
        `Classify the following user message. Reply with ONLY the single word "lamia" if the message is asking about the Lamia programming language, Lamia syntax, .lm files, .hu files, lamia config, or Lamia-specific features. Reply with ONLY the single word "general" if it is a general programming question, a generic AI question, or anything not specific to Lamia.\n\nUser message: "${message.slice(0, 300)}"`;

      const result = await proc.send(classifyPrompt);
      if (result.type === "response" && result.text) {
        const answer = result.text.trim().toLowerCase();
        if (answer.includes("lamia")) {
          return LAMIA_CONTEXT;
        }
      }
    } catch {
      // classifier failed — don't inject context
    }
    return undefined;
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  private async _sendInit(): Promise<void> {
    const configuredProviders = getConfiguredProviders();
    const { chain, providerModels } = readAllProviderModels();
    const fallback = await fetchFallbackModels();
    const models = buildModelDropdown(chain, providerModels, fallback, configuredProviders);

    this._post({
      type: "init",
      models,
      configuredProviders,
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
    <textarea id="user-input" rows="3" placeholder="Ask anything... (Ctrl+Enter to send)"></textarea>
    <div id="input-footer">
      <span id="input-hint">Ctrl+Enter to send</span>
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

    function populateModels() {
      const sel = document.getElementById("model-select");
      const prev = sel.value || (vscodeApi.getState() || {}).selectedModel || "";
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
      persistSelection();
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
      input.value = "";
      input.style.height = "";
      document.getElementById("send-btn").disabled = true;
      vscodeApi.postMessage({ type: "send", message: text, model });
    }

    // ── State ─────────────────────────────────────────────────────────────

    function persistSelection() {
      vscodeApi.setState({ selectedModel: document.getElementById("model-select")?.value });
    }

    // ── Event wiring ──────────────────────────────────────────────────────

    document.getElementById("settings-btn").addEventListener("click", toggleSetup);
    document.getElementById("model-select").addEventListener("change", persistSelection);
    document.getElementById("setup-provider").addEventListener("change", onProviderChange);
    document.getElementById("save-key-btn").addEventListener("click", saveApiKey);
    document.getElementById("send-btn").addEventListener("click", sendMessage);

    document.getElementById("user-input").addEventListener("keydown", function(e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendMessage(); }
    });

    document.getElementById("user-input").addEventListener("input", function() {
      this.style.height = "auto";
      this.style.height = Math.min(this.scrollHeight, 140) + "px";
    });

    window.addEventListener("message", event => {
      const msg = event.data;
      switch (msg.type) {
        case "init":
          allModels = msg.models;
          configuredProviders = msg.configuredProviders;
          populateModels();
          updateSetupStatus();
          clearMessages();
          restoreMessages(msg.messages);
          if (configuredProviders.length === 0) {
            document.getElementById("setup-panel").classList.remove("hidden");
          } else {
            document.getElementById("setup-panel").classList.add("hidden");
          }
          break;
        case "response":
          appendMessage("assistant", msg.text, msg.model || undefined);
          document.getElementById("send-btn").disabled = false;
          break;
        case "error":
          appendMessage("error", msg.text, undefined);
          document.getElementById("send-btn").disabled = false;
          break;
        case "thinking":
          if (msg.active) showThinking();
          else removeThinking();
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
