import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { spawn, ChildProcess } from "child_process";
import { getApiKey } from "./envHelper";
import { ensureLamia } from "./lamiaInstaller";

export interface FileWrite {
  path: string;
  action: "create" | "modify" | "delete";
  content?: string;
  original?: string;
}

export type LLMErrorType = "auth" | "rate_limit" | "quota" | "timeout" | "network" | "provider";

export interface LamiaResponse {
  type: "response" | "error" | "ready";
  text?: string;
  message?: string;
  error_type?: LLMErrorType;
  status?: number;
  model?: string;
  tokens?: { input: number; output: number; total: number };
  files?: FileWrite[];
}

type ToolRequestHandler = (tool: string, args: Record<string, unknown>) => Promise<{ result: string; success: boolean }>;

type PendingRequest = {
  resolve: (value: LamiaResponse) => void;
  reject: (err: Error) => void;
  onToolUse?: (tool: string, args: Record<string, unknown>, label: string) => void;
  onToolResult?: (tool: string, success: boolean, error?: string) => void;
};

const LAMIA_HOME = path.join(os.homedir(), ".lamia");

export class LamiaProcess {
  private _proc: ChildProcess | null = null;
  private _queue: PendingRequest[] = [];
  private _buffer = "";
  private _ready = false;
  private _onReady: (() => void) | null = null;
  private _readyPromise: Promise<void>;
  private _disposed = false;
  private _cwd: string;
  public toolRequestHandler: ToolRequestHandler | null = null;

  constructor(
    private _cliPath: string,
    cwd: string,
    private readonly _logFile: string,
    private _configPath?: string
  ) {
    this._cwd = cwd;
    this._readyPromise = new Promise((resolve) => {
      this._onReady = resolve;
    });
    this._spawn();
  }

  get cwd(): string {
    return this._cwd;
  }

