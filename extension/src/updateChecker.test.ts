import { describe, it, expect } from "vitest";
import { compareVersions } from "./updateChecker";

describe("compareVersions", () => {
  it("returns 0 for equal versions", () => {
    expect(compareVersions("0.1.9", "0.1.9")).toBe(0);
  });

  it("returns positive when first is greater", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
  });

  it("returns negative when first is smaller", () => {
    expect(compareVersions("0.1.9", "0.2.0")).toBeLessThan(0);
  });

  it("handles major version bump", () => {
    expect(compareVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
  });

  it("handles different length versions", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.1", "1.0")).toBeGreaterThan(0);
  });

  it("handles single-segment versions", () => {
    expect(compareVersions("2", "1")).toBeGreaterThan(0);
  });
});
