import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { spawn, ChildProcess } from "child_process";
import { getApiKey } from "./envHelper";

export interface LamiaResponse {
  type: "response" | "error" | "ready";
  text?: string;
  message?: string;
  model?: string;
  tokens?: { input: number; output: number; total: number };
}

type PendingRequest = {
  resolve: (value: LamiaResponse) => void;
  reject: (err: Error) => void;
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

  constructor(
    private readonly _cliPath: string,
    private readonly _cwd: string,
    private readonly _logFile: string
  ) {
    this._readyPromise = new Promise((resolve) => {
      this._onReady = resolve;
    });
    this._spawn();
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

    this._proc = spawn(
      this._cliPath,
      ["--json", "--log-level", "DEBUG", "--log-file", this._logFile],
      { cwd: this._cwd, env: envVars, stdio: ["pipe", "pipe", "pipe"] }
    );

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

  async send(text: string, system?: string): Promise<LamiaResponse> {
    if (this._disposed) throw new Error("LamiaProcess is disposed");

    if (!this._ready) await this._readyPromise;

    const request: Record<string, string> = { text };
    if (system) request.system = system;

    return new Promise<LamiaResponse>((resolve, reject) => {
      this._queue.push({ resolve, reject });
      try {
        this._proc!.stdin!.write(JSON.stringify(request) + "\n", "utf8");
      } catch (err: any) {
        this._queue.pop();
        reject(new Error(`Failed to write to lamia stdin: ${err.message}`));
      }
    });
  }

  get ready(): boolean {
    return this._ready;
  }

  restart(): void {
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

  static resolveWorkingDir(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      const root = folders[0].uri.fsPath;
      if (fs.existsSync(path.join(root, "config.yaml"))) {
        return root;
      }
    }
    fs.mkdirSync(LAMIA_HOME, { recursive: true });
    return LAMIA_HOME;
  }

  static resolveLogFile(): string {
    const logsDir = path.join(LAMIA_HOME, "ide", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    return path.join(logsDir, "lamia-chat.log");
  }
}
