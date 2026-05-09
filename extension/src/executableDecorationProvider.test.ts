import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("./lamiaDebugRuntime", () => ({
  resolveLamiaCli: () => "/usr/bin/lamia",
}));

vi.mock("vscode", () => ({
  EventEmitter: class {
    fire = vi.fn();
    event = vi.fn();
  },
  FileDecoration: class {
    constructor(public badge: string, public tooltip: string) {}
  },
  workspace: {
    textDocuments: [],
  },
  Uri: {
    file: (p: string) => ({ fsPath: p }),
  },
}));

import { LamiaExecutableDecorationProvider } from "./executableDecorationProvider";
import { execFile } from "child_process";

const mockExecFile = vi.mocked(execFile);

describe("LamiaExecutableDecorationProvider", () => {
  let provider: LamiaExecutableDecorationProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    provider = new LamiaExecutableDecorationProvider();
  });

  it("returns undefined for non-.lm files", () => {
    const uri = { fsPath: "/tmp/foo.py" } as any;
    expect(provider.provideFileDecoration(uri)).toBeUndefined();
  });

  it("returns undefined on first call and schedules batch", () => {
    const uri = { fsPath: "/tmp/test.lm" } as any;
    const result = provider.provideFileDecoration(uri);
    expect(result).toBeUndefined();
    expect(mockExecFile).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile).toHaveBeenCalledWith(
      "/usr/bin/lamia",
      ["inspect", "/tmp/test.lm", "--json"],
      { timeout: 30_000, maxBuffer: 10485760 },
      expect.any(Function),
    );
  });

  it("batches multiple files into a single call", () => {
    provider.provideFileDecoration({ fsPath: "/tmp/a.lm" } as any);
    provider.provideFileDecoration({ fsPath: "/tmp/b.lm" } as any);
    provider.provideFileDecoration({ fsPath: "/tmp/c.lm" } as any);
    vi.advanceTimersByTime(50);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile).toHaveBeenCalledWith(
      "/usr/bin/lamia",
      ["inspect", "/tmp/a.lm", "/tmp/b.lm", "/tmp/c.lm", "--json"],
      expect.anything(),
      expect.any(Function),
    );
  });

  it("does not duplicate pending requests for same file", () => {
    const uri = { fsPath: "/tmp/dup.lm" } as any;
    provider.provideFileDecoration(uri);
    provider.provideFileDecoration(uri);
    vi.advanceTimersByTime(50);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const args = mockExecFile.mock.calls[0][1] as string[];
    const fileArgs = args.filter(a => a.endsWith(".lm"));
    expect(fileArgs).toHaveLength(1);
  });

  it("invalidate clears cache and fires event", () => {
    const uri = { fsPath: "/tmp/inv.lm" } as any;
    provider.invalidate(uri);
    expect((provider as any)._onDidChangeFileDecorations.fire).toHaveBeenCalledWith(uri);
  });

  it("returns decoration after cache is populated with executable=true", () => {
    const uri = { fsPath: "/tmp/exec.lm" } as any;
    provider.provideFileDecoration(uri);
    vi.advanceTimersByTime(50);

    const callback = mockExecFile.mock.calls[0][3] as Function;
    callback(null, JSON.stringify({ executable: true, steps: [1, 3] }));

    const decoration = provider.provideFileDecoration(uri);
    expect(decoration).toBeDefined();
    expect(decoration!.badge).toBe("▶");
  });

  it("returns undefined after cache is populated with executable=false", () => {
    const uri = { fsPath: "/tmp/defs.lm" } as any;
    provider.provideFileDecoration(uri);
    vi.advanceTimersByTime(50);

    const callback = mockExecFile.mock.calls[0][3] as Function;
    callback(null, JSON.stringify({ executable: false, steps: [] }));

    const decoration = provider.provideFileDecoration(uri);
    expect(decoration).toBeUndefined();
  });

  it("handles batch response with results map", () => {
    provider.provideFileDecoration({ fsPath: "/tmp/x.lm" } as any);
    provider.provideFileDecoration({ fsPath: "/tmp/y.lm" } as any);
    vi.advanceTimersByTime(50);

    const callback = mockExecFile.mock.calls[0][3] as Function;
    callback(null, JSON.stringify({
      results: {
        "/tmp/x.lm": { executable: true, steps: [1] },
        "/tmp/y.lm": { executable: false, steps: [] },
      },
    }));

    const xDec = provider.provideFileDecoration({ fsPath: "/tmp/x.lm" } as any);
    const yDec = provider.provideFileDecoration({ fsPath: "/tmp/y.lm" } as any);
    expect(xDec).toBeDefined();
    expect(yDec).toBeUndefined();
  });
});
