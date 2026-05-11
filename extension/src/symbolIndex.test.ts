import { describe, it, expect, beforeEach, vi } from "vitest";
import * as path from "path";

vi.mock("vscode", () => ({
  workspace: { workspaceFolders: [] },
}));

import { findHuByName, findCallableByName, invalidateSymbols, getHuSymbols, getLmDefSymbols } from "./symbolIndex";
import * as fs from "fs";

vi.mock("fs");

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
        entries.push({
          name,
          isFile: () => true,
          isDirectory: () => false,
        } as fs.Dirent);
      }
    }
    const subdirs = new Set<string>();
    for (const full of Object.keys(fileMap)) {
      if (full.startsWith(d + path.sep)) {
        const rel = full.slice(d.length + 1);
        const firstSeg = rel.split(path.sep)[0];
        if (rel.includes(path.sep)) {
          subdirs.add(firstSeg);
        }
      }
    }
    for (const sub of subdirs) {
      entries.push({
        name: sub,
        isFile: () => false,
        isDirectory: () => true,
      } as fs.Dirent);
    }
    return entries;
  });
  mockedFs.readFileSync.mockImplementation((p: fs.PathOrFileDescriptor, _enc?: any) => {
    const s = String(p);
    if (s in fileMap) return fileMap[s];
    throw new Error(`ENOENT: ${s}`);
  });
}

describe("findHuByName proximity", () => {
  beforeEach(() => {
    invalidateSymbols();
  });

  it("returns the closest .hu file when duplicates exist", () => {
    const root = "/project";
    const files: Record<string, string> = {
      [`${root}/a/summarize.hu`]: "Summarize {text}",
      [`${root}/b/summarize.hu`]: "Summarize {text} (far)",
    };
    setupFiles(files);
    const contextFile = `${root}/a/caller.lm`;
    const result = findHuByName("summarize", contextFile);
    expect(result).toBeDefined();
    expect(result!.filePath).toBe(`${root}/a/summarize.hu`);
  });

  it("returns the closest .hu file when context is in sibling dir", () => {
    const root = "/project";
    const files: Record<string, string> = {
      [`${root}/deep/nested/summarize.hu`]: "Summarize {text}",
      [`${root}/summarize.hu`]: "Summarize {text}",
    };
    setupFiles(files);
    const contextFile = `${root}/caller.lm`;
    const result = findHuByName("summarize", contextFile);
    expect(result).toBeDefined();
    expect(result!.filePath).toBe(`${root}/summarize.hu`);
  });

  it("marks file refs as required with isFileRef", () => {
    const root = "/project";
    const files: Record<string, string> = {
      [`${root}/review.hu`]: "Review this: {@code_file}\nFocus on {aspect}",
    };
    setupFiles(files);
    const syms = getHuSymbols(`${root}/test.lm`);
    expect(syms.length).toBe(1);
    const codeFileParam = syms[0].paramDetails.find(p => p.name === "code_file");
    expect(codeFileParam).toBeDefined();
    expect(codeFileParam!.required).toBe(true);
    expect(codeFileParam!.isFileRef).toBe(true);
    const aspectParam = syms[0].paramDetails.find(p => p.name === "aspect");
    expect(aspectParam).toBeDefined();
    expect(aspectParam!.required).toBe(true);
    expect(aspectParam!.isFileRef).toBeUndefined();
  });

  it("preserves numeric defaults without quoting", () => {
    const root = "/project";
    const files: Record<string, string> = {
      [`${root}/summarize.hu`]: "Summarize {text} in {max_words:100} words",
    };
    setupFiles(files);
    const syms = getHuSymbols(`${root}/test.lm`);
    const maxWords = syms[0].paramDetails.find(p => p.name === "max_words");
    expect(maxWords).toBeDefined();
    expect(maxWords!.required).toBe(false);
    expect(maxWords!.defaultValue).toBe("100");
  });
});

