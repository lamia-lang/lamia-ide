import { describe, it, expect, vi, beforeEach } from "vitest";

let mockTree: Record<string, [string, number][]> = {};

vi.mock("vscode", () => ({
  CompletionItem: class {
    label: string;
    kind?: number;
    detail?: string;
    insertText?: string;
    filterText?: string;
    constructor(label: string, kind?: number) {
      this.label = label;
      this.kind = kind;
    }
  },
  CompletionItemKind: { File: 16 },
  FileType: { File: 1, Directory: 2 },
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

import { FileReferenceCompletionProvider } from "./fileReferenceCompletionProvider";

const FILE = 1;
const DIR = 2;

function makeDocument(fsPath: string, line: string) {
  return {
    uri: { fsPath },
    lineAt: () => ({ text: line }),
  } as any;
}

async function complete(fsPath: string, line: string) {
  const provider = new FileReferenceCompletionProvider();
  const doc = makeDocument(fsPath, line);
  const position = { line: 0, character: line.length } as any;
  return (await provider.provideCompletionItems(doc, position)) as any[] | undefined;
}

describe("FileReferenceCompletionProvider", () => {
  beforeEach(() => {
    mockTree = {
      "/proj": [
        ["clean_contact.hu", FILE],
        ["contacts.csv", FILE],
        ["data", DIR],
        [".git", DIR],
        ["node_modules", DIR],
      ],
      "/proj/data": [["sample_contacts.csv", FILE]],
      "/proj/node_modules": [["pkg.js", FILE]],
      "/proj/.git": [["HEAD", FILE]],
    };
  });

  it("returns nothing outside a {@...} reference", async () => {
    const items = await complete("/proj/clean_contact.hu", "Clean {raw_row}");
    expect(items).toBeUndefined();
  });

  it("lists files relative to a .hu file without files() context", async () => {
    const items = await complete("/proj/clean_contact.hu", "Use {@");
    const labels = items!.map((i) => i.label).sort();
    expect(labels).toEqual(["contacts.csv", "data/sample_contacts.csv"]);
  });

  it("filters relative paths by the typed prefix", async () => {
    const items = await complete("/proj/clean_contact.hu", "Use {@sample");
    expect(items!.map((i) => i.label)).toEqual(["data/sample_contacts.csv"]);
    expect(items![0].insertText).toBe("data/sample_contacts.csv");
    expect(items![0].detail).toBe("/proj/data/sample_contacts.csv");
  });

  it("returns no items when the document directory is unreadable", async () => {
    const items = await complete("/missing/p.hu", "{@");
    expect(items).toEqual([]);
  });
});
