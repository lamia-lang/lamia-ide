import { describe, it, expect } from "vitest";
import { Script } from "vm";
import { buildFileContextPrefix, deduplicateFileWrites, LamiaChatProvider } from "./chatProvider";

describe("buildFileContextPrefix", () => {
  it("returns empty string for undefined", () => {
    expect(buildFileContextPrefix(undefined)).toBe("");
  });

  it("returns empty string for empty array", () => {
    expect(buildFileContextPrefix([])).toBe("");
  });

  it("includes path and directory for a single file", () => {
    const result = buildFileContextPrefix(["/Users/me/project/lm_syntax/file_read.lm"]);
    expect(result).toContain('path="/Users/me/project/lm_syntax/file_read.lm"');
    expect(result).toContain('directory="/Users/me/project/lm_syntax"');
    expect(result).toContain("Relative paths in this file resolve from /Users/me/project/lm_syntax");
  });

  it("includes entries for multiple files", () => {
    const result = buildFileContextPrefix([
      "/Users/me/project/src/a.lm",
      "/Users/me/project/tests/b.lm",
    ]);
    expect(result).toContain('path="/Users/me/project/src/a.lm"');
    expect(result).toContain('directory="/Users/me/project/src"');
    expect(result).toContain('path="/Users/me/project/tests/b.lm"');
    expect(result).toContain('directory="/Users/me/project/tests"');
  });

  it("does not truncate long paths", () => {
    const longPath = "/Users/me/very/long/nested/directory/structure/deeply/buried/file.lm";
    const result = buildFileContextPrefix([longPath]);
    expect(result).toContain(longPath);
    expect(result).not.toContain("...");
  });
});

describe("deduplicateFileWrites", () => {
  it("keeps create action when same file is re-written", () => {
    const deduped = deduplicateFileWrites([
      { path: "/tmp/a.txt", action: "create", content: "first" },
      { path: "/tmp/a.txt", action: "modify", content: "second" },
    ]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0].path).toBe("/tmp/a.txt");
    expect(deduped[0].action).toBe("create");
    expect(deduped[0].content).toBe("second");
  });

  it("keeps latest action for normal modify chains", () => {
    const deduped = deduplicateFileWrites([
      { path: "/tmp/a.txt", action: "modify", content: "1" },
      { path: "/tmp/a.txt", action: "modify", content: "2" },
    ]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0].action).toBe("modify");
    expect(deduped[0].content).toBe("2");
  });
});

function extractWebviewScript(): string {
  const html = (LamiaChatProvider.prototype as any)._getHtmlForWebview.call({});
  const match = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/);
  return match ? match[1] : "";
}

describe("chat webview script", () => {
  it("has valid JavaScript syntax", () => {
    const script = extractWebviewScript();
    expect(script.length).toBeGreaterThan(100);
    expect(() => new Script(script)).not.toThrow();
  });

  it("openSetup sets settings-mode and removes history-mode", () => {
    const script = extractWebviewScript();
    const openSetupMatch = script.match(/function openSetup\(\)\s*\{([\s\S]*?)\n    \}/);
    expect(openSetupMatch).toBeTruthy();
    const body = openSetupMatch![1];
    expect(body).toContain('classList.add("settings-mode")');
    expect(body).toContain('classList.remove("history-mode")');
  });

  it("openHistory sets history-mode and closes settings", () => {
    const script = extractWebviewScript();
    const openHistoryMatch = script.match(/function openHistory\(\)\s*\{([\s\S]*?)\n    \}/);
    expect(openHistoryMatch).toBeTruthy();
    const body = openHistoryMatch![1];
    expect(body).toContain("closeSetup()");
    expect(body).toContain('classList.add("history-mode")');
  });

  it("closeSetup removes settings-mode", () => {
    const script = extractWebviewScript();
    const match = script.match(/function closeSetup\(\)\s*\{([\s\S]*?)\n    \}/);
    expect(match).toBeTruthy();
    expect(match![1]).toContain('classList.remove("settings-mode")');
  });

  it("closeHistory removes history-mode", () => {
    const script = extractWebviewScript();
    const match = script.match(/function closeHistory\(\)\s*\{([\s\S]*?)\n    \}/);
    expect(match).toBeTruthy();
    expect(match![1]).toContain('classList.remove("history-mode")');
  });

  it("does not reference removed reconnect elements", () => {
    const script = extractWebviewScript();
    expect(script).not.toContain("mcp-reconnect");
    expect(script).not.toContain("reconnectMcpServers");
    expect(script).not.toContain("mcp-cancel");
  });

  it("uses running/failed/disabled status labels not connected/disconnected", () => {
    const script = extractWebviewScript();
    expect(script).not.toMatch(/status\.textContent\s*=\s*"connected"/);
    expect(script).not.toMatch(/status\.textContent\s*=\s*"disconnected"/);
    expect(script).toContain('"running (');
    expect(script).toContain('"failed"');
    expect(script).toContain('"disabled"');
  });

  it("handles apiKeyValidation message and updates status", () => {
    const script = extractWebviewScript();
    expect(script).toContain("apiKeyValidation");
    expect(script).toContain("keyValidationStatus");
    expect(script).toContain('"valid"');
    expect(script).toContain('"invalid"');
    expect(script).toContain('"checking"');
  });

  it("shows Retry button text for failed servers", () => {
    const script = extractWebviewScript();
    expect(script).toContain('"Retry"');
    expect(script).toContain('"Starting..."');
  });
});
