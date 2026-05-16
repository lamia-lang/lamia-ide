import { describe, it, expect } from "vitest";
import { buildFileContextPrefix } from "./chatProvider";

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
