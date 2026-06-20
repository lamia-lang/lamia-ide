import { EventEmitter } from "events";
import { beforeEach, describe, expect, it, vi } from "vitest";

let storedConfigs: Record<string, any> = {};
const updateMock = vi.fn(async (_key: string, value: unknown) => {
  storedConfigs = value as Record<string, any>;
});
const mocks = vi.hoisted(() => ({
  showWarningMessageMock: vi.fn(),
  spawnMock: vi.fn(),
}));

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin: {
    destroyed: boolean;
    write: (data: string, _encoding: BufferEncoding, cb?: (err?: Error | null) => void) => boolean;
  };
  killed = false;
  pid = 4321;

  constructor(private readonly _tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>) {
    super();
    this.stdin = {
      destroyed: false,
      write: (data, _encoding, cb) => {
        const lines = data.split("\n").map(line => line.trim()).filter(Boolean);
        for (const line of lines) {
          const msg = JSON.parse(line) as { id?: number; method?: string };
          if (msg.method === "initialize" && typeof msg.id === "number") {
            const initResp = {
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "fake", version: "1.0.0" },
              },
            };
            this.stdout.emit("data", Buffer.from(JSON.stringify(initResp) + "\n", "utf-8"));
          } else if (msg.method === "tools/list" && typeof msg.id === "number") {
            const listResp = {
              jsonrpc: "2.0",
              id: msg.id,
              result: { tools: this._tools },
            };
            this.stdout.emit("data", Buffer.from(JSON.stringify(listResp) + "\n", "utf-8"));
          }
        }
        cb?.(null);
        return true;
      },
    };
  }

  kill(signal?: NodeJS.Signals): boolean {
    if (this.killed) return true;
    this.killed = true;
    this.stdin.destroyed = true;
    this.emit("exit", signal === "SIGKILL" ? 137 : null, signal ?? "SIGTERM");
    return true;
  }
}

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => mocks.spawnMock(...args),
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: () => new Proxy(storedConfigs, {
        set() {
          throw new TypeError(
            "'isExtensible' on proxy: trap result does not reflect extensibility of proxy target (which is 'true')"
          );
        },
      }),
      update: updateMock,
    }),
  },
  window: {
    showWarningMessage: mocks.showWarningMessageMock,
  },
  ConfigurationTarget: {
    Global: 1,
  },
}));

import { McpManager } from "./mcpManager";

describe("McpManager config persistence", () => {
  beforeEach(() => {
    storedConfigs = {};
    updateMock.mockClear();
    mocks.showWarningMessageMock.mockClear();
    mocks.spawnMock.mockClear();
    mocks.spawnMock.mockImplementation(
      () => new FakeChildProcess([
        { name: "mock_tool", description: "mock tool", inputSchema: { type: "object", properties: {} } },
      ])
    );
  });

  it("saves server config when source settings object is proxied", async () => {
    const manager = new McpManager();
    await manager.saveServer("playwright", { command: "npx", args: ["@playwright/mcp@latest"] });

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(storedConfigs.playwright.command).toBe("npx");
    expect(storedConfigs.playwright.enabled).toBe(true);
  });

  it("renames a server and keeps enabled state", async () => {
    storedConfigs = {
      playwright: { command: "npx", args: ["@playwright/mcp@latest"], enabled: false },
    };
    const manager = new McpManager();

    await manager.saveServer(
      "playwright-mcp",
      { command: "npx", args: ["@playwright/mcp@latest", "--headless"] },
      "playwright"
    );

    expect(storedConfigs.playwright).toBeUndefined();
    expect(storedConfigs["playwright-mcp"].enabled).toBe(false);
    expect(storedConfigs["playwright-mcp"].args).toEqual(["@playwright/mcp@latest", "--headless"]);
  });

  it("deletes a server from configs", async () => {
    storedConfigs = {
      playwright: { command: "npx", args: ["@playwright/mcp@latest"], enabled: true },
      github: { command: "npx", args: ["@modelcontextprotocol/server-github"], enabled: true },
    };
    const manager = new McpManager();

    await manager.deleteServer("playwright");

    expect(storedConfigs.playwright).toBeUndefined();
    expect(storedConfigs.github).toBeDefined();
  });

  it("handles immediate MCP responses without dropping request ids", async () => {
    storedConfigs = {
      playwright: { command: "npx", args: ["@playwright/mcp@latest"], enabled: true },
    };
    const manager = new McpManager();

    await manager.initialize();

    const servers = manager.getServerList();
    expect(servers).toHaveLength(1);
    expect(servers[0].connected).toBe(true);
    expect(servers[0].toolCount).toBe(1);
    expect(servers[0].toolNames).toEqual(["mock_tool"]);
    expect(mocks.showWarningMessageMock).not.toHaveBeenCalled();
    manager.dispose();
  });
});

