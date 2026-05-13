import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("./lamiaDebugRuntime", () => ({
  resolveLamiaCli: () => "/usr/bin/lamia",
}));

vi.mock("./symbolIndex", () => ({
  findCallableByName: (name: string) => {
    if (name === "summarize") {
      return {
        kind: "hu",
        name: "summarize",
        params: ["aspect", "max_words", "article_path"],
        paramDetails: [
          { name: "aspect", required: true },
          { name: "max_words", required: false, defaultValue: "200" },
          { name: "article_path", required: true, isFileRef: true },
        ],
        filePath: "/tmp/summarize.hu",
        relativePath: "summarize.hu",
      };
    }
    return undefined;
  },
}));

const onDidChangeHandlers: Function[] = [];
const onDidOpenHandlers: Function[] = [];
const onDidSaveHandlers: Function[] = [];
const onDidCloseHandlers: Function[] = [];

const mockDiagnosticCollection = {
  set: vi.fn(),
  delete: vi.fn(),
  dispose: vi.fn(),
};

let mockTextDocuments: any[] = [];

vi.mock("vscode", () => ({
  languages: {
    createDiagnosticCollection: () => mockDiagnosticCollection,
  },
  workspace: {
    get textDocuments() {
      return mockTextDocuments;
    },
    onDidChangeTextDocument: vi.fn((cb: Function) => {
      onDidChangeHandlers.push(cb);
      return { dispose: vi.fn() };
    }),
    onDidOpenTextDocument: vi.fn((cb: Function) => {
      onDidOpenHandlers.push(cb);
      return { dispose: vi.fn() };
    }),
    onDidSaveTextDocument: vi.fn((cb: Function) => {
      onDidSaveHandlers.push(cb);
      return { dispose: vi.fn() };
    }),
    onDidCloseTextDocument: vi.fn((cb: Function) => {
      onDidCloseHandlers.push(cb);
      return { dispose: vi.fn() };
    }),
  },
  window: {},
  Range: class {
    constructor(
      public startLine: number,
      public startChar: number,
      public endLine: number,
      public endChar: number,
    ) {}
  },
  Diagnostic: class {
    source = "";
    constructor(
      public range: any,
      public message: string,
      public severity: number,
    ) {}
  },
  DiagnosticSeverity: {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3,
  },
  Uri: {
    file: (p: string) => ({ fsPath: p }),
  },
}));

import { LamiaDiagnosticsProvider } from "./diagnosticsProvider";
import { execFile } from "child_process";

const mockExecFile = vi.mocked(execFile);

