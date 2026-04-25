import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { ChildProcess, spawn, execFileSync } from "child_process";
import { EventEmitter } from "events";

export interface RuntimeStoppedEvent {
  reason: "entry" | "breakpoint" | "step" | "pause";
  line: number;
  file: string;
}

export interface RuntimeOutputEvent {
  category: "stdout" | "stderr";
  text: string;
}

export interface RuntimeVariable {
  name: string;
  value: string;
  type: string;
}

export interface RuntimeStackFrame {
  name: string;
  file: string;
  line: number;
}

/**
 * Manages the `lamia debug <file> --json` child process.
 *
 * The debug logic lives entirely in the Lamia engine
 * (`lamia.cli.debug_runner`).  This class only handles spawning the
 * process and translating JSON-lines messages to/from TypeScript events.
 */
export class LamiaDebugRuntime extends EventEmitter {
  private _proc: ChildProcess | null = null;
  private _buffer = "";
  private _pendingResponses = new Map<
    string,
    (body: Record<string, unknown>) => void
  >();

  start(program: string, cwd: string, _stopOnEntry: boolean): void {
    const lamiaCli = this._resolveLamiaCli();

    const env: Record<string, string> = Object.fromEntries(
      Object.entries(process.env).filter(
        (e): e is [string, string] => e[1] !== undefined,
      ),
    );

    const venvBin = path.join(
      os.homedir(),
      ".lamia",
      "venv",
      process.platform === "win32" ? "Scripts" : "bin",
    );
    if (fs.existsSync(venvBin)) {
      env.PATH = `${venvBin}${path.delimiter}${env.PATH ?? ""}`;
      env.VIRTUAL_ENV = path.join(os.homedir(), ".lamia", "venv");
    }

    this.emit("output", "console", `Launching: ${lamiaCli} debug "${program}" --json\n`);

    this._proc = spawn(lamiaCli, ["debug", program, "--json"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this._proc.stdout!.on("data", (chunk: Buffer) =>
      this._onData(chunk.toString("utf8")),
    );
    this._proc.stderr!.on("data", (chunk: Buffer) => {
      this.emit("output", "stderr", chunk.toString("utf8"));
    });
    this._proc.on("exit", (code) => {
      this._proc = null;
      this._rejectPending("Process exited");
      this.emit("terminated", code ?? 0);
    });
    this._proc.on("error", (err) => {
      this.emit("output", "stderr", `Failed to start debugger: ${err.message}\n`);
      this._rejectPending(err.message);
      this.emit("terminated", 1);
    });
  }

  // ── protocol I/O ─────────────────────────────────────────────────

  private _onData(raw: string): void {
    this._buffer += raw;
    let nl: number;
    while ((nl = this._buffer.indexOf("\n")) !== -1) {
      const line = this._buffer.slice(0, nl).trim();
      this._buffer = this._buffer.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this._dispatch(msg);
    }
  }

  private _dispatch(msg: Record<string, unknown>): void {
    if (msg.type === "event") {
      switch (msg.event) {
        case "initialized":
          this.emit("initialized");
          break;
        case "stopped":
          this.emit("stopped", {
            reason: msg.reason as RuntimeStoppedEvent["reason"],
            line: msg.line as number,
            file: msg.file as string,
          } satisfies RuntimeStoppedEvent);
          break;
        case "output":
          this.emit("output", msg.category as string, msg.text as string);
          break;
        case "terminated":
          this.emit("terminated", (msg.exitCode as number) ?? 0);
          break;
      }
    } else if (msg.type === "response") {
      const cmd = msg.command as string;
      const cb = this._pendingResponses.get(cmd);
      if (cb) {
        this._pendingResponses.delete(cmd);
        cb(msg);
      }
    }
  }

  private _send(obj: Record<string, unknown>): void {
    if (!this._proc?.stdin?.writable) return;
    this._proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  private _request(
    obj: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!this._proc?.stdin?.writable) {
        reject(new Error("Runtime not running"));
        return;
      }
      this._pendingResponses.set(obj.command as string, resolve);
      this._send(obj);
    });
  }

  private _rejectPending(reason: string): void {
    for (const cb of this._pendingResponses.values()) {
      cb({ error: reason });
    }
    this._pendingResponses.clear();
  }

  // ── public commands ──────────────────────────────────────────────

  continue(): void {
    this._send({ command: "continue" });
  }
  next(): void {
    this._send({ command: "next" });
  }
  stepIn(): void {
    this._send({ command: "stepIn" });
  }
  stepOut(): void {
    this._send({ command: "stepOut" });
  }
  pause(): void {
    this._send({ command: "pause" });
  }

  setBreakpointsFireAndForget(file: string, lines: number[]): void {
    this._send({ command: "setBreakpoints", file, lines });
  }

  async setBreakpoints(file: string, lines: number[]): Promise<number[]> {
    const resp = await this._request({
      command: "setBreakpoints",
      file,
      lines,
    });
    return (resp.breakpoints as number[]) ?? [];
  }

  async getVariables(): Promise<RuntimeVariable[]> {
    const resp = await this._request({ command: "getVariables" });
    return (resp.variables as RuntimeVariable[]) ?? [];
  }

  async getStackTrace(): Promise<RuntimeStackFrame[]> {
    const resp = await this._request({ command: "getStackTrace" });
    return (resp.frames as RuntimeStackFrame[]) ?? [];
  }

  async evaluate(
    expression: string,
  ): Promise<{ value?: string; type?: string; error?: string }> {
    const resp = await this._request({ command: "evaluate", expression });
    const result = resp.result as Record<string, string> | undefined;
    return result ?? { error: "no response" };
  }

  disconnect(): void {
    this._send({ command: "disconnect" });
    setTimeout(() => {
      if (this._proc) {
        this._proc.kill("SIGTERM");
        this._proc = null;
      }
    }, 2000);
  }

  // ── helpers ──────────────────────────────────────────────────────

  /**
   * Find the `lamia` CLI executable.
   * Strategy:
   *  1. Check ~/.lamia/venv/bin/lamia
   *  2. Check PATH via `which lamia`
   *  3. Fall back to bare "lamia" (let the OS resolve it)
   */
  private _resolveLamiaCli(): string {
    const venvLamia = path.join(
      os.homedir(),
      ".lamia",
      "venv",
      process.platform === "win32" ? "Scripts" : "bin",
      process.platform === "win32" ? "lamia.exe" : "lamia",
    );
    if (fs.existsSync(venvLamia)) return venvLamia;

    try {
      const resolved = execFileSync("which", ["lamia"], {
        encoding: "utf8",
        timeout: 3000,
      }).trim();
      if (resolved && fs.existsSync(resolved)) return resolved;
    } catch {
      // `which` not found or lamia not on PATH
    }

    return "lamia";
  }
}
