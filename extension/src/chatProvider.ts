import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { exec } from "child_process";
import { getApiKey, setApiKey, getConfiguredProviders, maskKey } from "./envHelper";

// ── Types ────────────────────────────────────────────────────────────────────

interface ModelInfo {
  id: string;
  label: string;
}

type ModelList = Record<string, ModelInfo[]>;

type WebviewMessage =
  | { type: "send"; message: string; model: string }
  | { type: "saveApiKey"; provider: string; key: string }
  | { type: "insertSnippet"; code: string }
  | { type: "ready" }
  | { type: "openSettings" };

type HostMessage =
  | { type: "response"; text: string }
  | { type: "error"; text: string }
  | { type: "thinking"; active: boolean }
  | { type: "init"; models: ModelList; configuredProviders: string[]; providerKeys: Record<string, string> }
  | { type: "keySaved"; provider: string; maskedKey: string; configuredProviders: string[] };

// ── Constants ────────────────────────────────────────────────────────────────

const MODELS_URL = "https://raw.githubusercontent.com/LamiaOrg/lamia-ide/main/models.json";

const LAMIA_CONTEXT = `You are a Lamia language assistant. Lamia is a Python-like language for AI/LLM orchestration.
Key syntax:
  - Agent call:       result = function_name(<params>) -> JSON[Model]
  - Pydantic model:   class MyModel(BaseModel): field: str = Field(description="what should be written in this filed by the LLM")
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

function isLamiaRelated(message: string): boolean {
  const lower = message.toLowerCase();
  return LAMIA_KEYWORDS.some((kw) => lower.includes(kw));
}

// ── Bundled model list fallback ──────────────────────────────────────────────

let _cachedModels: ModelList | undefined;

async function fetchModels(): Promise<ModelList> {
  if (_cachedModels) return _cachedModels;

  try {
    const res = await fetch(MODELS_URL);
    if (res.ok) {
      _cachedModels = (await res.json()) as ModelList;
      return _cachedModels;
    }
  } catch {
    // network unavailable — use bundled
  }

  try {
    const bundled = path.join(__dirname, "..", "models.json");
    _cachedModels = JSON.parse(fs.readFileSync(bundled, "utf8")) as ModelList;
    return _cachedModels;
  } catch {
    return {
      anthropic: [{ id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" }],
      openai: [{ id: "gpt-4o", label: "GPT-4o" }],
    };
  }
}

// ── Provider ─────────────────────────────────────────────────────────────────

export class LamiaChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "lamia.chatView";
  private _view?: vscode.WebviewView;

  constructor(private readonly _context: vscode.ExtensionContext) {}

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
  }

  // ── Message handling ───────────────────────────────────────────────────────

  private async _handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        await this._sendInit();
        break;

      case "saveApiKey": {
        setApiKey(message.provider, message.key);
        const providers = getConfiguredProviders();
        this._post({
          type: "keySaved",
          provider: message.provider,
          maskedKey: maskKey(message.key),
          configuredProviders: providers,
        });
        break;
      }

      case "send": {
        this._post({ type: "thinking", active: true });
        try {
          const output = await this._runChat(message.message, message.model);
          this._post({ type: "response", text: output });
        } catch (err: any) {
          this._post({ type: "error", text: err.message });
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

  private async _sendInit(): Promise<void> {
    const models = await fetchModels();
    const configuredProviders = getConfiguredProviders();
    const providerKeys: Record<string, string> = {};
    for (const p of configuredProviders) {
      const k = getApiKey(p);
      if (k) providerKeys[p] = maskKey(k);
    }
    this._post({ type: "init", models, configuredProviders, providerKeys });
  }

  private _post(msg: HostMessage): void {
    this._view?.webview.postMessage(msg);
  }

  // ── LLM execution via lamia CLI ────────────────────────────────────────────

  private async _runChat(userMessage: string, model: string): Promise<string> {
    const config = vscode.workspace.getConfiguration("lamia");
    const cliPath = config.get<string>("cliPath", "lamia");
    const timeoutMs = config.get<number>("chat.timeoutMs", 120000);

    const providerName = model.includes(":") ? model.split(":")[0] : this._guessProvider(model);
    const modelId = model.includes(":") ? model.split(":")[1] : model;

    const apiKey = getApiKey(providerName);
    if (!apiKey) {
      throw new Error(`No API key configured for ${providerName}. Click the gear icon to set one.`);
    }

    const tmpDir = path.join(os.tmpdir(), `lamia_chat_${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const configContent = [
      `model_chain:`,
      `  - name: "${providerName}:${modelId}"`,
      `providers:`,
      `  ${providerName}:`,
      `    enabled: true`,
    ].join("\n");

    const configPath = path.join(tmpDir, "config.yaml");
    fs.writeFileSync(configPath, configContent, "utf8");

    let script: string;
    if (isLamiaRelated(userMessage)) {
      script = [
        `def assistant(message, context):`,
        `    """`,
        `    {context}`,
        ``,
        `    User question: {message}`,
        `    """`,
        ``,
        `result = assistant(`,
        `    message=${this._pyTripleQuote(userMessage)},`,
        `    context=${this._pyTripleQuote(LAMIA_CONTEXT)}`,
        `)`,
        `print(result)`,
      ].join("\n");
    } else {
      script = [
        `def assistant(message):`,
        `    """`,
        `    {message}`,
        `    """`,
        ``,
        `result = assistant(message=${this._pyTripleQuote(userMessage)})`,
        `print(result)`,
      ].join("\n");
    }

    const scriptPath = path.join(tmpDir, "chat.lm");
    fs.writeFileSync(scriptPath, script, "utf8");

    const envVars: Record<string, string> = Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)
    );
    const keyMap: Record<string, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };
    if (keyMap[providerName]) {
      envVars[keyMap[providerName]] = apiKey;
    }

    return new Promise<string>((resolve, reject) => {
      exec(
        `${cliPath} --config "${configPath}" "${scriptPath}"`,
        { cwd: os.tmpdir(), timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, env: envVars },
        (error, stdout, stderr) => {
          try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          } catch { /* ignore */ }

          if (error) {
            reject(new Error(stderr?.trim() || error.message));
            return;
          }
          resolve(stdout.trim());
        }
      );
    });
  }

  private _guessProvider(modelId: string): string {
    if (modelId.startsWith("claude") || modelId.startsWith("anthropic")) return "anthropic";
    if (modelId.startsWith("gpt") || modelId.startsWith("o3") || modelId.startsWith("o1") || modelId.startsWith("o4")) return "openai";
    return "anthropic";
  }

  private _pyTripleQuote(s: string): string {
    const escaped = s.replace(/\\/g, "\\\\").replace(/"""/g, '""\\"');
    return `"""${escaped}"""`;
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

    /* ── Model bar ─────────────────────────────────────────────────────── */
    #model-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-panel-border, #444);
      flex-shrink: 0;
    }
    #model-bar label { font-size: 11px; opacity: 0.7; white-space: nowrap; }

    #model-select {
      flex: 1; min-width: 0;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 3px; padding: 3px 6px;
      font-size: 12px; font-family: inherit; outline: none;
    }
    #model-select:focus { border-color: var(--vscode-focusBorder); }

    #settings-btn {
      background: none; border: none;
      color: var(--vscode-foreground);
      cursor: pointer; opacity: 0.6;
      font-size: 14px; padding: 2px 4px;
      border-radius: 3px; flex-shrink: 0;
    }
    #settings-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }

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

    /* ── Hints panel ───────────────────────────────────────────────────── */
    #hints-panel { border-bottom: 1px solid var(--vscode-panel-border, #444); flex-shrink: 0; }
    #hints-header {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 10px; cursor: pointer; user-select: none;
      font-size: 11px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.04em; color: var(--vscode-foreground); opacity: 0.8;
    }
    #hints-header:hover { opacity: 1; }
    #hints-arrow { font-size: 10px; transition: transform 0.15s; }
    #hints-panel.collapsed #hints-arrow { transform: rotate(-90deg); }
    #hints-panel.collapsed #hints-body { display: none; }
    #hints-body { padding: 0 8px 8px; }
    #hints-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 7px; }
    .chip {
      display: inline-flex; align-items: center;
      padding: 2px 8px; border-radius: 10px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-size: 11px; cursor: pointer; white-space: nowrap;
      border: none; transition: opacity 0.1s;
    }
    .chip:hover { opacity: 0.8; }
    .lamia-tip {
      font-size: 11px; padding: 5px 8px; border-radius: 4px;
      background: var(--vscode-editorInfo-background, rgba(0,120,212,0.12));
      color: var(--vscode-editorInfo-foreground, var(--vscode-foreground));
      border-left: 3px solid var(--vscode-editorInfo-border, #0078d4);
      line-height: 1.4;
    }
    .lamia-tip code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10px;
      background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.1));
      padding: 1px 3px; border-radius: 2px;
    }

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

  <!-- Model bar + settings gear -->
  <div id="model-bar">
    <label for="model-select">Model:</label>
    <select id="model-select"></select>
    <button id="settings-btn" title="API key settings">&#9881;</button>
  </div>

  <!-- API key setup (hidden by default, shown on first launch or gear click) -->
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

  <!-- Hints panel -->
  <div id="hints-panel" class="collapsed">
    <div id="hints-header">
      <span id="hints-arrow">&#9660;</span>
      Lamia Syntax Hints
    </div>
    <div id="hints-body">
      <div id="hints-chips"></div>
      <div class="lamia-tip">
        Use <code>agent(param=val) -&gt; JSON[Model]</code> &mdash; not Python functions.
      </div>
    </div>
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

    let allModels = {};
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
      for (const provider of Object.keys(allModels)) {
        if (!configuredProviders.includes(provider)) continue;
        const models = allModels[provider] || [];
        for (const m of models) {
          const opt = document.createElement("option");
          opt.value = provider + ":" + m.id;
          opt.textContent = m.label + " (" + provider + ")";
          if (opt.value === prev) opt.selected = true;
          sel.appendChild(opt);
          hasOptions = true;
        }
      }

      if (!hasOptions) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "-- set an API key first --";
        opt.disabled = true;
        sel.appendChild(opt);
      }
    }

    // ── Hints ──────────────────────────────────────────────────────────────

    const LAMIA_HINTS = [
      { label: "Agent \\u2192 JSON", code: "result = \${1:agent_name}(\${2:param}=\${3:value}) -> JSON[\${4:Model}]", tooltip: "Call an agent and parse structured JSON output" },
      { label: "Agent \\u2192 text", code: "\${1:result} = \${2:agent_name}(message=\${3:\\"your message\\"})", tooltip: "Call an agent and get plain text" },
      { label: "Pydantic model", code: "class \${1:ModelName}(BaseModel):\\n    \${2:field}: \${3:str} = Field(description=\\"\${4:desc}\\")", tooltip: "Define a structured output model" },
      { label: "f-string prompt", code: "prompt = f\\"\${1:Instruction}. Input: {\${2:variable}}\\"", tooltip: "Build a dynamic prompt string" },
      { label: "Prompt var", code: "{\${1:variable_name}}", tooltip: "Insert a template variable (.hu files)" }
    ];

    function buildHints() {
      const container = document.getElementById("hints-chips");
      for (const hint of LAMIA_HINTS) {
        const btn = document.createElement("button");
        btn.className = "chip";
        btn.textContent = hint.label;
        btn.title = hint.tooltip;
        btn.addEventListener("click", () => {
          vscodeApi.postMessage({ type: "insertSnippet", code: hint.code });
        });
        container.appendChild(btn);
      }
    }

    function toggleHints() {
      document.getElementById("hints-panel").classList.toggle("collapsed");
    }

    // ── Messages ──────────────────────────────────────────────────────────

    let thinkingEl = null;

    function hideEmptyState() {
      const es = document.getElementById("empty-state");
      if (es) es.remove();
    }

    function appendMessage(role, text) {
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

      container.appendChild(wrapper);
      container.scrollTop = container.scrollHeight;
      saveState();
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

    // ── Send ──────────────────────────────────────────────────────────────

    function sendMessage() {
      const input = document.getElementById("user-input");
      const text = input.value.trim();
      if (!text) return;

      const model = document.getElementById("model-select").value;
      if (!model) {
        appendMessage("error", "No model selected. Click the gear icon to configure an API key first.");
        return;
      }

      appendMessage("user", text);
      input.value = "";
      input.style.height = "";
      document.getElementById("send-btn").disabled = true;
      vscodeApi.postMessage({ type: "send", message: text, model });
    }

    // ── State ─────────────────────────────────────────────────────────────

    function saveState() {
      const msgs = [];
      document.querySelectorAll(".message").forEach(el => {
        const role = el.classList[1];
        const bubble = el.querySelector(".message-bubble");
        const text = bubble ? bubble.textContent : "";
        msgs.push({ role, text });
      });
      vscodeApi.setState({
        messages: msgs,
        selectedModel: document.getElementById("model-select")?.value
      });
    }

    function restoreMessages(messages) {
      if (!messages || messages.length === 0) return;
      for (const msg of messages) appendMessage(msg.role, msg.text);
    }

    // ── Event wiring ──────────────────────────────────────────────────────

    document.getElementById("settings-btn").addEventListener("click", toggleSetup);
    document.getElementById("model-select").addEventListener("change", saveState);
    document.getElementById("setup-provider").addEventListener("change", onProviderChange);
    document.getElementById("save-key-btn").addEventListener("click", saveApiKey);
    document.getElementById("send-btn").addEventListener("click", sendMessage);
    document.getElementById("hints-header").addEventListener("click", toggleHints);

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
          if (configuredProviders.length === 0) {
            document.getElementById("setup-panel").classList.remove("hidden");
          }
          break;
        case "keySaved":
          configuredProviders = msg.configuredProviders;
          populateModels();
          updateSetupStatus();
          document.getElementById("setup-panel").classList.add("hidden");
          break;
        case "response":
          appendMessage("assistant", msg.text);
          document.getElementById("send-btn").disabled = false;
          break;
        case "error":
          appendMessage("error", msg.text);
          document.getElementById("send-btn").disabled = false;
          break;
        case "thinking":
          if (msg.active) showThinking();
          else removeThinking();
          break;
      }
    });

    // ── Init ──────────────────────────────────────────────────────────────

    buildHints();
    const state = vscodeApi.getState() || {};
    if (state.messages) restoreMessages(state.messages);
    vscodeApi.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}
