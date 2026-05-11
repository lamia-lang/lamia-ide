import { describe, it, expect, beforeEach, vi } from "vitest";
import * as path from "path";

vi.mock("vscode", () => ({
  workspace: { workspaceFolders: [] },
}));

import { findHuByName, invalidateSymbols, getHuSymbols } from "./symbolIndex";
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
