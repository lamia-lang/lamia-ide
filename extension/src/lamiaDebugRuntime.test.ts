import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  existsSyncMock: vi.fn(),
  execFileSyncMock: vi.fn(),
}));

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = {
    writable: true,
    write: vi.fn(),
  };
}

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => mocks.spawnMock(...args),
  execFileSync: (...args: unknown[]) => mocks.execFileSyncMock(...args),
}));

vi.mock("fs", () => ({
  existsSync: (...args: unknown[]) => mocks.existsSyncMock(...args),
}));

import { LamiaDebugRuntime } from "./lamiaDebugRuntime";

describe("LamiaDebugRuntime start breakpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsSyncMock.mockReturnValue(false);
    mocks.execFileSyncMock.mockImplementation(() => {
      throw new Error("which not found");
    });
    mocks.spawnMock.mockImplementation(() => new FakeChildProcess());
  });

  it("passes --break only for the main program file", () => {
    const runtime = new LamiaDebugRuntime();
    const breakpoints = new Map<string, number[]>([
      ["/path/to/main.lm", [5, 10]],
      ["/path/to/other.lm", [3, 7]],
    ]);

    runtime.start("/path/to/main.lm", "/path/to", false, breakpoints);

    expect(mocks.spawnMock).toHaveBeenCalledWith(
      "lamia",
      ["debug", "/path/to/main.lm", "--json", "--break", "5", "--break", "10"],
      expect.objectContaining({ cwd: "/path/to" }),
    );
  });

  it("passes no --break args when breakpoints map has no entry for program file", () => {
    const runtime = new LamiaDebugRuntime();
    const breakpoints = new Map<string, number[]>([
      ["/path/to/other.lm", [3, 7]],
    ]);

    runtime.start("/path/to/main.lm", "/path/to", false, breakpoints);

    expect(mocks.spawnMock).toHaveBeenCalledWith(
      "lamia",
      ["debug", "/path/to/main.lm", "--json"],
      expect.objectContaining({ cwd: "/path/to" }),
    );
  });
});
