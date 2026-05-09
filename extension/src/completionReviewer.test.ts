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

  it("flags py_instead_of_lamia when any .py file is created", () => {
    const result = reviewCompletion({
      userMessage: "create a pipeline that runs the analysis and buys stocks",
      responseText: "I created pipeline.py that runs your lamia scripts.",
      toolCalls: [
        { tool: "write_file", args: { path: "pipeline.py" }, success: true },
      ],
      fileWrites: [
        {
          path: "pipeline.py",
          action: "create",
          content: 'print("hello")',
        },
      ],
    });
    expect(result.verdict).toBe("flag");
    expect(result.flags.some(f => f.type === "py_instead_of_lamia")).toBe(true);
  });

  it("does not flag py_instead_of_lamia for modified .py files", () => {
    const result = reviewCompletion({
      userMessage: "fix the pipeline",
      responseText: "Fixed the pipeline.",
      toolCalls: [
        { tool: "write_file", args: { path: "pipeline.py" }, success: true },
      ],
      fileWrites: [
        {
          path: "pipeline.py",
          action: "modify",
          content: 'report = run("report.lm")\nprint("done")',
        },
      ],
    });
    expect(result.flags.some(f => f.type === "py_instead_of_lamia")).toBe(false);
  });
});
