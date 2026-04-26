import { describe, it, expect } from "vitest";

/**
 * Tests for the NDJSON parsing logic extracted from LamiaProcess._onData.
 * We replicate the parsing logic here to test it in isolation without
 * needing to spawn actual processes.
 */

interface FileWrite {
  path: string;
  action: "create" | "modify" | "delete";
  content?: string;
  original?: string;
}

interface LamiaResponse {
  type: "response" | "error" | "ready";
  text?: string;
  message?: string;
  model?: string;
  tokens?: { input: number; output: number; total: number };
  files?: FileWrite[];
}

interface ToolUseEvent {
  tool: string;
  args: Record<string, unknown>;
}

interface ParseResult {
  toolUses: ToolUseEvent[];
  response: LamiaResponse | null;
}

/**
 * Replicates the core parsing logic from LamiaProcess._onData.
 * Feeds raw NDJSON text through the same algorithm the extension uses.
 */
function parseNdjsonStream(rawData: string): ParseResult {
  const toolUses: ToolUseEvent[] = [];
  let response: LamiaResponse | null = null;
  let buffer = rawData;

  let nl: number;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;

    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    if (msg.type === "ready") {
      continue;
    }

    if (msg.type === "tool_use") {
      toolUses.push({ tool: msg.tool ?? "", args: msg.args ?? {} });
      continue;
    }

    response = msg as LamiaResponse;
  }

  return { toolUses, response };
}

describe("NDJSON parsing (tool_use + response)", () => {
  it("parses tool_use events followed by response", () => {
    const stream = [
      JSON.stringify({ type: "tool_use", tool: "read_file", args: { path: "a.ts" } }),
      JSON.stringify({ type: "tool_use", tool: "write_file", args: { path: "a.ts", content: "new" } }),
      JSON.stringify({
        type: "response",
        text: "Done.",
        model: "claude-sonnet",
        tokens: { input: 100, output: 50, total: 150 },
        files: [{ path: "a.ts", action: "modify", content: "new", original: "old" }],
      }),
    ].join("\n") + "\n";

    const { toolUses, response } = parseNdjsonStream(stream);

    expect(toolUses).toHaveLength(2);
    expect(toolUses[0].tool).toBe("read_file");
    expect(toolUses[1].tool).toBe("write_file");
    expect(response).not.toBeNull();
    expect(response!.type).toBe("response");
    expect(response!.files).toHaveLength(1);
    expect(response!.files![0].original).toBe("old");
  });

  it("response without tool_use events has empty tools", () => {
    const stream = [
      JSON.stringify({
        type: "response",
        text: "Just a text response.",
        model: "gpt-4",
        tokens: { input: 50, output: 30, total: 80 },
      }),
    ].join("\n") + "\n";

    const { toolUses, response } = parseNdjsonStream(stream);

    expect(toolUses).toHaveLength(0);
    expect(response).not.toBeNull();
    expect(response!.text).toBe("Just a text response.");
    expect(response!.files).toBeUndefined();
  });

  it("response.files is undefined when CLI sends no files", () => {
    const stream = JSON.stringify({
      type: "response",
      text: "No files changed.",
    }) + "\n";

    const { response } = parseNdjsonStream(stream);
    expect(response!.files).toBeUndefined();
  });

  it("handles multiple tool_use events with complex args", () => {
    const stream = [
      JSON.stringify({ type: "tool_use", tool: "read_file", args: { path: "one.ts" } }),
      JSON.stringify({ type: "tool_use", tool: "read_file", args: { path: "two.ts" } }),
      JSON.stringify({ type: "tool_use", tool: "write_file", args: { path: "one.ts", content: "updated" } }),
      JSON.stringify({ type: "response", text: "Updated." }),
    ].join("\n") + "\n";

    const { toolUses } = parseNdjsonStream(stream);
    expect(toolUses).toHaveLength(3);
    expect(toolUses.map(t => t.tool)).toEqual(["read_file", "read_file", "write_file"]);
  });

  it("skips malformed JSON lines", () => {
    const stream = [
      "not valid json",
      JSON.stringify({ type: "tool_use", tool: "read_file", args: {} }),
      "another bad line {{}",
      JSON.stringify({ type: "response", text: "ok" }),
    ].join("\n") + "\n";

    const { toolUses, response } = parseNdjsonStream(stream);
    expect(toolUses).toHaveLength(1);
    expect(response!.text).toBe("ok");
  });

  it("handles chunked data (partial lines)", () => {
    const line1 = JSON.stringify({ type: "tool_use", tool: "read_file", args: { path: "x.ts" } });
    const line2 = JSON.stringify({ type: "response", text: "done" });

    // Simulate partial delivery: first chunk has line1 + half of line2
    const half = Math.floor(line2.length / 2);
    const chunk1 = line1 + "\n" + line2.slice(0, half);
    const chunk2 = line2.slice(half) + "\n";

    // First chunk: only line1 is complete
    const r1 = parseNdjsonStream(chunk1 + "\n"); // won't find line2 without newline
    // Full stream: both lines complete
    const full = parseNdjsonStream(chunk1 + chunk2);
    expect(full.toolUses).toHaveLength(1);
    expect(full.response!.text).toBe("done");
  });
});

