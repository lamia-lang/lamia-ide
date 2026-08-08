import { describe, it, expect, vi, beforeEach } from "vitest";

const mockStart = vi.fn();

vi.mock("./lamiaDebugRuntime", () => ({
  LamiaDebugRuntime: class {
    start = mockStart;
    on = vi.fn();
    disconnect = vi.fn();
    configurationDone = vi.fn();
    continue = vi.fn();
    next = vi.fn();
    stepIn = vi.fn();
    stepOut = vi.fn();
    pause = vi.fn();
    setBreakpointsFireAndForget = vi.fn();
    getStackTrace = vi.fn().mockResolvedValue([]);
    getVariables = vi.fn().mockResolvedValue([]);
    evaluate = vi.fn().mockResolvedValue({ value: "", type: "" });
  },
}));

vi.mock("vscode", () => ({
  EventEmitter: class {
    private _listeners: Array<(data: unknown) => void> = [];
    fire = (data: unknown): void => {
      for (const listener of this._listeners) {
        listener(data);
      }
    };
    event = (listener: (data: unknown) => void) => {
      this._listeners.push(listener);
      return { dispose: vi.fn() };
    };
    dispose = vi.fn();
  },
}));

import { LamiaDebugSession } from "./lamiaDebugSession";

function dapRequest(
  seq: number,
  command: string,
  args?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    seq,
    type: "request",
    command,
    arguments: args,
  };
}

describe("LamiaDebugSession launch stopOnEntry", () => {
  let session: LamiaDebugSession;

  beforeEach(() => {
    vi.clearAllMocks();
    session = new LamiaDebugSession();
  });

  function launchAndConfigure(
    launchArgs: Record<string, unknown>,
  ): void {
    session.handleMessage(dapRequest(1, "initialize") as never);
    session.handleMessage(dapRequest(2, "launch", launchArgs) as never);
    session.handleMessage(
      dapRequest(3, "setBreakpoints", {
        source: { path: launchArgs.program },
        breakpoints: [],
      }) as never,
    );
    session.handleMessage(dapRequest(4, "configurationDone") as never);
  }

  it("passes stopOnEntry true to runtime.start when launch args set it", () => {
    launchAndConfigure({
      program: "/tmp/test.lm",
      cwd: "/tmp",
      stopOnEntry: true,
    });

    expect(mockStart).toHaveBeenCalledWith(
      "/tmp/test.lm",
      "/tmp",
      true,
      expect.any(Map),
    );
  });

  it("defaults stopOnEntry to false when launch args omit it", () => {
    launchAndConfigure({
      program: "/tmp/test.lm",
    });

    expect(mockStart).toHaveBeenCalledWith(
      "/tmp/test.lm",
      "/tmp",
      false,
      expect.any(Map),
    );
  });
});
