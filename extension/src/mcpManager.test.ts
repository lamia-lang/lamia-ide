import { beforeEach, describe, expect, it, vi } from "vitest";

let storedConfigs: Record<string, any> = {};
const updateMock = vi.fn(async (_key: string, value: unknown) => {
  storedConfigs = value as Record<string, any>;
});

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
    showWarningMessage: vi.fn(),
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
});