describe("parseLmFileDefs", () => {
  beforeEach(() => {
    invalidateSymbols();
  });

  it("parses inline def with params and return type (signature-only)", () => {
    const root = "/project";
    const files: Record<string, string> = {
      [`${root}/main.lm`]: [
        'def summarize2(aspect, max_words) -> HTML:',
        '    "Summarize: {@article_path}. Focus on {aspect} in {max_words:200} words."',
      ].join("\n"),
    };
    setupFiles(files);
    const defs = getLmDefSymbols(`${root}/test.lm`);
    expect(defs.length).toBe(1);
    expect(defs[0].name).toBe("summarize2");
    expect(defs[0].returnType).toBe("HTML");
    expect(defs[0].line).toBe(1);

    // Only signature params are exposed — template internals are not
    expect(defs[0].paramDetails.length).toBe(2);
    const aspectParam = defs[0].paramDetails.find(p => p.name === "aspect");
    expect(aspectParam).toBeDefined();
    expect(aspectParam!.required).toBe(true);

    const maxWordsParam = defs[0].paramDetails.find(p => p.name === "max_words");
    expect(maxWordsParam).toBeDefined();
    expect(maxWordsParam!.required).toBe(true);

    // {@article_path} is a file context ref resolved by Lamia, not a caller param
    expect(defs[0].paramDetails.find(p => p.name === "article_path")).toBeUndefined();
  });

  it("parses def with default values in signature", () => {
    const root = "/project";
    const files: Record<string, string> = {
      [`${root}/main.lm`]: [
        'def greet(name, greeting="Hello") -> HTML:',
        '    "{greeting}, {name}! Welcome."',
      ].join("\n"),
    };
    setupFiles(files);
    const defs = getLmDefSymbols(`${root}/test.lm`);
    expect(defs.length).toBe(1);
    const greetingParam = defs[0].paramDetails.find(p => p.name === "greeting");
    expect(greetingParam!.required).toBe(false);
    expect(greetingParam!.defaultValue).toBe("Hello");
    const nameParam = defs[0].paramDetails.find(p => p.name === "name");
    expect(nameParam!.required).toBe(true);
  });

  it("parses def with numeric default in signature", () => {
    const root = "/project";
    const files: Record<string, string> = {
      [`${root}/main.lm`]: [
        'def paginate(page=1, limit=50) -> JSON:',
        '    "Get page {page} with {limit} items"',
      ].join("\n"),
    };
    setupFiles(files);
    const defs = getLmDefSymbols(`${root}/test.lm`);
    expect(defs.length).toBe(1);
    const page = defs[0].paramDetails.find(p => p.name === "page");
    expect(page!.required).toBe(false);
    expect(page!.defaultValue).toBe("1");
    const limit = defs[0].paramDetails.find(p => p.name === "limit");
    expect(limit!.required).toBe(false);
    expect(limit!.defaultValue).toBe("50");
  });

  it("findCallableByName finds both .hu and .lm defs", () => {
    const root = "/project";
    const files: Record<string, string> = {
      [`${root}/summarize.hu`]: "Summarize {text}",
      [`${root}/main.lm`]: [
        'def analyze(topic) -> JSON:',
        '    "Analyze {topic} in depth"',
      ].join("\n"),
    };
    setupFiles(files);
    const hu = findCallableByName("summarize", `${root}/test.lm`);
    expect(hu).toBeDefined();
    expect(hu!.kind).toBe("hu");
    const lmDef = findCallableByName("analyze", `${root}/test.lm`);
    expect(lmDef).toBeDefined();
    expect(lmDef!.kind).toBe("def");
  });

  it("prefers closest callable by path distance", () => {
    const root = "/project";
    const files: Record<string, string> = {
      [`${root}/a/helper.lm`]: 'def fetch_data(url) -> JSON:\n    "Fetch {url}"',
      [`${root}/b/helper.lm`]: 'def fetch_data(url) -> JSON:\n    "Fetch {url}"',
    };
    setupFiles(files);
    const result = findCallableByName("fetch_data", `${root}/a/caller.lm`);
    expect(result).toBeDefined();
    expect(result!.filePath).toBe(`${root}/a/helper.lm`);
  });

  it("finds inline def from the same file (user scenario)", () => {
    const root = "/project";
    const files: Record<string, string> = {
      [`${root}/summarize.hu`]: "Summarize the following article: {@article_path}\nFocus on {aspect} and keep it under {max_words} words.",
      [`${root}/summarize_caller.lm`]: [
        'result = summarize(aspect="key findings", max_words=200) -> HTML',
        'print(result)',
        '',
        'def summarize2(aspect, max_word) -> HTML:',
        '    "Summarize the following article: {@article_path}. Focus on {aspect} and keep it under {max_words:200} words."',
      ].join("\n"),
    };
    setupFiles(files);
    const ctxFile = `${root}/summarize_caller.lm`;

    const huSym = findCallableByName("summarize", ctxFile);
    expect(huSym).toBeDefined();
    expect(huSym!.kind).toBe("hu");
    expect(huSym!.paramDetails.length).toBeGreaterThan(0);

    const defSym = findCallableByName("summarize2", ctxFile);
    expect(defSym).toBeDefined();
    expect(defSym!.kind).toBe("def");
    // Only signature params: aspect, max_word
    expect(defSym!.paramDetails.length).toBe(2);
    expect(defSym!.paramDetails.map(p => p.name).sort()).toEqual(["aspect", "max_word"]);
    // Template file ref is NOT a caller param
    expect(defSym!.paramDetails.find(p => p.name === "article_path")).toBeUndefined();
  });
});
