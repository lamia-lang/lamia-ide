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
 * Manages the Python debug-wrapper child process.
 *
 * The wrapper Python source is embedded as a string constant so it ships
 * inside the compiled JS — no extra file to copy during packaging.
 */
export class LamiaDebugRuntime extends EventEmitter {
  private _proc: ChildProcess | null = null;
  private _buffer = "";
  private _pendingResponses = new Map<
    string,
    (body: Record<string, unknown>) => void
  >();

  start(program: string, cwd: string, _stopOnEntry: boolean): void {
    const pythonPath = this._resolvePython();
    const wrapperPath = this._ensureWrapper();

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

    this.emit("output", "console", `Launching: ${pythonPath} ${wrapperPath} ${program}\n`);

    this._proc = spawn(pythonPath, [wrapperPath, program], {
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
   * Find the Python interpreter that has lamia installed.
   * Strategy:
   *  1. Read the shebang from the `lamia` CLI script on PATH
   *  2. Fall back to ~/.lamia/venv/bin/python
   *  3. Fall back to python3
   */
  private _resolvePython(): string {
    const pythonFromCli = this._pythonFromLamiaCli();
    if (pythonFromCli) return pythonFromCli;

    const venvPython = path.join(
      os.homedir(),
      ".lamia",
      "venv",
      process.platform === "win32" ? "Scripts" : "bin",
      process.platform === "win32" ? "python.exe" : "python",
    );
    if (fs.existsSync(venvPython)) return venvPython;
    return process.platform === "win32" ? "python" : "python3";
  }

  /** Read the `lamia` console-script and extract the Python from its shebang. */
  private _pythonFromLamiaCli(): string | null {
    try {
      const cliPath = execFileSync("which", ["lamia"], {
        encoding: "utf8",
        timeout: 3000,
      }).trim();
      if (!cliPath || !fs.existsSync(cliPath)) return null;

      const head = fs.readFileSync(cliPath, "utf8").slice(0, 200);
      const firstLine = head.split("\n")[0];
      if (firstLine.startsWith("#!")) {
        const py = firstLine.slice(2).trim();
        if (fs.existsSync(py)) return py;
      }
    } catch {
      // `which` not found, or lamia not on PATH — that's fine
    }
    return null;
  }

  /** Write the embedded Python wrapper to ~/.lamia/ide/debugWrapper.py
   *  and return its path.  Re-writes every time so the version always
   *  matches the running extension code. */
  private _ensureWrapper(): string {
    const dir = path.join(os.homedir(), ".lamia", "ide");
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, "debugWrapper.py");
    fs.writeFileSync(dest, WRAPPER_PY, "utf8");
    return dest;
  }
}

// ── embedded Python debug wrapper ──────────────────────────────────
// Kept as a template-literal constant so it ships inside the compiled
// JS and never needs a separate file in the extension bundle.

const WRAPPER_PY = `#!/usr/bin/env python3
import sys, os, json, threading, traceback

class _ProtocolIO:
    def __init__(self):
        self._out_fd = os.dup(sys.stdout.fileno())
        self._wlock = threading.Lock()
        self._in_file = os.fdopen(os.dup(sys.stdin.fileno()), "r", encoding="utf-8")
    def send(self, obj):
        raw = json.dumps(obj, default=str) + "\\n"
        with self._wlock:
            os.write(self._out_fd, raw.encode())
    def recv(self):
        line = self._in_file.readline()
        if not line:
            return None
        return json.loads(line)

class _DebugOutputStream:
    encoding = "utf-8"
    def __init__(self, io, category):
        self._io = io
        self._category = category
    def write(self, text):
        if text:
            self._io.send({"type": "event", "event": "output",
                           "category": self._category, "text": text})
    def flush(self):
        pass
    def isatty(self):
        return False
    def fileno(self):
        raise OSError("not a real file descriptor")

def _fallback_offset_map(original_source, transformed_source):
    """Offset-based fallback when the engine returns an empty source map."""
    orig_lines = original_source.splitlines()
    trans_lines = transformed_source.splitlines()
    added = 0
    for line in trans_lines:
        s = line.strip()
        if s.startswith("from ") or s.startswith("import ") or s == "":
            added += 1
        else:
            break
    orig_imp = 0
    for line in orig_lines:
        s = line.strip()
        if s.startswith("from ") or s.startswith("import ") or s == "":
            orig_imp += 1
        else:
            break
    offset = added - orig_imp
    lmap = {}
    for i in range(len(trans_lines)):
        t = i + 1
        o = t - offset
        if 1 <= o <= len(orig_lines):
            lmap[t] = o
    return lmap

class LamiaDebugger:
    def __init__(self, file_path):
        self.file_path = os.path.abspath(file_path)
        self.breakpoints = {}
        self.step_mode = None
        self.step_depth = 0
        self.current_depth = 0
        self.current_frame = None
        self.current_line = 0
        self.line_maps = {}
        self.running = True
        self.paused = threading.Event()
        self.io = _ProtocolIO()

    def _trace(self, frame, event, arg):
        if not self.running:
            return None
        filename = os.path.abspath(frame.f_code.co_filename)
        is_ours = filename in self.line_maps
        if event == "call":
            if is_ours:
                self.current_depth += 1
            return self._trace
        if event == "return":
            if is_ours:
                self.current_depth -= 1
                if self.step_mode == "stepOut" and self.current_depth < self.step_depth:
                    self.step_mode = None
                    self._stop(frame, "step")
            return self._trace
        if event == "line" and is_ours:
            raw = frame.f_lineno
            file_map = self.line_maps.get(filename, {})
            orig = file_map.get(raw, raw)
            if orig <= 0:
                return self._trace
            should_stop = False
            reason = "step"
            bp_set = self.breakpoints.get(filename, set())
            if orig in bp_set:
                should_stop = True
                reason = "breakpoint"
            elif self.step_mode == "stepIn":
                should_stop = True
            elif self.step_mode == "next" and self.current_depth <= self.step_depth:
                should_stop = True
            elif self.step_mode == "pause":
                should_stop = True
                reason = "pause"
            if should_stop:
                self._stop(frame, reason, orig, filename)
        return self._trace

    def _stop(self, frame, reason, lineno=None, filename=None):
        self.current_frame = frame
        self.current_line = lineno or frame.f_lineno
        self.current_file = filename or self.file_path
        self.io.send({"type": "event", "event": "stopped",
                       "reason": reason,
                       "line": self.current_line,
                       "file": self.current_file})
        self.paused.clear()
        self.paused.wait()

    def _command_loop(self):
        while self.running:
            msg = self.io.recv()
            if msg is None:
                self.running = False
                self.paused.set()
                break
            cmd = msg.get("command")
            if cmd == "continue":
                self.step_mode = None
                self.paused.set()
            elif cmd == "next":
                self.step_mode = "next"
                self.step_depth = self.current_depth
                self.paused.set()
            elif cmd == "stepIn":
                self.step_mode = "stepIn"
                self.paused.set()
            elif cmd == "stepOut":
                self.step_mode = "stepOut"
                self.step_depth = self.current_depth
                self.paused.set()
            elif cmd == "pause":
                self.step_mode = "pause"
            elif cmd == "setBreakpoints":
                f = msg.get("file", self.file_path)
                self.breakpoints[os.path.abspath(f)] = set(msg.get("lines", []))
                self.io.send({"type": "response", "command": "setBreakpoints",
                              "breakpoints": sorted(self.breakpoints.get(os.path.abspath(f), []))})
            elif cmd == "getVariables":
                self.io.send({"type": "response", "command": "getVariables",
                              "variables": self._collect_variables()})
            elif cmd == "getStackTrace":
                self.io.send({"type": "response", "command": "getStackTrace",
                              "frames": self._collect_stack()})
            elif cmd == "evaluate":
                expr = msg.get("expression", "")
                self.io.send({"type": "response", "command": "evaluate",
                              "result": self._evaluate(expr)})
            elif cmd == "disconnect":
                self.running = False
                self.paused.set()
                break

    def _collect_variables(self):
        if self.current_frame is None:
            return []
        result = []
        for name, val in self.current_frame.f_locals.items():
            if name.startswith("__") and name.endswith("__"):
                continue
            try:
                result.append({"name": name, "value": repr(val)[:500], "type": type(val).__name__})
            except Exception:
                result.append({"name": name, "value": "<error>", "type": "?"})
        return result

    def _collect_stack(self):
        frames = []
        f = self.current_frame
        while f:
            fn = os.path.abspath(f.f_code.co_filename)
            if fn in self.line_maps:
                raw = f.f_lineno
                file_map = self.line_maps[fn]
                orig = file_map.get(raw, raw)
                name = f.f_code.co_name
                if name == "<module>":
                    name = os.path.basename(fn)
                frames.append({"name": name, "file": fn, "line": max(orig, 1)})
            f = f.f_back
        return frames

    def _evaluate(self, expression):
        if self.current_frame is None:
            return {"error": "No active frame"}
        try:
            merged = {**self.current_frame.f_globals, **self.current_frame.f_locals}
            val = eval(expression, merged)
            return {"value": repr(val)[:1000], "type": type(val).__name__}
        except Exception as e:
            return {"error": str(e)}

    def run(self):
        sys.stdout = _DebugOutputStream(self.io, "stdout")
        sys.stderr = _DebugOutputStream(self.io, "stderr")
        cmd_thread = threading.Thread(target=self._command_loop, daemon=True)
        cmd_thread.start()
        exit_code = 0
        try:
            self._patch_and_execute()
        except SystemExit as e:
            exit_code = e.code if isinstance(e.code, int) else 0
        except Exception:
            self.io.send({"type": "event", "event": "output",
                          "category": "stderr", "text": traceback.format_exc()})
            exit_code = 1
        finally:
            self.io.send({"type": "event", "event": "terminated",
                          "exitCode": exit_code})

    def _patch_and_execute(self):
        from lamia.interpreter.hybrid_executor import HybridExecutor
        original_execute = HybridExecutor.execute_file
        debugger = self
        main_file_resolved = os.path.abspath(debugger.file_path)
        initialized = [False]
        def patched_execute_file(executor_self, file_path, globals_dict=None,
                                 enable_lazy_dependency_loading=False):
            resolved = os.path.abspath(file_path)
            with open(resolved, "r") as f:
                original_source = f.read()
            transformed = executor_self.transform(original_source, debug=True)
            smap = executor_self.source_map
            if smap:
                debugger.line_maps[resolved] = smap
            else:
                debugger.line_maps[resolved] = _fallback_offset_map(original_source, transformed)
            fmap = debugger.line_maps[resolved]
            debugger.io.send({"type": "event", "event": "output",
                              "category": "console",
                              "text": f"[lamia-debug] source map for {os.path.basename(resolved)}: {len(fmap)} entries\\n"})
            if not initialized[0]:
                initialized[0] = True
                debugger.io.send({"type": "event", "event": "initialized"})
                debugger.paused.clear()
                debugger.paused.wait()
            old_settrace = sys.gettrace()
            threading.settrace(debugger._trace)
            sys.settrace(debugger._trace)
            try:
                original_execute(executor_self, file_path, globals_dict,
                                 enable_lazy_dependency_loading)
            finally:
                sys.settrace(old_settrace)
                threading.settrace(old_settrace)
        HybridExecutor.execute_file = patched_execute_file
        _original_exit = os._exit
        def _soft_exit(code=0):
            raise SystemExit(code)
        os._exit = _soft_exit
        try:
            sys.argv = ["lamia", self.file_path]
            from lamia.cli.cli import main as lamia_main
            lamia_main()
        finally:
            os._exit = _original_exit

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: debugWrapper.py <file.lm>"}), file=sys.__stderr__)
        sys.exit(1)
    LamiaDebugger(sys.argv[1]).run()
`;