describe("turnContext construction from parsed data", () => {
  it("constructs turnContext exactly like chatProvider does", () => {
    // Simulate the data flow: NDJSON parsed → completedTools populated → turnContext built
    const stream = [
      JSON.stringify({ type: "tool_use", tool: "read_file", args: { path: "a.hu" } }),
      JSON.stringify({ type: "tool_use", tool: "write_file", args: { path: "a.hu", content: "improved" } }),
      JSON.stringify({
        type: "response",
        text: "Improved the file.",
        model: "claude-sonnet",
        tokens: { input: 5000, output: 800, total: 5800 },
        files: [{ path: "a.hu", action: "modify", content: "improved", original: "original content" }],
      }),
    ].join("\n") + "\n";

    const { toolUses, response } = parseNdjsonStream(stream);

    // Simulate chatProvider's onToolUse callback building completedTools
    function toolProgressLabel(tool: string, args: Record<string, unknown>): string {
      const p = (args.path as string) || "";
      return `${tool}: ${p}`;
    }
    const completedTools = toolUses.map(t => ({
      tool: t.tool,
      label: toolProgressLabel(t.tool, t.args),
      args: t.args,
    }));

    // Simulate chatProvider's assistantMsg construction (lines 449-467)
    const turnContext = {
      toolCalls: completedTools.map(t => ({
        tool: t.tool,
        label: t.label,
        args: t.args,
      })),
      fileWrites: response!.files?.map(f => ({
        path: f.path,
        action: f.action,
        content: f.content,
        original: f.original,
      })),
    };

    expect(turnContext.toolCalls).toHaveLength(2);
    expect(turnContext.toolCalls[0].tool).toBe("read_file");
    expect(turnContext.toolCalls[1].tool).toBe("write_file");
    expect(turnContext.fileWrites).toHaveLength(1);
    expect(turnContext.fileWrites![0].original).toBe("original content");

    // Verify it serializes correctly to JSON
    const json = JSON.stringify({ turnContext }, null, 2);
    const parsed = JSON.parse(json);
    expect(parsed.turnContext.toolCalls).toHaveLength(2);
    expect(parsed.turnContext.fileWrites).toHaveLength(1);
  });

  it("turnContext with zero tool_use events still serializes", () => {
    const completedTools: any[] = [];
    const responseFiles: FileWrite[] | undefined = undefined;

    const turnContext = {
      toolCalls: completedTools.map(t => ({ tool: t.tool, label: t.label, args: t.args })),
      fileWrites: responseFiles?.map(f => ({ path: f.path, action: f.action, content: f.content, original: f.original })),
    };

    // This is the critical test: does an empty turnContext survive JSON.stringify?
    const obj = { role: "assistant", text: "hello", turnContext, ts: Date.now() };
    const json = JSON.stringify(obj, null, 2);
    const parsed = JSON.parse(json);

    expect(parsed).toHaveProperty("turnContext");
    expect(parsed.turnContext.toolCalls).toEqual([]);
    // fileWrites is undefined, so JSON.stringify drops it
    expect(parsed.turnContext).not.toHaveProperty("fileWrites");
  });

  it("full end-to-end: NDJSON → turnContext → save → load", async () => {
    const { newChat, saveChat, loadChat, deleteChat } = await import("./chatStore");

    const stream = [
      JSON.stringify({ type: "tool_use", tool: "read_file", args: { path: "test.lm" } }),
      JSON.stringify({ type: "tool_use", tool: "patch_file", args: { path: "test.lm", old_text: "a", new_text: "b" } }),
      JSON.stringify({
        type: "response",
        text: "Patched test.lm",
        model: "claude-sonnet",
        tokens: { input: 200, output: 100, total: 300 },
        files: [{ path: "test.lm", action: "modify", content: "b", original: "a" }],
      }),
    ].join("\n") + "\n";

    const { toolUses, response } = parseNdjsonStream(stream);

    const completedTools = toolUses.map(t => ({
      tool: t.tool,
      label: `${t.tool}: ${(t.args.path as string) || ""}`,
      args: t.args,
    }));

    const chat = newChat();
    try {
      chat.messages.push({ role: "user", text: "fix test.lm", ts: Date.now() });

      const assistantMsg = {
        role: "assistant" as const,
        text: response!.text!,
        model: response!.model,
        tokens: response!.tokens,
        turnContext: {
          toolCalls: completedTools.map(t => ({ tool: t.tool, label: t.label, args: t.args })),
          fileWrites: response!.files?.map(f => ({
            path: f.path,
            action: f.action,
            content: f.content,
            original: f.original,
          })),
        },
        ts: Date.now(),
      };

      chat.messages.push(assistantMsg);
      saveChat(chat);

      const loaded = loadChat(chat.id);
      expect(loaded).not.toBeNull();

      const loadedAssistant = loaded!.messages[1];
      expect(loadedAssistant.turnContext).toBeDefined();
      expect(loadedAssistant.turnContext!.toolCalls).toHaveLength(2);
      expect(loadedAssistant.turnContext!.toolCalls![0].tool).toBe("read_file");
      expect(loadedAssistant.turnContext!.toolCalls![1].tool).toBe("patch_file");
      expect(loadedAssistant.turnContext!.toolCalls![1].args).toEqual({ path: "test.lm", old_text: "a", new_text: "b" });
      expect(loadedAssistant.turnContext!.fileWrites).toHaveLength(1);
      expect(loadedAssistant.turnContext!.fileWrites![0].original).toBe("a");
    } finally {
      deleteChat(chat.id);
    }
  });
});
