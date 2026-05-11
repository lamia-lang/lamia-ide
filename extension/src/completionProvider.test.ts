import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "path";

vi.mock("vscode", () => ({
  CompletionItem: class {
    label: string;
    insertText: any;
    detail?: string;
    documentation?: string;
    filterText?: string;
    sortText?: string;
    kind?: number;
    constructor(label: string, kind?: number) {
      this.label = label;
      this.kind = kind;
    }
  },
  CompletionItemKind: { Function: 1, Field: 2, Property: 3 },
  SnippetString: class {
    value: string;
    constructor(value: string) { this.value = value; }
  },
  workspace: { workspaceFolders: [] },
}));

import * as fs from "fs";
vi.mock("fs");

import { invalidateSymbols } from "./symbolIndex";
import { LamiaCompletionProvider } from "./completionProvider";

function setupFiles(fileMap: Record<string, string>) {
  const mockedFs = vi.mocked(fs);
  mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
    const s = String(p);
    if (s.endsWith("config.yaml")) return true;
    return false;
  });
  mockedFs.readdirSync.mockImplementation((dir: fs.PathLike, _opts?: any) => {
    const d = String(dir);
    const entries: fs.Dirent[] = [];
    for (const full of Object.keys(fileMap)) {
      const parent = path.dirname(full);
      const name = path.basename(full);
      if (parent === d) {
        entries.push({ name, isFile: () => true, isDirectory: () => false } as fs.Dirent);
      }
    }
    const subdirs = new Set<string>();
    for (const full of Object.keys(fileMap)) {
      if (full.startsWith(d + path.sep)) {
        const rel = full.slice(d.length + 1);
        const firstSeg = rel.split(path.sep)[0];
        if (rel.includes(path.sep)) subdirs.add(firstSeg);
      }
    }
    for (const sub of subdirs) {
      entries.push({ name: sub, isFile: () => false, isDirectory: () => true } as fs.Dirent);
    }
    return entries;
  });
  mockedFs.readFileSync.mockImplementation((p: fs.PathOrFileDescriptor, _enc?: any) => {
    const s = String(p);
    if (s in fileMap) return fileMap[s];
    throw new Error(`ENOENT: ${s}`);
  });
}

function makeDoc(fsPath: string, lineTexts: string[]): any {
  return {
    uri: { fsPath },
    lineAt: (lineOrPos: number | { line: number }) => {
      const idx = typeof lineOrPos === "number" ? lineOrPos : lineOrPos.line;
      return { text: lineTexts[idx] ?? "" };
    },
  };
}

describe("LamiaCompletionProvider", () => {
  const root = "/project";
  const provider = new LamiaCompletionProvider();

  beforeEach(() => {
    invalidateSymbols();
    setupFiles({
      [`${root}/summarize.hu`]: "Summarize: {@article_path}\nFocus on {aspect} in {max_words:100} words.",
      [`${root}/caller.lm`]: [
        'def summarize2(aspect, max_word) -> HTML:',
        '    "Summarize: {@article_path}. Focus on {aspect} in {max_words:200} words."',
        '',
        'sum',
      ].join("\n"),
    });
  });

  it("completes .hu function name with parentheses and params", () => {
    const doc = makeDoc(`${root}/caller.lm`, [
      'def summarize2(aspect, max_word) -> HTML:',
      '    "template"',
      '',
      'sum',
    ]);
    const position = { line: 3, character: 3 };
    const items = provider.provideCompletionItems(doc, position, {} as any, {} as any);
    expect(items).toBeDefined();
    expect(items!.length).toBeGreaterThanOrEqual(2);

    const huItem = items!.find((i: any) => i.label === "summarize");
    expect(huItem).toBeDefined();
    expect(huItem!.insertText.value).toContain("summarize(");
    expect(huItem!.insertText.value).toContain("article_path");

    const defItem = items!.find((i: any) => i.label === "summarize2");
    expect(defItem).toBeDefined();
    expect(defItem!.insertText.value).toContain("summarize2(");
    expect(defItem!.insertText.value).toContain("aspect");
    expect(defItem!.insertText.value).toContain("max_word");
    // Template internals must NOT leak into the snippet
    expect(defItem!.insertText.value).not.toContain("article_path");
    expect(defItem!.insertText.value).not.toContain("max_words");
  });

  it("snippet includes file ref placeholder", () => {
    const doc = makeDoc(`${root}/caller.lm`, ['sum']);
    const position = { line: 0, character: 3 };
    const items = provider.provideCompletionItems(doc, position, {} as any, {} as any);
    const huItem = items!.find((i: any) => i.label === "summarize");
    expect(huItem!.insertText.value).toContain("path/to/file");
  });

  it("snippet shows numeric default without quotes", () => {
    const doc = makeDoc(`${root}/caller.lm`, ['sum']);
    const position = { line: 0, character: 3 };
    const items = provider.provideCompletionItems(doc, position, {} as any, {} as any);
    const huItem = items!.find((i: any) => i.label === "summarize");
    expect(huItem!.insertText.value).toMatch(/max_words=\$\{\d+:100\}/);
  });

  it("param completion inside parens shows all params for .hu", () => {
    const doc = makeDoc(`${root}/caller.lm`, ['summarize(']);
    const position = { line: 0, character: 10 };
    const items = provider.provideCompletionItems(doc, position, {} as any, {} as any);
    expect(items).toBeDefined();
    const names = items!.map((i: any) => i.filterText);
    expect(names).toContain("article_path");
    expect(names).toContain("aspect");
    expect(names).toContain("max_words");
  });

  it("param completion for .lm def shows only signature params", () => {
    const doc = makeDoc(`${root}/caller.lm`, ['summarize2(']);
    const position = { line: 0, character: 11 };
    const items = provider.provideCompletionItems(doc, position, {} as any, {} as any);
    expect(items).toBeDefined();
    const names = items!.map((i: any) => i.filterText);
    expect(names).toContain("aspect");
    expect(names).toContain("max_word");
    // Template params must NOT appear
    expect(names).not.toContain("max_words");
    expect(names).not.toContain("article_path");
  });
});
