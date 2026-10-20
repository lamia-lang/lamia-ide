import { describe, it, expect, vi, beforeEach } from "vitest";

let mockTree: Record<string, [string, number][]> = {};

vi.mock("vscode", () => ({
  CompletionItem: class {
    label: string;
    kind?: number;
    detail?: string;
    insertText?: string;
    filterText?: string;
    range?: unknown;
    command?: { command: string; title: string };
    constructor(label: string, kind?: number) {
      this.label = label;
      this.kind = kind;
    }
  },
  CompletionItemKind: { File: 16, Folder: 18 },
  FileType: { File: 1, Directory: 2 },
  Range: class {
    constructor(
      public startLine: number,
      public startChar: number,
      public endLine: number,
      public endChar: number,
    ) {}
  },
  Uri: { file: (p: string) => ({ fsPath: p }) },
  workspace: {
    fs: {
      readDirectory: vi.fn(async (uri: { fsPath: string }) => {
        const entries = mockTree[uri.fsPath];
        if (!entries) {
          throw new Error(`ENOENT: ${uri.fsPath}`);
        }
        return entries;
      }),
    },
  },
}));

import * as vscode from "vscode";
import { StringPathCompletionProvider } from "./stringPathCompletionProvider";

const FILE = 1;
const DIR = 2;

async function complete(line: string, fsPath = "/proj/main.lm") {
  const provider = new StringPathCompletionProvider();
  const doc = { uri: { fsPath }, lineAt: () => ({ text: line }) } as any;
  const position = { line: 0, character: line.length } as any;
  return (await provider.provideCompletionItems(doc, position)) as any[] | undefined;
}

describe("StringPathCompletionProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTree = {
      "/proj": [["input", DIR], ["main.lm", FILE], [".env", FILE]],
      "/proj/input": [["crm", DIR]],
      "/proj/input/crm": [["hubspot_export.csv", FILE], ["salesforce", DIR]],
    };
  });

  it("lists the typed directory for a relative path in a string", async () => {
    const items = await complete('clean("./input/crm/hub');
    expect(items!.map((i) => i.label)).toEqual(["hubspot_export.csv", "salesforce/"]);
    expect(vscode.workspace.fs.readDirectory).toHaveBeenCalledTimes(1);
    expect(vscode.workspace.fs.readDirectory).toHaveBeenCalledWith({ fsPath: "/proj/input/crm" });
  });

  it("replaces only the segment after the last slash", async () => {
    const line = 'clean("./input/crm/hub';
    const items = await complete(line);
    expect(items![0].range).toMatchObject({ startChar: line.length - 3, endChar: line.length });
    expect(items![0].filterText).toBe("hubspot_export.csv");
  });

  it("marks directories and re-opens suggestions after picking one", async () => {
    const items = await complete('clean("./input/');
    expect(items!.map((i) => i.label)).toEqual(["crm/"]);
    expect(items![0].kind).toBe(18);
    expect(items![0].command.command).toBe("editor.action.triggerSuggest");
  });

  it("supports single quotes and paths without a ./ prefix", async () => {
    const items = await complete("clean('input/");
    expect(items!.map((i) => i.label)).toEqual(["crm/"]);
  });

  it("hides dotfiles unless the segment starts with a dot", async () => {
    expect((await complete('x = "./'))!.map((i) => i.label)).toEqual(["input/", "main.lm"]);
    expect((await complete('x = "./.'))!.map((i) => i.label)).toEqual(["input/", "main.lm", ".env"]);
  });

  it("ignores strings that do not look like paths", async () => {
    expect(await complete('print("hello world')).toBeUndefined();
    expect(vscode.workspace.fs.readDirectory).not.toHaveBeenCalled();
  });

  it("ignores text after a closed string", async () => {
    expect(await complete('x = "a/b" + y')).toBeUndefined();
  });

  it("ignores quotes inside comments", async () => {
    expect(await complete('# see "./input/')).toBeUndefined();
  });

  it("returns no items for a missing directory", async () => {
    expect(await complete('clean("./nope/')).toEqual([]);
  });
});