describe("LamiaDiagnosticsProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    onDidChangeHandlers.length = 0;
    onDidOpenHandlers.length = 0;
    onDidSaveHandlers.length = 0;
    onDidCloseHandlers.length = 0;
    mockTextDocuments = [];
    new LamiaDiagnosticsProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function fireOpen(doc: any): void {
    for (const h of onDidOpenHandlers) h(doc);
  }

  function fireChange(event: any): void {
    for (const h of onDidChangeHandlers) h(event);
  }

  function fireClose(doc: any): void {
    for (const h of onDidCloseHandlers) h(doc);
  }

  it("calls lamia inspect on file open for .lm files", () => {
    const doc = { uri: { fsPath: "/tmp/test.lm" }, fileName: "/tmp/test.lm" };
    fireOpen(doc);

    expect(mockExecFile).toHaveBeenCalledWith(
      "/usr/bin/lamia",
      ["inspect", "/tmp/test.lm", "--json"],
      expect.objectContaining({ timeout: 15_000 }),
      expect.any(Function),
    );
  });

  it("does not call inspect for non-lamia files", () => {
    const doc = { uri: { fsPath: "/tmp/test.py" }, fileName: "/tmp/test.py" };
    fireOpen(doc);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("debounces on-change events", () => {
    const doc = { uri: { fsPath: "/tmp/edit.lm" }, fileName: "/tmp/edit.lm" };
    fireChange({ document: doc });
    fireChange({ document: doc });
    fireChange({ document: doc });

    expect(mockExecFile).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("sets diagnostics from inspect output", () => {
    const doc = { uri: { fsPath: "/tmp/err.lm" }, fileName: "/tmp/err.lm" };
    mockTextDocuments = [
      {
        uri: { fsPath: "/tmp/err.lm" },
        lineAt: () => ({ text: "def foo(" }),
      },
    ];
    fireOpen(doc);

    const callback = mockExecFile.mock.calls[0][3] as Function;
    callback(
      null,
      JSON.stringify({
        executable: false,
        steps: [],
        diagnostics: [
          {
            severity: "error",
            message: "'(' was never closed",
            line: 3,
            col: 7,
            source: "lamia-parser",
          },
        ],
      }),
    );

    expect(mockDiagnosticCollection.set).toHaveBeenCalledTimes(1);
    const [uri, diagnostics] = mockDiagnosticCollection.set.mock.calls[0];
    expect(uri.fsPath).toBe("/tmp/err.lm");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toBe("'(' was never closed");
    expect(diagnostics[0].severity).toBe(0);
    expect(diagnostics[0].source).toBe("lamia");
  });

  it("clears diagnostics when file has no errors", () => {
    const doc = { uri: { fsPath: "/tmp/ok.lm" }, fileName: "/tmp/ok.lm" };
    fireOpen(doc);

    const callback = mockExecFile.mock.calls[0][3] as Function;
    callback(null, JSON.stringify({ executable: true, steps: [1] }));

    expect(mockDiagnosticCollection.set).toHaveBeenCalledWith(
      { fsPath: "/tmp/ok.lm" },
      [],
    );
  });

  it("clears diagnostics on file close", () => {
    const doc = { uri: { fsPath: "/tmp/closed.lm" }, fileName: "/tmp/closed.lm" };
    fireClose(doc);
    expect(mockDiagnosticCollection.delete).toHaveBeenCalledWith(doc.uri);
  });

  it("ignores .hu files (templates have no syntax to check)", () => {
    const doc = { uri: { fsPath: "/tmp/test.hu" }, fileName: "/tmp/test.hu" };
    fireOpen(doc);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("maps warning severity correctly", () => {
    const doc = { uri: { fsPath: "/tmp/w.lm" }, fileName: "/tmp/w.lm" };
    mockTextDocuments = [
      {
        uri: { fsPath: "/tmp/w.lm" },
        lineAt: () => ({ text: "some code" }),
      },
    ];
    fireOpen(doc);

    const callback = mockExecFile.mock.calls[0][3] as Function;
    callback(
      null,
      JSON.stringify({
        executable: false,
        steps: [],
        diagnostics: [
          { severity: "warning", message: "unused var", line: 1, col: 0, source: "lamia" },
        ],
      }),
    );

    const [, diagnostics] = mockDiagnosticCollection.set.mock.calls[0];
    expect(diagnostics[0].severity).toBe(1);
  });

  it("handles inspect error gracefully by still running semantic checks", () => {
    const lines = ["print('hello')"];
    const doc = { uri: { fsPath: "/tmp/crash.lm" }, fileName: "/tmp/crash.lm" };
    mockTextDocuments = [
      {
        uri: { fsPath: "/tmp/crash.lm" },
        lineCount: lines.length,
        lineAt: (i: number) => ({ text: lines[i] }),
      },
    ];
    fireOpen(doc);

    const callback = mockExecFile.mock.calls[0][3] as Function;
    callback(new Error("lamia not found"), "");

    expect(mockDiagnosticCollection.set).toHaveBeenCalledWith(
      { fsPath: "/tmp/crash.lm" },
      [],
    );
  });

  it("underlines the whole error line when col is 0", () => {
    const doc = { uri: { fsPath: "/tmp/line.lm" }, fileName: "/tmp/line.lm" };
    mockTextDocuments = [
      {
        uri: { fsPath: "/tmp/line.lm" },
        lineAt: () => ({ text: "invalid syntax here" }),
        lineCount: 1,
      },
    ];
    fireOpen(doc);

    const callback = mockExecFile.mock.calls[0][3] as Function;
    callback(
      null,
      JSON.stringify({
        executable: false,
        steps: [],
        diagnostics: [
          { severity: "error", message: "bad syntax", line: 1, col: 0, source: "lamia-ast" },
        ],
      }),
    );

    const [, diagnostics] = mockDiagnosticCollection.set.mock.calls[0];
    expect(diagnostics[0].range.startChar).toBe(0);
    expect(diagnostics[0].range.endChar).toBe(19);
  });

  it("reports missing required arguments for known function calls", () => {
    const lines = [
      'result = summarize(aspect="key findings", max_words=200)',
      "print(result)",
    ];
    const doc = {
      uri: { fsPath: "/tmp/caller.lm" },
      fileName: "/tmp/caller.lm",
    };
    mockTextDocuments = [
      {
        uri: { fsPath: "/tmp/caller.lm" },
        lineCount: lines.length,
        lineAt: (i: number) => ({ text: lines[i] }),
      },
    ];
    fireOpen(doc);

    const callback = mockExecFile.mock.calls[0][3] as Function;
    callback(null, JSON.stringify({ executable: true, steps: [1, 2] }));

    const [, diagnostics] = mockDiagnosticCollection.set.mock.calls[0];
    const missing = diagnostics.filter((d: any) =>
      d.message.includes("missing required argument"),
    );
    expect(missing).toHaveLength(1);
    expect(missing[0].message).toContain("article_path");
    expect(missing[0].severity).toBe(0);
    expect(missing[0].source).toBe("lamia");
  });

  it("does not report error when all required args are provided", () => {
    const lines = [
      'summarize(aspect="x", article_path="report.txt", max_words=100)',
    ];
    const doc = {
      uri: { fsPath: "/tmp/ok_call.lm" },
      fileName: "/tmp/ok_call.lm",
    };
    mockTextDocuments = [
      {
        uri: { fsPath: "/tmp/ok_call.lm" },
        lineCount: lines.length,
        lineAt: (i: number) => ({ text: lines[i] }),
      },
    ];
    fireOpen(doc);

    const callback = mockExecFile.mock.calls[0][3] as Function;
    callback(null, JSON.stringify({ executable: true, steps: [1] }));

    const [, diagnostics] = mockDiagnosticCollection.set.mock.calls[0];
    expect(diagnostics).toHaveLength(0);
  });

  it("does not flag builtins like print", () => {
    const lines = ["print(result)"];
    const doc = {
      uri: { fsPath: "/tmp/builtin.lm" },
      fileName: "/tmp/builtin.lm",
    };
    mockTextDocuments = [
      {
        uri: { fsPath: "/tmp/builtin.lm" },
        lineCount: lines.length,
        lineAt: (i: number) => ({ text: lines[i] }),
      },
    ];
    fireOpen(doc);

    const callback = mockExecFile.mock.calls[0][3] as Function;
    callback(null, JSON.stringify({ executable: true, steps: [1] }));

    const [, diagnostics] = mockDiagnosticCollection.set.mock.calls[0];
    expect(diagnostics).toHaveLength(0);
  });

  it("flags unresolved function calls", () => {
    const lines = ['summarize23(aspect="key findings")'];
    const doc = {
      uri: { fsPath: "/tmp/unresolved.lm" },
      fileName: "/tmp/unresolved.lm",
    };
    mockTextDocuments = [
      {
        uri: { fsPath: "/tmp/unresolved.lm" },
        lineCount: lines.length,
        lineAt: (i: number) => ({ text: lines[i] }),
      },
    ];
    fireOpen(doc);

    const callback = mockExecFile.mock.calls[0][3] as Function;
    callback(null, JSON.stringify({ executable: true, steps: [1] }));

    const [, diagnostics] = mockDiagnosticCollection.set.mock.calls[0];
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("Unresolved function");
    expect(diagnostics[0].message).toContain("summarize23");
  });

  it("does not flag method calls with dot prefix", () => {
    const lines = ['web.navigate("https://example.com")'];
    const doc = {
      uri: { fsPath: "/tmp/dotcall.lm" },
      fileName: "/tmp/dotcall.lm",
    };
    mockTextDocuments = [
      {
        uri: { fsPath: "/tmp/dotcall.lm" },
        lineCount: lines.length,
        lineAt: (i: number) => ({ text: lines[i] }),
      },
    ];
    fireOpen(doc);

    const callback = mockExecFile.mock.calls[0][3] as Function;
    callback(null, JSON.stringify({ executable: true, steps: [1] }));

    const [, diagnostics] = mockDiagnosticCollection.set.mock.calls[0];
    expect(diagnostics).toHaveLength(0);
  });

  it("does not flag locally defined functions", () => {
    const lines = [
      "def my_helper():",
      '    "do something"',
      "",
      "my_helper()",
    ];
    const doc = {
      uri: { fsPath: "/tmp/localdef.lm" },
      fileName: "/tmp/localdef.lm",
    };
    mockTextDocuments = [
      {
        uri: { fsPath: "/tmp/localdef.lm" },
        lineCount: lines.length,
        lineAt: (i: number) => ({ text: lines[i] }),
      },
    ];
    fireOpen(doc);

    const callback = mockExecFile.mock.calls[0][3] as Function;
    callback(null, JSON.stringify({ executable: true, steps: [4] }));

    const [, diagnostics] = mockDiagnosticCollection.set.mock.calls[0];
    expect(diagnostics).toHaveLength(0);
  });

  it("warns when inline def template references params not in signature", () => {
    const lines = [
      "def summarize2(aspect, max_word) -> HTML:",
      '    "Summarize: {@article_path}. Focus on {aspect}, under {max_words:200} words."',
    ];
    const doc = {
      uri: { fsPath: "/tmp/mismatch.lm" },
      fileName: "/tmp/mismatch.lm",
    };
    mockTextDocuments = [
      {
        uri: { fsPath: "/tmp/mismatch.lm" },
        lineCount: lines.length,
        lineAt: (i: number) => ({ text: lines[i] }),
      },
    ];
    fireOpen(doc);

    const callback = mockExecFile.mock.calls[0][3] as Function;
    callback(null, JSON.stringify({ executable: false, steps: [] }));

    const [, diagnostics] = mockDiagnosticCollection.set.mock.calls[0];
    const mismatchDiags = diagnostics.filter((d: any) =>
      d.message.includes("not in the function signature"),
    );
    expect(mismatchDiags).toHaveLength(1);
    expect(mismatchDiags[0].message).toContain("article_path");
    expect(mismatchDiags[0].message).toContain("max_words");
    expect(mismatchDiags[0].severity).toBe(1);
  });

  it("no warning when all template refs are in signature", () => {
    const lines = [
      "def greet(name, greeting) -> HTML:",
      '    "Say {greeting} to {name}"',
    ];
    const doc = {
      uri: { fsPath: "/tmp/ok_def.lm" },
      fileName: "/tmp/ok_def.lm",
    };
    mockTextDocuments = [
      {
        uri: { fsPath: "/tmp/ok_def.lm" },
        lineCount: lines.length,
        lineAt: (i: number) => ({ text: lines[i] }),
      },
    ];
    fireOpen(doc);

    const callback = mockExecFile.mock.calls[0][3] as Function;
    callback(null, JSON.stringify({ executable: false, steps: [] }));

    const [, diagnostics] = mockDiagnosticCollection.set.mock.calls[0];
    const mismatchDiags = diagnostics.filter((d: any) =>
      d.message.includes("not in the function signature"),
    );
    expect(mismatchDiags).toHaveLength(0);
  });
});
