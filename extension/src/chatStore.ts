import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";

export interface ChatMessage {
  role: "user" | "assistant" | "error";
  text: string;
  model?: string;
  tokens?: { input: number; output: number; total: number };
  ts: number;
}

export interface Chat {
  id: string;
  title: string;
  created: number;
  updated: number;
  messages: ChatMessage[];
}

const CHATS_DIR = path.join(os.homedir(), ".lamia", "ide", "chats");

function projectHash(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return "_global";
  const raw = folders[0].uri.fsPath;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

function chatDir(): string {
  const dir = path.join(CHATS_DIR, projectHash());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function chatPath(id: string): string {
  return path.join(chatDir(), `${id}.json`);
}

export function newChat(): Chat {
  return {
    id: crypto.randomUUID(),
    title: "New Chat",
    created: Date.now(),
    updated: Date.now(),
    messages: [],
  };
}

export function saveChat(chat: Chat): void {
  chat.updated = Date.now();
  if (chat.messages.length > 0 && chat.title === "New Chat") {
    const first = chat.messages.find((m) => m.role === "user");
    if (first) {
      chat.title = first.text.slice(0, 60).replace(/\n/g, " ");
    }
  }
  fs.writeFileSync(chatPath(chat.id), JSON.stringify(chat, null, 2), "utf8");
}

export function loadLatestChat(): Chat | null {
  const dir = chatDir();
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }
  if (files.length === 0) return null;

  let latest: Chat | null = null;
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Chat;
      if (!latest || raw.updated > latest.updated) latest = raw;
    } catch {
      continue;
    }
  }
  return latest;
}

export function listChats(): { id: string; title: string; updated: number }[] {
  const dir = chatDir();
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const result: { id: string; title: string; updated: number }[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Chat;
      result.push({ id: raw.id, title: raw.title, updated: raw.updated });
    } catch {
      continue;
    }
  }
  return result.sort((a, b) => b.updated - a.updated);
}

export function loadChat(id: string): Chat | null {
  try {
    return JSON.parse(fs.readFileSync(chatPath(id), "utf8")) as Chat;
  } catch {
    return null;
  }
}
