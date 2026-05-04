import { describe, it, expect } from "vitest";
import { resolveIdePath } from "./lamiaInstaller";

describe("resolveIdePath", () => {
  it("returns input path on non-mac platforms", () => {
    const appPath = "/usr/local/bin/lamia-studio";
    expect(resolveIdePath(appPath, "linux")).toBe(appPath);
  });

  it("extracts app bundle on macOS", () => {
    const appPath = "/Applications/Lamia Studio.app/Contents/MacOS/Electron";
    expect(resolveIdePath(appPath, "darwin")).toBe("/Applications/Lamia Studio.app");
  });

  it("keeps outer bundle when running from helper app", () => {
    const appPath =
      "/Applications/Lamia Studio.app/Contents/Frameworks/Lamia Studio Helper (Renderer).app/Contents/MacOS/Lamia Studio Helper (Renderer)";
    expect(resolveIdePath(appPath, "darwin")).toBe("/Applications/Lamia Studio.app");
  });
});
