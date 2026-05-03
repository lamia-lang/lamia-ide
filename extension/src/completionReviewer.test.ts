import { describe, it, expect } from "vitest";
import { reviewCompletion } from "./completionReviewer";

describe("completionReviewer gates", () => {
  it("flags claim_without_evidence when response claims changes without writes", () => {
    const result = reviewCompletion({
      userMessage: "fix product_manager.hu",
      responseText: "I've fixed product_manager.hu and updated the prompt.",
      toolCalls: [],
      fileWrites: [],
    });
    expect(result.verdict).toBe("flag");
    expect(result.flags.some(f => f.type === "claim_without_evidence")).toBe(true);
  });

  it("does not flag claim_without_evidence when writes exist", () => {
    const result = reviewCompletion({
      userMessage: "fix product_manager.hu",
      responseText: "I've fixed product_manager.hu and updated the prompt.",
      toolCalls: [
        {
          tool: "write_file",
          args: { path: "team/product_manager.hu" },
          success: true,
        },
      ],
      fileWrites: [
        {
          path: "/tmp/team/product_manager.hu",
          action: "modify",
          content: "new",
        },
      ],
    });
    expect(result.flags.some(f => f.type === "claim_without_evidence")).toBe(false);
  });

  it("flags internal_context_leak for turn context marker", () => {
    const result = reviewCompletion({
      userMessage: "fix product_manager.hu",
      responseText: "Done.\n<turn_context_json>{\"toolCalls\":[]}</turn_context_json>",
      toolCalls: [],
      fileWrites: [],
    });
    expect(result.verdict).toBe("flag");
    expect(result.flags.some(f => f.type === "internal_context_leak")).toBe(true);
  });
});