  private _spawn(): void {
    if (this._disposed) return;

    const envVars: Record<string, string> = Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)
    );

    const keyMap: Record<string, string> = {
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
    };
    for (const [provider, envKey] of Object.entries(keyMap)) {
      const key = getApiKey(provider);
      if (key) envVars[envKey] = key;
    }

    fs.mkdirSync(path.dirname(this._logFile), { recursive: true });

    const args = ["--json", "--log-level", "DEBUG", "--log-file", this._logFile];
    if (this._configPath) {
      args.push("--config", this._configPath);
    }

    this._proc = spawn(this._cliPath, args, {
      cwd: this._cwd,
      env: envVars,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this._proc.stdout!.on("data", (chunk: Buffer) => this._onData(chunk));
    this._proc.stderr!.on("data", () => {});
    this._proc.on("exit", (code) => this._onExit(code));
    this._proc.on("error", (err) => this._onError(err));
  }

  private _onData(chunk: Buffer): void {
    this._buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = this._buffer.indexOf("\n")) !== -1) {
      const line = this._buffer.slice(0, nl).trim();
      this._buffer = this._buffer.slice(nl + 1);
      if (!line) continue;

      let msg: LamiaResponse;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      if (msg.type === "ready") {
        this._ready = true;
        if (this._onReady) {
          this._onReady();
          this._onReady = null;
        }
        continue;
      }

      if ((msg as any).type === "tool_request") {
        const t = msg as any;
        this._handleToolRequest(t.tool ?? "", t.args ?? {});
        continue;
      }

      if ((msg as any).type === "tool_use") {
        try {
          const head = this._queue[0];
          if (head?.onToolUse) {
            const t = msg as any;
            head.onToolUse(t.tool ?? "", t.args ?? {}, t.label ?? "");
          }
        } catch { /* keep processing remaining lines */ }
        continue;
      }

      if ((msg as any).type === "tool_result") {
        try {
          const head = this._queue[0];
          if (head?.onToolResult) {
            const t = msg as any;
            head.onToolResult(t.tool ?? "", t.success !== false, t.error);
          }
        } catch { /* keep processing remaining lines */ }
        continue;
      }

      const pending = this._queue.shift();
      if (pending) pending.resolve(msg);
    }
  }

  private _onExit(code: number | null): void {
    this._proc = null;
    this._ready = false;

    const pending = this._queue.splice(0);
    for (const p of pending) {
      p.reject(new Error(`lamia process exited (code ${code})`));
    }

    if (!this._disposed) {
      setTimeout(() => this._spawn(), 1000);
    }
  }

  private _onError(err: Error): void {
    const pending = this._queue.splice(0);
    for (const p of pending) {
      p.reject(new Error(`lamia process error: ${err.message}`));
    }
  }

  private _handleToolRequest(tool: string, args: Record<string, unknown>): void {
    const respond = (result: string, success: boolean) => {
      if (!this._proc || !this._proc.stdin) return;
      const response = JSON.stringify({ type: "tool_response", tool, result, success });
      this._proc.stdin.write(response + "\n", "utf-8");
    };

    if (!this.toolRequestHandler) {
      respond(`Error: no handler registered for external tool "${tool}"`, false);
      return;
    }

    this.toolRequestHandler(tool, args).then(
      (r) => respond(r.result, r.success),
      (err) => respond(`Error: ${err.message}`, false),
    );
  }

  async send(
    text: string,
    options?: {
      system?: string;
      files?: string[];
      messages?: { role: string; text: string }[];
      onToolUse?: (tool: string, args: Record<string, unknown>, label: string) => void;
      onToolResult?: (tool: string, success: boolean, error?: string) => void;
    },
  ): Promise<LamiaResponse> {
    if (this._disposed) throw new Error("LamiaProcess is disposed");

    const timeoutMs = this._requestTimeoutMs();
    const hasTimeout = timeoutMs > 0;

    if (!this._ready) {
      try {
        await this._waitForReady(timeoutMs);
      } catch (err) {
        this.restart();
        throw err;
      }
    }

    const request: Record<string, unknown> = { text };
    if (options?.system) request.system = options.system;
    if (options?.files && options.files.length > 0) request.files = options.files;
    if (options?.messages && options.messages.length > 0) request.messages = options.messages;

    return new Promise<LamiaResponse>((resolve, reject) => {
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | null = null;

      const pending: PendingRequest = {
        resolve: (value) => {
          if (settled) return;
          settled = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          resolve(value);
        },
        reject: (err) => {
          if (settled) return;
          settled = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          reject(err);
        },
        onToolUse: options?.onToolUse,
        onToolResult: options?.onToolResult,
      };

      this._queue.push(pending);

      if (hasTimeout) {
        timeoutHandle = setTimeout(() => {
          if (settled) return;
          settled = true;
          const idx = this._queue.indexOf(pending);
          if (idx >= 0) this._queue.splice(idx, 1);
          this.restart();
          reject(
            new Error(
              `Lamia request timed out after ${timeoutMs}ms. `
              + `If this keeps happening, check ${this._logFile} for details.`
            )
          );
        }, timeoutMs);
      }

      try {
        this._proc!.stdin!.write(JSON.stringify(request) + "\n", "utf8");
      } catch (err: any) {
        if (!settled) {
          settled = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          const idx = this._queue.indexOf(pending);
          if (idx >= 0) this._queue.splice(idx, 1);
          reject(new Error(`Failed to write to lamia stdin: ${err.message}`));
        }
      }
    });
  }

  get ready(): boolean {
    return this._ready;
  }

  abort(): void {
    const pending = this._queue.splice(0);
    for (const p of pending) {
      p.reject(new Error("Aborted"));
    }
    this.restart();
  }

  restart(newCwd?: string): void {
    if (newCwd) this._cwd = newCwd;
    if (this._proc) {
      this._proc.kill("SIGTERM");
      this._proc = null;
    }
    this._ready = false;
    this._readyPromise = new Promise((resolve) => {
      this._onReady = resolve;
    });
    this._spawn();
  }

  updateCliPath(newPath: string): void {
    this._cliPath = newPath;
  }

  dispose(): void {
    this._disposed = true;
    if (this._proc) {
      this._proc.kill("SIGTERM");
      this._proc = null;
    }
    const pending = this._queue.splice(0);
    for (const p of pending) {
      p.reject(new Error("LamiaProcess disposed"));
    }
  }

  static resolveWorkingDirForFile(filePath?: string): string {
    if (filePath) {
      const projectRoot = findNearestConfigDir(filePath);
      if (projectRoot) return projectRoot;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      const root = folders[0].uri.fsPath;
      if (fs.existsSync(path.join(root, "config.yaml"))) {
        return root;
      }
      const sub = findFirstConfigInTree(root, 3);
      if (sub) return sub;
    }

    fs.mkdirSync(LAMIA_HOME, { recursive: true });
    return LAMIA_HOME;
  }

  static resolveLogFile(): string {
    const logsDir = path.join(LAMIA_HOME, "ide", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    return path.join(logsDir, "lamia-chat.log");
  }

  static async resolveCliPath(): Promise<string> {
    const config = vscode.workspace.getConfiguration("lamia");
    const userPath = config.get<string>("cliPath", "");
    if (userPath) return userPath;

    return ensureLamia();
  }

  private _requestTimeoutMs(): number {
    const configured = vscode.workspace.getConfiguration("lamia").get<number>("chat.timeoutMs", 300000);
    if (typeof configured !== "number" || !Number.isFinite(configured)) {
      return 300000;
    }
    return Math.max(0, Math.floor(configured));
  }

  private async _waitForReady(timeoutMs: number): Promise<void> {
    if (this._ready) return;
    if (timeoutMs <= 0) {
      await this._readyPromise;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Lamia CLI did not become ready within ${timeoutMs}ms. `
            + `Check ${this._logFile} for startup errors.`
          )
        );
      }, timeoutMs);

      this._readyPromise.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }
}

function findNearestConfigDir(filePath: string): string | null {
  let dir = path.dirname(filePath);
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, "config.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function findFirstConfigInTree(root: string, maxDepth: number): string | null {
  if (maxDepth < 0) return null;
  if (fs.existsSync(path.join(root, "config.yaml"))) return root;

  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "__pycache__") continue;
      const found = findFirstConfigInTree(path.join(root, entry.name), maxDepth - 1);
      if (found) return found;
    }
  } catch {}
  return null;
}
