import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Chat, ChatMessage, newChat, saveChat, loadChat, loadLatestChat, listChats, deleteChat } from "./chatStore";

const CHATS_DIR = path.join(os.homedir(), ".lamia", "ide", "chats");

function chatDir(): string {
  const crypto = require("crypto");
  const raw = "/tmp/test-workspace";
  const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12);
  return path.join(CHATS_DIR, hash);
}

function readRawJson(id: string): any {
  const filePath = path.join(chatDir(), `${id}.json`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

describe("chatStore roundtrip", () => {
  const createdIds: string[] = [];

  afterEach(() => {
    for (const id of createdIds) {
      deleteChat(id);
    }
    createdIds.length = 0;
  });

  it("saves and loads a basic chat", () => {
    const chat = newChat();
    createdIds.push(chat.id);
    chat.messages.push({ role: "user", text: "hello", ts: Date.now() });
    chat.messages.push({ role: "assistant", text: "hi there", ts: Date.now() });
    saveChat(chat);

    const loaded = loadChat(chat.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.messages).toHaveLength(2);
    expect(loaded!.messages[0].text).toBe("hello");
    expect(loaded!.messages[1].text).toBe("hi there");
  });

  it("preserves turnContext with toolCalls through save/load", () => {
    const chat = newChat();
    createdIds.push(chat.id);

    chat.messages.push({ role: "user", text: "improve the file", ts: Date.now() });

    const assistantMsg: ChatMessage = {
      role: "assistant",
      text: "I improved the file.",
      model: "claude-sonnet",
      tokens: { input: 100, output: 50, total: 150 },
      turnContext: {
        toolCalls: [
          { tool: "read_file", label: "Read qa_analyst.hu", args: { path: "team/qa_analyst.hu" } },
          { tool: "write_file", label: "Write qa_analyst.hu", args: { path: "team/qa_analyst.hu", content: "new content" } },
        ],
      },
      ts: Date.now(),
    };
    chat.messages.push(assistantMsg);
    saveChat(chat);

    const loaded = loadChat(chat.id);
    expect(loaded).not.toBeNull();
    const msg = loaded!.messages[1];
    expect(msg.turnContext).toBeDefined();
    expect(msg.turnContext!.toolCalls).toHaveLength(2);
    expect(msg.turnContext!.toolCalls![0].tool).toBe("read_file");
    expect(msg.turnContext!.toolCalls![0].args).toEqual({ path: "team/qa_analyst.hu" });
    expect(msg.turnContext!.toolCalls![1].tool).toBe("write_file");
  });

  it("preserves turnContext with fileWrites through save/load", () => {
    const chat = newChat();
    createdIds.push(chat.id);

    chat.messages.push({ role: "user", text: "create a file", ts: Date.now() });

    const assistantMsg: ChatMessage = {
      role: "assistant",
      text: "Created the file.",
      turnContext: {
        toolCalls: [],
        fileWrites: [
          {
            path: "src/utils.ts",
            action: "create",
            content: "export function foo() {}",
          },
          {
            path: "src/main.ts",
            action: "modify",
            content: "import { foo } from './utils';",
            original: "// main",
          },
        ],
      },
      ts: Date.now(),
    };
    chat.messages.push(assistantMsg);
    saveChat(chat);

    const loaded = loadChat(chat.id);
    expect(loaded).not.toBeNull();
    const msg = loaded!.messages[1];
    expect(msg.turnContext).toBeDefined();
    expect(msg.turnContext!.fileWrites).toHaveLength(2);
    expect(msg.turnContext!.fileWrites![0].path).toBe("src/utils.ts");
    expect(msg.turnContext!.fileWrites![0].action).toBe("create");
    expect(msg.turnContext!.fileWrites![0].content).toBe("export function foo() {}");
    expect(msg.turnContext!.fileWrites![1].original).toBe("// main");
  });

  it("turnContext appears in raw JSON on disk", () => {
    const chat = newChat();
    createdIds.push(chat.id);

    chat.messages.push({ role: "user", text: "do something", ts: Date.now() });
    chat.messages.push({
      role: "assistant",
      text: "Done.",
      turnContext: {
        toolCalls: [{ tool: "read_file", args: { path: "x.ts" } }],
        fileWrites: [{ path: "x.ts", action: "modify" as const, content: "new" }],
      },
      ts: Date.now(),
    });
    saveChat(chat);

    const raw = readRawJson(chat.id);
    const assistantRaw = raw.messages[1];
    expect(assistantRaw).toHaveProperty("turnContext");
    expect(assistantRaw.turnContext).toHaveProperty("toolCalls");
    expect(assistantRaw.turnContext.toolCalls).toHaveLength(1);
    expect(assistantRaw.turnContext).toHaveProperty("fileWrites");
    expect(assistantRaw.turnContext.fileWrites).toHaveLength(1);
  });

  it("old chats without turnContext load without errors", () => {
    const chat = newChat();
    createdIds.push(chat.id);

    chat.messages.push({ role: "user", text: "old message", ts: Date.now() });
    chat.messages.push({ role: "assistant", text: "old reply", ts: Date.now() });
    saveChat(chat);

    const loaded = loadChat(chat.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.messages[1].turnContext).toBeUndefined();
  });

  it("turnContext with empty toolCalls still persists", () => {
    const chat = newChat();
    createdIds.push(chat.id);

    chat.messages.push({ role: "user", text: "test", ts: Date.now() });
    chat.messages.push({
      role: "assistant",
      text: "response",
      turnContext: {
        toolCalls: [],
      },
      ts: Date.now(),
    });
    saveChat(chat);

    const raw = readRawJson(chat.id);
    expect(raw.messages[1]).toHaveProperty("turnContext");
    expect(raw.messages[1].turnContext.toolCalls).toEqual([]);
  });

  it("simulates the exact chatProvider assistant message construction", () => {
    const chat = newChat();
    createdIds.push(chat.id);

    chat.messages.push({ role: "user", text: "improve qa_analyst", ts: Date.now() });

    // Simulate what chatProvider.ts does at lines 448-470
    const completedTools = [
      { tool: "read_file", label: "Read qa_analyst.hu", args: { path: "team/qa_analyst.hu" } },
      { tool: "write_file", label: "Write qa_analyst.hu", args: { path: "team/qa_analyst.hu", content: "improved" } },
    ];
    const responseFiles = [
      { path: "team/qa_analyst.hu", action: "modify" as const, content: "improved", original: "old content" },
    ];

    const assistantMsg: ChatMessage = {
      role: "assistant",
      text: "I improved the file.",
      model: "claude-max:claude-sonnet-4-5-20250929",
      tokens: { input: 11965, output: 1613, total: 13578 },
      turnContext: {
        toolCalls: completedTools.map(t => ({
          tool: t.tool,
          label: t.label,
          args: t.args,
        })),
        fileWrites: responseFiles?.map(f => ({
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

    // Verify raw JSON on disk
    const raw = readRawJson(chat.id);
    const rawMsg = raw.messages[1];
    expect(rawMsg.turnContext).toBeDefined();
    expect(rawMsg.turnContext.toolCalls).toHaveLength(2);
    expect(rawMsg.turnContext.toolCalls[0].tool).toBe("read_file");
    expect(rawMsg.turnContext.toolCalls[1].tool).toBe("write_file");
    expect(rawMsg.turnContext.fileWrites).toHaveLength(1);
    expect(rawMsg.turnContext.fileWrites[0].path).toBe("team/qa_analyst.hu");
    expect(rawMsg.turnContext.fileWrites[0].original).toBe("old content");

    // Verify loaded chat matches
    const loaded = loadChat(chat.id);
    expect(loaded!.messages[1].turnContext!.toolCalls).toHaveLength(2);
    expect(loaded!.messages[1].turnContext!.fileWrites).toHaveLength(1);
  });

  it("loadLatestChat returns chat with turnContext", () => {
    const chat = newChat();
    createdIds.push(chat.id);

    chat.messages.push({ role: "user", text: "latest test", ts: Date.now() });
    chat.messages.push({
      role: "assistant",
      text: "latest response",
      turnContext: {
        toolCalls: [{ tool: "grep", args: { pattern: "foo" } }],
      },
      ts: Date.now(),
    });
    saveChat(chat);

    const latest = loadLatestChat();
    expect(latest).not.toBeNull();
    if (latest!.id === chat.id) {
      expect(latest!.messages[1].turnContext).toBeDefined();
      expect(latest!.messages[1].turnContext!.toolCalls).toHaveLength(1);
    }
  });

  it("listChats works with turnContext messages present", () => {
    const chat = newChat();
    createdIds.push(chat.id);

    chat.messages.push({ role: "user", text: "list test", ts: Date.now() });
    chat.messages.push({
      role: "assistant",
      text: "done",
      turnContext: { toolCalls: [{ tool: "x" }] },
      ts: Date.now(),
    });
    saveChat(chat);

    const chats = listChats();
    expect(chats.find(c => c.id === chat.id)).toBeDefined();
  });
});
