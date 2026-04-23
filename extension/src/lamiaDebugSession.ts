import * as vscode from "vscode";
import * as path from "path";
import {
  LamiaDebugRuntime,
  RuntimeStoppedEvent,
  RuntimeVariable,
  RuntimeStackFrame,
} from "./lamiaDebugRuntime";

const THREAD_ID = 1;

interface DapMessage {
  seq: number;
  type: string;
  command?: string;
  arguments?: Record<string, unknown>;
  request_seq?: number;
  success?: boolean;
  body?: unknown;
  event?: string;
}

/**
 * Inline DAP adapter.
 *
 * DAP sequencing:
 *   initialize → launch → setBreakpoints → configurationDone
 *
 * We respond to launch/setBreakpoints immediately (storing state locally)
 * and only spawn the Python wrapper in configurationDone, once we know
 * all breakpoints.  When the wrapper sends its "initialized" event we
 * push the stored breakpoints and issue the initial step/continue.
 */
export class LamiaDebugSession implements vscode.DebugAdapter {
  private _seq = 1;
  private _sendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this._sendMessage.event;

  private _runtime = new LamiaDebugRuntime();
  private _runtimeReady = false;

  private _launchProgram = "";
  private _launchCwd = "";
  private _stopOnEntry = true;

  private _pendingBp = new Map<string, number[]>();

  handleMessage(raw: vscode.DebugProtocolMessage): void {
    const msg = raw as unknown as DapMessage;
    if (msg.type === "request") {
      this._handleRequest(msg);
    }
  }

  dispose(): void {
    this._runtime.disconnect();
    this._sendMessage.dispose();
  }

  // ── DAP request dispatcher ───────────────────────────────────────

  private _handleRequest(msg: DapMessage): void {
    const args = msg.arguments ?? {};
    switch (msg.command) {
      case "initialize":
        this._onInitialize(msg);
        break;
      case "launch":
        this._onLaunch(msg, args);
        break;
      case "setBreakpoints":
        this._onSetBreakpoints(msg, args);
        break;
      case "configurationDone":
        this._onConfigurationDone(msg);
        break;
      case "threads":
        this._respond(msg, {
          threads: [{ id: THREAD_ID, name: "Main" }],
        });
        break;
      case "stackTrace":
        this._onStackTrace(msg);
        break;
      case "scopes":
        this._onScopes(msg);
        break;
      case "variables":
        this._onVariables(msg);
        break;
      case "continue":
        this._runtime.continue();
        this._respond(msg, { allThreadsContinued: true });
        break;
      case "next":
        this._runtime.next();
        this._respond(msg, {});
        break;
      case "stepIn":
        this._runtime.stepIn();
        this._respond(msg, {});
        break;
      case "stepOut":
        this._runtime.stepOut();
        this._respond(msg, {});
        break;
      case "pause":
        this._runtime.pause();
        this._respond(msg, {});
        break;
      case "evaluate":
        this._onEvaluate(msg, args);
        break;
      case "disconnect":
        this._runtime.disconnect();
        this._respond(msg, {});
        break;
      case "setExceptionBreakpoints":
        this._respond(msg, {});
        break;
      default:
        this._respond(msg, {});
    }
  }

  // ── DAP handlers ─────────────────────────────────────────────────

  private _onInitialize(msg: DapMessage): void {
    this._wireRuntimeEvents();
    this._respond(msg, {
      supportsConfigurationDoneRequest: true,
      supportsFunctionBreakpoints: false,
      supportsConditionalBreakpoints: false,
      supportsEvaluateForHovers: true,
      supportsStepBack: false,
      supportsSetVariable: false,
      supportsRestartFrame: false,
      supportsGotoTargetsRequest: false,
      supportsStepInTargetsRequest: false,
      supportsCompletionsRequest: false,
      supportsTerminateRequest: false,
    });
    this._event("initialized", {});
  }

  private _onLaunch(
    msg: DapMessage,
    args: Record<string, unknown>,
  ): void {
    this._launchProgram = args.program as string;
    this._launchCwd =
      (args.cwd as string) || path.dirname(this._launchProgram);
    this._stopOnEntry = args.stopOnEntry !== false;
    this._respond(msg, {});
  }

  private _onSetBreakpoints(
    msg: DapMessage,
    args: Record<string, unknown>,
  ): void {
    const source = args.source as { path?: string } | undefined;
    const filePath = source?.path ?? this._launchProgram;
    const bpArgs = args.breakpoints as { line: number }[] | undefined;
    const lines = bpArgs?.map((b) => b.line) ?? [];

    this._pendingBp.set(filePath, lines);

    if (this._runtimeReady) {
      this._runtime.setBreakpointsFireAndForget(filePath, lines);
    }

    this._respond(msg, {
      breakpoints: lines.map((l) => ({
        verified: true,
        line: l,
        source: { path: filePath },
      })),
    });
  }

  private _onConfigurationDone(msg: DapMessage): void {
    this._respond(msg, {});
    this._runtime.start(
      this._launchProgram,
      this._launchCwd,
      this._stopOnEntry,
    );
  }

  private async _onStackTrace(msg: DapMessage): Promise<void> {
    const frames = (await this._runtime.getStackTrace()).map((f, i) => ({
      id: i,
      name: f.name,
      source: { name: path.basename(f.file), path: f.file },
      line: f.line,
      column: 1,
    }));
    this._respond(msg, { stackFrames: frames, totalFrames: frames.length });
  }

  private _onScopes(msg: DapMessage): void {
    this._respond(msg, {
      scopes: [
        { name: "Locals", variablesReference: 1, expensive: false },
      ],
    });
  }

  private async _onVariables(msg: DapMessage): Promise<void> {
    const vars = (await this._runtime.getVariables()).map((v) => ({
      name: v.name,
      value: v.value,
      type: v.type,
      variablesReference: 0,
    }));
    this._respond(msg, { variables: vars });
  }

  private async _onEvaluate(
    msg: DapMessage,
    args: Record<string, unknown>,
  ): Promise<void> {
    const result = await this._runtime.evaluate(args.expression as string);
    this._respond(msg, {
      result: result.error ?? result.value ?? "",
      type: result.type,
      variablesReference: 0,
    });
  }

  // ── runtime event wiring ─────────────────────────────────────────

  private _wireRuntimeEvents(): void {
    this._runtime.on("initialized", () => {
      this._runtimeReady = true;
      for (const [file, lines] of this._pendingBp) {
        this._runtime.setBreakpointsFireAndForget(file, lines);
      }
      if (this._stopOnEntry) {
        this._runtime.stepIn();
      } else {
        this._runtime.continue();
      }
    });

    this._runtime.on("stopped", (ev: RuntimeStoppedEvent) => {
      this._event("stopped", {
        reason: ev.reason,
        threadId: THREAD_ID,
        allThreadsStopped: true,
      });
    });

    this._runtime.on("output", (category: string, text: string) => {
      this._event("output", { category, output: text });
    });

    this._runtime.on("terminated", () => {
      this._event("terminated", {});
    });
  }

  // ── DAP message helpers ──────────────────────────────────────────

  private _respond(request: DapMessage, body: Record<string, unknown>): void {
    this._sendMessage.fire({
      seq: this._seq++,
      type: "response",
      request_seq: request.seq,
      command: request.command,
      success: true,
      body,
    } as unknown as vscode.DebugProtocolMessage);
  }

  private _event(event: string, body: Record<string, unknown>): void {
    this._sendMessage.fire({
      seq: this._seq++,
      type: "event",
      event,
      body,
    } as unknown as vscode.DebugProtocolMessage);
  }
}
