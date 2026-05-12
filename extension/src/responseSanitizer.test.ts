import { describe, it, expect } from "vitest";
import { sanitizeAssistantResponseText } from "./responseSanitizer";

describe("sanitizeAssistantResponseText", () => {
  it("removes full execution_summary blocks", () => {
    const input = [
      "I fixed orchestrator.lm.",
      "",
      "[execution_summary]",
      "tools_used: read_file, get_docs, patch_file",
      "files_changed: modify:/tmp/orchestrator.lm",
      "[/execution_summary]",
    ].join("\n");

    const out = sanitizeAssistantResponseText(input);
    expect(out).toBe("I fixed orchestrator.lm.");
  });

  it("removes unclosed execution_summary from open tag onward", () => {
    const input = [
      "All done.",
      "[execution_summary]",
      "tools_used: patch_file",
    ].join("\n");

    const out = sanitizeAssistantResponseText(input);
    expect(out).toBe("All done.");
  });

  it("keeps normal user-facing text untouched", () => {
    const input = "Updated the lm function and added tests.";
    const out = sanitizeAssistantResponseText(input);
    expect(out).toBe(input);
  });

  it("does not strip normal bracket content", () => {
    const input = "Use [note] for annotations and [/note] to close.";
    const out = sanitizeAssistantResponseText(input);
    expect(out).toBe(input);
  });
});
