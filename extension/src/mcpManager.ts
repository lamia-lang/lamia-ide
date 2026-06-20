import * as vscode from "vscode";
import { spawn, ChildProcess } from "child_process";

// ── Types ────────────────────────────────────────────────────────────────────

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface McpServerInfo {
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  toolNames: string[];
  lastError?: string;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface McpToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ── Stdio Transport (newline-delimited JSON, per MCP SDK spec) ───────────────

class StdioTransport implements McpTransport {
  private _buffer = "";
  private _pending = new Map<number, { resolve: (v: JsonRpcResponse) => void; reject: (e: Error) => void }>();
  private _nextId = 1;

  constructor(private _proc: ChildProcess) {
    _proc.stdout!.on("data", (chunk: Buffer) => this._onData(chunk));
  }

  async request(method: string, params?: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    const id = this._nextId++;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method };
    if (params) msg.params = params;
    this._write(msg);

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP request ${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      this._pending.set(id, {
        resolve: (resp) => {
          clearTimeout(timer);
          if (resp.error) {
            reject(new Error(`MCP error (${resp.error.code}): ${resp.error.message}`));
          } else {
            resolve(resp.result);
          }
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    const msg: { jsonrpc: "2.0"; method: string; params?: Record<string, unknown> } = { jsonrpc: "2.0", method };
    if (params) msg.params = params;
    this._write(msg);
  }

  destroy(): void {
    for (const [, p] of this._pending) {
      p.reject(new Error("Transport destroyed"));
    }
    this._pending.clear();
  }

  private _write(msg: unknown): void {
    this._proc.stdin!.write(JSON.stringify(msg) + "\n", "utf-8");
  }

  private _onData(chunk: Buffer): void {
    this._buffer += chunk.toString("utf-8");

    let nlIndex: number;
    while ((nlIndex = this._buffer.indexOf("\n")) !== -1) {
      const line = this._buffer.slice(0, nlIndex).replace(/\r$/, "");
      this._buffer = this._buffer.slice(nlIndex + 1);
      if (!line) continue;

      try {
        const msg: JsonRpcResponse = JSON.parse(line);
        if (msg.id !== undefined && this._pending.has(msg.id)) {
          const p = this._pending.get(msg.id)!;
          this._pending.delete(msg.id);
          p.resolve(msg);
        }
      } catch { /* ignore malformed JSON */ }
    }
  }
}

// ── Streamable HTTP Transport ────────────────────────────────────────────────

class HttpTransport {
  private _nextId = 1;
  private _sessionId: string | null = null;

  constructor(
    private _url: string,
    private _headers: Record<string, string>,
  ) {}

  async request(method: string, params?: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    const id = this._nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });

    const headers: Record<string, string> = {
      ...this._headers,
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    };
    if (this._sessionId) {
      headers["Mcp-Session-Id"] = this._sessionId;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(this._url, { method: "POST", headers, body, signal: controller.signal });
      clearTimeout(timer);

      const sid = res.headers.get("mcp-session-id");
      if (sid) this._sessionId = sid;

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }

      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("text/event-stream")) {
        return this._parseSSEResponse(await res.text(), id);
      }

      const json = await res.json() as JsonRpcResponse;
      if (json.error) {
        throw new Error(`MCP error (${json.error.code}): ${json.error.message}`);
      }
      return json.result;
    } catch (err: any) {
      clearTimeout(timer);
      if (err?.name === "AbortError") {
        throw new Error(`MCP request ${method} timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw err;
    }
  }

  notify(method: string, params?: Record<string, unknown>): void {
    const body = JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
    const headers: Record<string, string> = {
      ...this._headers,
      "Content-Type": "application/json",
    };
    if (this._sessionId) {
      headers["Mcp-Session-Id"] = this._sessionId;
    }
    fetch(this._url, { method: "POST", headers, body }).catch(() => {});
  }

  destroy(): void {
    this._sessionId = null;
  }

  private _parseSSEResponse(text: string, expectedId: number): unknown {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const msg = JSON.parse(line.slice(6)) as JsonRpcResponse;
        if (msg.id === expectedId) {
          if (msg.error) {
            throw new Error(`MCP error (${msg.error.code}): ${msg.error.message}`);
          }
          return msg.result;
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("MCP error")) throw e;
      }
    }
    throw new Error("No matching response in SSE stream");
  }
}

// ── Transport interface ─────────────────────────────────────────────────────

interface McpTransport {
  request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): void;
  destroy(): void;
}

// ── Single MCP Server Connection ────────────────────────────────────────────

type ProgressCallback = (step: string) => void;

class McpConnection {
  private _proc: ChildProcess | null = null;
  private _transport: McpTransport | null = null;
  private _tools: McpToolDef[] = [];

  constructor(
    readonly name: string,
    private _config: McpServerConfig,
  ) {}

  get tools(): McpToolDef[] {
    return this._tools;
  }

  get isHttp(): boolean {
    return !!this._config.url;
  }

  async connect(onProgress?: ProgressCallback): Promise<void> {
    if (this._config.url) {
      await this._connectHttp(onProgress);
    } else {
      await this._connectStdio(onProgress);
    }
  }

  private async _connectHttp(onProgress?: ProgressCallback): Promise<void> {
    const url = this._config.url!;
    onProgress?.(`Connecting to ${new URL(url).host}...`);

    this._transport = new HttpTransport(url, this._config.headers ?? {});

    await this._transport.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "lamia-ide", version: "1.0.0" },
    }, 15_000);

    this._transport.notify("notifications/initialized");

    onProgress?.("Loading tools...");
    const listResult = await this._transport.request("tools/list", {}) as { tools: McpToolDef[] };
    this._tools = listResult.tools ?? [];
  }

  private async _connectStdio(onProgress?: ProgressCallback): Promise<void> {
    const command = this._config.command ?? "";
    const args = this._config.args ?? [];
    const isNpx = command === "npx" || command.endsWith("/npx");
    const label = args[0] || command;

    onProgress?.(isNpx ? `Installing ${label}...` : `Starting ${label}...`);

    const env: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)
      ),
      ...this._config.env,
    };

    this._proc = spawn(command, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stderrChunks: string[] = [];
    this._proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8").trim();
      if (text) stderrChunks.push(text);
    });
    this._proc.on("error", (err) => {
      console.error(`MCP "${this.name}" process error: ${err.message}`);
      this._transport?.destroy();
      this._transport = null;
    });
    this._proc.on("exit", (code) => {
      if (code !== null && code !== 0) {
        console.error(`MCP "${this.name}" exited with code ${code}: ${stderrChunks.slice(-5).join("\n")}`);
      }
      this._transport?.destroy();
      this._transport = null;
      this._proc = null;
    });

    this._transport = new StdioTransport(this._proc);

    onProgress?.("Waiting for server handshake...");
    const timeoutMs = isNpx ? 120_000 : 60_000;

    try {
      await this._transport.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "lamia-ide", version: "1.0.0" },
      }, timeoutMs);
    } catch (err: any) {
      const stderr = stderrChunks.slice(-5).join("\n");
      const detail = stderr ? `${err.message}\nstderr: ${stderr}` : err.message;
      throw new Error(detail);
    }

    this._transport.notify("notifications/initialized");

    onProgress?.("Loading tools...");
    const listResult = await this._transport.request("tools/list", {}) as { tools: McpToolDef[] };
    this._tools = listResult.tools ?? [];
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<{ result: string; success: boolean }> {
    if (!this._transport) {
      return { result: "Error: MCP server not connected", success: false };
    }

    try {
      const response = await this._transport.request("tools/call", {
        name: toolName,
        arguments: args,
      }) as McpToolResult;

      const text = (response.content ?? [])
        .filter(c => c.type === "text" && c.text)
        .map(c => c.text)
        .join("\n");

      return {
        result: text || "(empty result)",
        success: !response.isError,
      };
    } catch (err: any) {
      return { result: `Error: ${err.message}`, success: false };
    }
  }

  dispose(): void {
    this._transport?.destroy();
    this._transport = null;
    if (this._proc && !this._proc.killed) {
      this._proc.kill("SIGTERM");
    }
    this._proc = null;
    this._tools = [];
  }
}

// ── MCP Manager (manages all server connections) ─────────────────────────────

export class McpManager {
  private _connections = new Map<string, McpConnection>();
  private _toolIndex = new Map<string, string>();
  private _serverErrors = new Map<string, string>();
  private _reloadInFlight: Promise<void> | null = null;

  async initialize(onProgress?: (serverName: string, step: string) => void): Promise<void> {
    const configs = this._readConfigs();
    if (Object.keys(configs).length === 0) return;

    for (const [name, config] of Object.entries(configs)) {
      if (config.enabled === false) continue;
      try {
        const conn = new McpConnection(name, config);
        await conn.connect((step) => onProgress?.(name, step));
        this._connections.set(name, conn);
        this._serverErrors.delete(name);

        for (const tool of conn.tools) {
          this._toolIndex.set(tool.name, name);
        }

        console.log(`MCP server "${name}" connected with ${conn.tools.length} tools`);
      } catch (err: any) {
        console.error(`MCP server "${name}" failed: ${err.message}`);
        this._serverErrors.set(name, String(err?.message ?? "Unknown MCP error"));
        vscode.window.showWarningMessage(
          `Lamia: MCP server "${name}" failed to start: ${err.message}`
        );
      }
    }
  }

  getServerList(): McpServerInfo[] {
    const configs = this._readConfigs();
    return Object.entries(configs).map(([name, config]) => {
      const conn = this._connections.get(name);
      return {
        name,
        config,
        enabled: config.enabled !== false,
        connected: !!conn,
        toolCount: conn?.tools.length ?? 0,
        toolNames: conn?.tools.map(t => t.name) ?? [],
        lastError: this._serverErrors.get(name),
      };
    });
  }

  async saveServer(name: string, config: McpServerConfig, oldName?: string): Promise<void> {
    const allConfigs = this._readConfigs();
    const previousName = oldName?.trim();
    const incomingName = name.trim();
    if (!incomingName) {
      throw new Error("Server name cannot be empty");
    }
    const existingTarget = allConfigs[incomingName];
    const existingSource = previousName ? allConfigs[previousName] : undefined;
    const merged: McpServerConfig = {
      ...config,
      enabled: config.enabled ?? existingTarget?.enabled ?? existingSource?.enabled ?? true,
    };

    if (previousName && previousName !== incomingName) {
      delete allConfigs[previousName];
    }
    allConfigs[incomingName] = merged;

    if (previousName && previousName !== incomingName) {
      const oldConn = this._connections.get(previousName);
      if (oldConn) {
        oldConn.dispose();
        this._connections.delete(previousName);
      }
    }
    await vscode.workspace.getConfiguration("lamia").update(
      "mcp.servers", allConfigs, vscode.ConfigurationTarget.Global
    );
  }

  async deleteServer(name: string): Promise<void> {
    const allConfigs = this._readConfigs();
    const normalizedName = name.trim();
    delete allConfigs[normalizedName];
    this._serverErrors.delete(normalizedName);
    const conn = this._connections.get(normalizedName);
    if (conn) {
      conn.dispose();
      this._connections.delete(normalizedName);
    }
    await vscode.workspace.getConfiguration("lamia").update(
      "mcp.servers", allConfigs, vscode.ConfigurationTarget.Global
    );
  }

  async toggleServer(name: string, enabled: boolean): Promise<void> {
    const allConfigs = this._readConfigs();
    const normalizedName = name.trim();
    const config = allConfigs[normalizedName];
    if (!config) return;
    config.enabled = enabled;
    await vscode.workspace.getConfiguration("lamia").update(
      "mcp.servers", allConfigs, vscode.ConfigurationTarget.Global
    );
  }

  hasTool(toolName: string): boolean {
    return this._toolIndex.has(toolName);
  }

  getAllTools(): McpToolDef[] {
    const all: McpToolDef[] = [];
    for (const conn of this._connections.values()) {
      all.push(...conn.tools);
    }
    return all;
  }

  getToolDefinitionsForPrompt(): string {
    const tools = this.getAllTools();

    const setupGuide =
      "MCP (Model Context Protocol) servers extend the chat with additional tools. " +
      "To configure MCP servers, go to Lamia settings > MCP section.\n" +
      "Two transport types supported:\n" +
      "  Stdio (local): {\"command\": \"npx\", \"args\": [\"@playwright/mcp@latest\"]}\n" +
      "  HTTP (remote): {\"url\": \"https://mcp.example.com/mcp\", \"headers\": {\"Authorization\": \"Bearer ...\"}}\n" +
      "Popular MCP servers: @playwright/mcp, @modelcontextprotocol/server-github, @modelcontextprotocol/server-filesystem.\n" +
      "Prerequisites: Node.js 18+ for npx-based servers.\n" +
      "Full docs: https://lamia-lang.github.io/lamia-ide/configuration/mcp-servers/.";

    if (tools.length === 0) {
      return "\n\n" + setupGuide + "\nNo MCP servers are currently configured.";
    }

    const lines = tools.map(t => {
      const params = Object.keys(t.inputSchema?.properties as Record<string, unknown> ?? {}).join(", ");
      return `- ${t.name}(${params}): ${t.description}`;
    });

    const serverNames = [...this._connections.keys()].join(", ");
    return (
      "\n\n" + setupGuide +
      `\n\nMCP servers connected: ${serverNames}\n` +
      "Available MCP tools (use Lamia built-in tools first; use MCP tools when built-in tools can't accomplish the task):\n" +
      lines.join("\n")
    );
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<{ result: string; success: boolean }> {
    const serverName = this._toolIndex.get(toolName);
    if (!serverName) {
      return { result: `Error: no MCP server provides tool "${toolName}"`, success: false };
    }
    const conn = this._connections.get(serverName);
    if (!conn) {
      return { result: `Error: MCP server "${serverName}" not connected`, success: false };
    }
    return conn.callTool(toolName, args);
  }

  async reload(onProgress?: (serverName: string, step: string) => void): Promise<void> {
    if (this._reloadInFlight) {
      await this._reloadInFlight;
      return;
    }
    this._reloadInFlight = (async () => {
      this.dispose();
      this._connections.clear();
      this._toolIndex.clear();
      await this.initialize(onProgress);
    })();
    try {
      await this._reloadInFlight;
    } finally {
      this._reloadInFlight = null;
    }
  }

  dispose(): void {
    for (const conn of this._connections.values()) {
      conn.dispose();
    }
    this._connections.clear();
    this._toolIndex.clear();
  }

  private _readConfigs(): Record<string, McpServerConfig> {
    const config = vscode.workspace.getConfiguration("lamia");
    const raw = config.get<Record<string, McpServerConfig>>("mcp.servers", {});
    return this._cloneConfigs(raw);
  }

  private _cloneConfigs(raw: Record<string, McpServerConfig> | undefined): Record<string, McpServerConfig> {
    if (!raw || typeof raw !== "object") {
      return {};
    }
    try {
      return JSON.parse(JSON.stringify(raw));
    } catch {
      const clone: Record<string, McpServerConfig> = {};
      for (const [name, cfg] of Object.entries(raw)) {
        if (!cfg || typeof cfg !== "object") {
          continue;
        }
        clone[name] = {
          command: cfg.command ? String(cfg.command) : undefined,
          args: Array.isArray(cfg.args) ? [...cfg.args] : undefined,
          env: cfg.env ? { ...cfg.env } : undefined,
          url: cfg.url ? String(cfg.url) : undefined,
          headers: cfg.headers ? { ...cfg.headers } : undefined,
          enabled: cfg.enabled,
        };
      }
      return clone;
    }
  }
}
