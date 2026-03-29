import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { exec } from "child_process";

// ── Types ────────────────────────────────────────────────────────────────────

interface AgentInfo {
  label: string;
  filePath: string;
  isBuiltin: boolean;
}

type WebviewMessage =
  | { type: "send"; message: string; agentPath: string }
  | { type: "refreshAgents" }
  | { type: "insertSnippet"; code: string }
  | { type: "ready" };

type HostMessage =
  | { type: "response"; text: string; isJson: boolean }
  | { type: "error"; text: string }
  | { type: "agents"; list: AgentInfo[] }
  | { type: "thinking"; active: boolean };

// ── Helpers ──────────────────────────────────────────────────────────────────

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
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

  private _handleMessage(message: WebviewMessage): void {
    switch (message.type) {
      case "ready":
      case "refreshAgents":
        this._discoverAgents().then((agents) => {
          this._post({ type: "agents", list: agents });
        });
        break;

      case "send": {
        const { message: userMsg, agentPath } = message;
        this._post({ type: "thinking", active: true });

        const script = this._buildTempScript(userMsg, agentPath);
        this._runScript(script)
          .then((output) => {
            let isJson = false;
            try {
              JSON.parse(output);
              isJson = true;
            } catch {
              // plain text
            }
            this._post({ type: "response", text: output, isJson });
          })
          .catch((err: Error) => {
            this._post({ type: "error", text: err.message });
          })
          .finally(() => {
            this._post({ type: "thinking", active: false });
          });
        break;
      }

      case "insertSnippet": {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage("Open a .lm file to insert a snippet");
          return;
        }
        editor.insertSnippet(new vscode.SnippetString(message.code));
        break;
      }
    }
  }

  private _post(msg: HostMessage): void {
    this._view?.webview.postMessage(msg);
  }

  // ── Agent discovery ────────────────────────────────────────────────────────

  private async _discoverAgents(): Promise<AgentInfo[]> {
    const agents: AgentInfo[] = [
      { label: "Lamia Assistant (built-in)", filePath: "__builtin__", isBuiltin: true },
    ];

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return agents;
    }

    const uris = await vscode.workspace.findFiles(
      "**/*.lm",
      "{**/node_modules/**,**/.git/**,**/dist/**}",
      50
    );

    for (const uri of uris) {
      const label = this._extractAgentLabel(uri.fsPath);
      agents.push({ label, filePath: uri.fsPath, isBuiltin: false });
    }

    return agents;
  }

  private _extractAgentLabel(filePath: string): string {
    const basename = path.basename(filePath, ".lm");
    try {
      const content = fs.readFileSync(filePath, { encoding: "utf8", flag: "r" });
      const firstLine = content.split("\n")[0] ?? "";
      if (firstLine.startsWith("#")) {
        const commentText = firstLine.slice(1).trim();
        if (commentText.length > 0 && commentText.length < 80) {
          return commentText;
        }
      }
    } catch {
      // unreadable — fall back to filename
    }
    return basename;
  }

  // ── Script generation ──────────────────────────────────────────────────────

  private _buildTempScript(userMessage: string, agentPath: string): string {
    // Escape for embedding inside a Lamia triple-quoted string
    const safeMsg = userMessage
      .replace(/\\/g, "\\\\")
      .replace(/"""/g, '\\"\\"\\"');

    if (agentPath === "__builtin__") {
      return [
        `# Lamia Assistant — generated by Lamia Studio Chat`,
        ``,
        `result = assistant(`,
        `    message="""${safeMsg}""",`,
        `    context="""You are a Lamia language assistant. Lamia is a Python-like`,
        `language for AI/LLM orchestration. Always respond with Lamia syntax examples,`,
        `never plain Python. Key syntax:`,
        `  - Agent call:    result = agent_name(param=value) -> JSON[Model]`,
        `  - Pydantic model: class MyModel(BaseModel): field: str = Field(description="...")`,
        `  - Plain text call: result = agent_name(message="hello")`,
        `  - Prompt template (.hu files): use {variable} placeholders`,
        `Answer concisely and always show a Lamia code example when relevant."""`,
        `)`,
        `print(result)`,
      ].join("\n");
    }

    const agentName = path.basename(agentPath, ".lm")
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_");

    return [
      `# Chat invocation — generated by Lamia Studio Chat`,
      `# Agent: ${agentName} (${agentPath})`,
      ``,
      `result = ${agentName}(message="""${safeMsg}""")`,
      `print(result)`,
    ].join("\n");
  }

  // ── Script execution ───────────────────────────────────────────────────────

  private async _runScript(scriptContent: string): Promise<string> {
    const config = vscode.workspace.getConfiguration("lamia");
    const cliPath = config.get<string>("cliPath", "lamia");
    const timeoutMs = config.get<number>("chat.timeoutMs", 60000);

    const tmpFile = path.join(os.tmpdir(), `lamia_chat_${Date.now()}.lm`);
    fs.writeFileSync(tmpFile, scriptContent, { encoding: "utf8" });

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    return new Promise<string>((resolve, reject) => {
      exec(
        `${cliPath} "${tmpFile}"`,
        {
          cwd: workspaceRoot,
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          env: { ...process.env },
        },
        (error, stdout, stderr) => {
          try {
            fs.unlinkSync(tmpFile);
          } catch {
            // ignore cleanup errors
          }

          if (error) {
            reject(new Error(stderr?.trim() || error.message));
            return;
          }
          resolve(stdout.trim());
        }
      );
    });
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

    /* ── Hints panel ──────────────────────────────────────────────────── */
    #hints-panel {
      border-bottom: 1px solid var(--vscode-panel-border, #444);
      flex-shrink: 0;
    }

    #hints-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      cursor: pointer;
      user-select: none;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--vscode-foreground);
      opacity: 0.8;
    }
    #hints-header:hover { opacity: 1; }
    #hints-arrow { font-size: 10px; transition: transform 0.15s; }
    #hints-panel.collapsed #hints-arrow { transform: rotate(-90deg); }
    #hints-panel.collapsed #hints-body { display: none; }

    #hints-body { padding: 0 8px 8px; }

    #hints-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-bottom: 7px;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 10px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-size: 11px;
      cursor: pointer;
      white-space: nowrap;
      border: none;
      transition: opacity 0.1s;
    }
    .chip:hover { opacity: 0.8; }

    .lamia-tip {
      font-size: 11px;
      padding: 5px 8px;
      border-radius: 4px;
      background: var(--vscode-editorInfo-background, rgba(0,120,212,0.12));
      color: var(--vscode-editorInfo-foreground, var(--vscode-foreground));
      border-left: 3px solid var(--vscode-editorInfo-border, #0078d4);
      line-height: 1.4;
    }
    .lamia-tip code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10px;
      background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.1));
      padding: 1px 3px;
      border-radius: 2px;
    }

    /* ── Agent bar ────────────────────────────────────────────────────── */
    #agent-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-panel-border, #444);
      flex-shrink: 0;
    }

    #agent-bar label {
      font-size: 11px;
      opacity: 0.7;
      white-space: nowrap;
    }

    #agent-select {
      flex: 1;
      min-width: 0;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 3px;
      padding: 3px 6px;
      font-size: 12px;
      font-family: inherit;
      outline: none;
    }
    #agent-select:focus {
      border-color: var(--vscode-focusBorder);
    }

    #refresh-btn {
      background: none;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      opacity: 0.6;
      font-size: 14px;
      padding: 2px 4px;
      border-radius: 3px;
      flex-shrink: 0;
    }
    #refresh-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }

    /* ── Messages ─────────────────────────────────────────────────────── */
    #chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 10px 8px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .message {
      max-width: 100%;
      word-break: break-word;
    }

    .message-bubble {
      display: inline-block;
      padding: 7px 10px;
      border-radius: 8px;
      line-height: 1.5;
      font-size: 13px;
    }

    .message.user { text-align: right; }
    .message.user .message-bubble {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
      border-radius: 8px 8px 2px 8px;
    }

    .message.assistant .message-bubble {
      background: var(--vscode-editor-inactiveSelectionBackground, rgba(255,255,255,0.06));
      border-radius: 8px 8px 8px 2px;
      white-space: pre-wrap;
    }

    .message.error .message-bubble {
      background: var(--vscode-inputValidation-errorBackground, rgba(200,0,0,0.15));
      color: var(--vscode-errorForeground);
      border-radius: 8px;
      border: 1px solid var(--vscode-inputValidation-errorBorder, #f00);
    }

    .message-label {
      font-size: 10px;
      opacity: 0.5;
      margin-bottom: 3px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .message.user .message-label { text-align: right; }

    .json-block {
      background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2));
      border-radius: 4px;
      padding: 8px;
      margin-top: 4px;
    }
    .json-block pre {
      margin: 0;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    .json-label {
      font-size: 10px;
      opacity: 0.5;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 4px;
    }

    /* ── Thinking dots ────────────────────────────────────────────────── */
    .thinking {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 8px 10px;
    }
    .thinking-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--vscode-foreground);
      opacity: 0.4;
      animation: bounce 1.2s ease-in-out infinite;
    }
    .thinking-dot:nth-child(2) { animation-delay: 0.2s; }
    .thinking-dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes bounce {
      0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
      30% { transform: translateY(-5px); opacity: 0.9; }
    }

    /* ── Input area ───────────────────────────────────────────────────── */
    #input-area {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px;
      border-top: 1px solid var(--vscode-panel-border, #444);
      flex-shrink: 0;
    }

    #user-input {
      width: 100%;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      padding: 7px 10px;
      font-family: inherit;
      font-size: 13px;
      resize: none;
      outline: none;
      line-height: 1.5;
      min-height: 60px;
      max-height: 140px;
    }
    #user-input:focus {
      border-color: var(--vscode-focusBorder);
    }
    #user-input::placeholder {
      opacity: 0.5;
    }

    #input-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    #input-hint {
      font-size: 10px;
      opacity: 0.4;
    }

    #send-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      padding: 5px 14px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
    }
    #send-btn:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }
    #send-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    /* ── Empty state ──────────────────────────────────────────────────── */
    #empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
      opacity: 0.4;
      text-align: center;
      padding: 20px;
      gap: 8px;
    }
    #empty-state .icon { font-size: 32px; }
    #empty-state p { font-size: 12px; line-height: 1.5; }
  </style>
</head>
<body>

  <!-- Hints panel (open by default) -->
  <div id="hints-panel">
    <div id="hints-header" onclick="toggleHints()">
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

  <!-- Agent selector -->
  <div id="agent-bar">
    <label for="agent-select">Agent:</label>
    <select id="agent-select"></select>
    <button id="refresh-btn" title="Refresh agents from workspace" onclick="refreshAgents()">&#8635;</button>
  </div>

  <!-- Message history -->
  <div id="chat-messages">
    <div id="empty-state">
      <div class="icon">&#128172;</div>
      <p>Ask anything about Lamia.<br>Select an agent above and start typing.</p>
    </div>
  </div>

  <!-- Input -->
  <div id="input-area">
    <textarea id="user-input" rows="3" placeholder="Ask about Lamia… (Ctrl+Enter to send)"></textarea>
    <div id="input-footer">
      <span id="input-hint">Ctrl+Enter to send</span>
      <button id="send-btn" onclick="sendMessage()">Send &#8594;</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();

    // ── Hints ────────────────────────────────────────────────────────────────

    const LAMIA_HINTS = [
      {
        label: "Agent \u2192 JSON",
        code: "result = \${1:agent_name}(\${2:param}=\${3:value}) -> JSON[\${4:Model}]",
        tooltip: "Call an agent and parse structured JSON output"
      },
      {
        label: "Agent \u2192 text",
        code: "\${1:result} = \${2:agent_name}(message=\${3:\"your message\"})",
        tooltip: "Call an agent and get plain text"
      },
      {
        label: "Pydantic model",
        code: "class \${1:ModelName}(BaseModel):\n    \${2:field}: \${3:str} = Field(description=\"\${4:desc}\")",
        tooltip: "Define a structured output model"
      },
      {
        label: "f-string prompt",
        code: "prompt = f\"\${1:Instruction}. Input: {\${2:variable}}\"",
        tooltip: "Build a dynamic prompt string"
      },
      {
        label: "Prompt var",
        code: "{\${1:variable_name}}",
        tooltip: "Insert a template variable (.hu files)"
      }
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

    // ── Agent dropdown ───────────────────────────────────────────────────────

    function populateAgents(list, selectedPath) {
      const sel = document.getElementById("agent-select");
      const prev = sel.value || selectedPath || "__builtin__";
      sel.innerHTML = "";
      for (const agent of list) {
        const opt = document.createElement("option");
        opt.value = agent.filePath;
        opt.textContent = agent.label;
        if (agent.filePath === prev) opt.selected = true;
        sel.appendChild(opt);
      }
    }

    function refreshAgents() {
      vscodeApi.postMessage({ type: "refreshAgents" });
    }

    // ── Messages ─────────────────────────────────────────────────────────────

    let thinkingEl = null;

    function hideEmptyState() {
      const es = document.getElementById("empty-state");
      if (es) es.remove();
    }

    function appendMessage(role, text, isJson) {
      hideEmptyState();
      removeThinking();

      const container = document.getElementById("chat-messages");
      const wrapper = document.createElement("div");
      wrapper.className = "message " + role;

      const label = document.createElement("div");
      label.className = "message-label";
      label.textContent = role === "user" ? "You" : role === "error" ? "Error" : "Assistant";
      wrapper.appendChild(label);

      if (isJson) {
        const block = document.createElement("div");
        block.className = "json-block";
        const lbl = document.createElement("div");
        lbl.className = "json-label";
        lbl.textContent = "JSON output";
        const pre = document.createElement("pre");
        try {
          pre.textContent = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          pre.textContent = text;
        }
        block.appendChild(lbl);
        block.appendChild(pre);
        wrapper.appendChild(block);
      } else {
        const bubble = document.createElement("div");
        bubble.className = "message-bubble";
        // Use textContent for XSS safety; newlines rendered via white-space:pre-wrap
        bubble.textContent = text;
        wrapper.appendChild(bubble);
      }

      container.appendChild(wrapper);
      container.scrollTop = container.scrollHeight;

      // Persist state
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
      if (thinkingEl) {
        thinkingEl.remove();
        thinkingEl = null;
      }
    }

    // ── Send ─────────────────────────────────────────────────────────────────

    function sendMessage() {
      const input = document.getElementById("user-input");
      const text = input.value.trim();
      if (!text) return;

      const agentPath = document.getElementById("agent-select").value || "__builtin__";

      appendMessage("user", text, false);
      input.value = "";
      input.style.height = "";

      document.getElementById("send-btn").disabled = true;

      vscodeApi.postMessage({ type: "send", message: text, agentPath });
    }

    // ── State persistence ─────────────────────────────────────────────────────

    function getMessages() {
      const msgs = [];
      document.querySelectorAll(".message").forEach(el => {
        const role = el.classList[1];
        const bubble = el.querySelector(".message-bubble");
        const pre = el.querySelector("pre");
        const text = bubble ? bubble.textContent : (pre ? pre.textContent : "");
        const isJson = !!pre;
        msgs.push({ role, text, isJson });
      });
      return msgs;
    }

    function saveState() {
      vscodeApi.setState({
        messages: getMessages(),
        selectedAgent: document.getElementById("agent-select")?.value
      });
    }

    function restoreMessages(messages) {
      if (!messages || messages.length === 0) return;
      for (const msg of messages) {
        appendMessage(msg.role, msg.text, msg.isJson);
      }
    }

    // ── Event wiring ─────────────────────────────────────────────────────────

    document.getElementById("user-input").addEventListener("keydown", function(e) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        sendMessage();
      }
    });

    document.getElementById("user-input").addEventListener("input", function() {
      this.style.height = "auto";
      this.style.height = Math.min(this.scrollHeight, 140) + "px";
    });

    // ── Extension host messages ───────────────────────────────────────────────

    window.addEventListener("message", event => {
      const msg = event.data;
      switch (msg.type) {
        case "agents":
          populateAgents(msg.list, null);
          saveState();
          break;
        case "response":
          appendMessage("assistant", msg.text, msg.isJson);
          document.getElementById("send-btn").disabled = false;
          break;
        case "error":
          appendMessage("error", msg.text, false);
          document.getElementById("send-btn").disabled = false;
          break;
        case "thinking":
          if (msg.active) showThinking();
          else removeThinking();
          break;
      }
    });

    // ── Init ──────────────────────────────────────────────────────────────────

    buildHints();

    const state = vscodeApi.getState() || {};
    if (state.messages) restoreMessages(state.messages);

    vscodeApi.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}
