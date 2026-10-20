import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("./lamiaDebugRuntime", () => ({
  resolveLamiaCli: () => "/usr/bin/lamia",
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
    createFileSystemWatcher: vi.fn(() => ({
      onDidChange: vi.fn(),
      onDidCreate: vi.fn(),
      dispose: vi.fn(),
    })),
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
import * as vscode from "vscode";

const mockExecFile = vi.mocked(execFile);
const mockStdin = { end: vi.fn() };

describe("LamiaDiagnosticsProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    onDidChangeHandlers.length = 0;
    onDidOpenHandlers.length = 0;
    onDidSaveHandlers.length = 0;
    onDidCloseHandlers.length = 0;
    mockTextDocuments = [];
    mockExecFile.mockReturnValue({ stdin: mockStdin } as any);
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

  it("calls lamia inspect on file open for .hu files", () => {
    const doc = { uri: { fsPath: "/tmp/test.hu" }, fileName: "/tmp/test.hu" };
    fireOpen(doc);

    expect(mockExecFile).toHaveBeenCalledWith(
      "/usr/bin/lamia",
      ["inspect", "/tmp/test.hu", "--json"],
      expect.objectContaining({ timeout: 15_000 }),
      expect.any(Function),
    );
  });

  it("sets .hu lint diagnostics from inspect output", () => {
    const doc = { uri: { fsPath: "/tmp/prompt.hu" }, fileName: "/tmp/prompt.hu" };
    mockTextDocuments = [
      {
        uri: { fsPath: "/tmp/prompt.hu" },
        getText: () => "",
        lineAt: () => ({ text: "# Title" }),
      },
    ];
    mockExecFile.mockImplementationOnce((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(null, JSON.stringify({
        executable: false,
        steps: [],
        diagnostics: [
          { severity: "warning", message: "[HUW002] Markdown headers", line: 1, col: 0, source: "lamia-lint" },
        ],
      }));
      return {} as any;
    });

    fireOpen(doc);

    const diags = mockDiagnosticCollection.set.mock.calls[0][1];
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toBe("[HUW002] Markdown headers");
    expect(diags[0].severity).toBe(1);
  });

  it("sends unsaved editor content via --stdin for open documents", () => {
    const doc = { uri: { fsPath: "/tmp/main.lm" }, fileName: "/tmp/main.lm" };
    mockTextDocuments = [
      {
        uri: { fsPath: "/tmp/main.lm" },
        getText: () => 'clean(raw_row="./in.csv")\n',
        lineAt: () => ({ text: "" }),
      },
    ];
    fireOpen(doc);

    expect(mockExecFile).toHaveBeenCalledWith(
      "/usr/bin/lamia",
      ["inspect", "/tmp/main.lm", "--json", "--stdin"],
      expect.objectContaining({ timeout: 15_000 }),
      expect.any(Function),
    );
    expect(mockStdin.end).toHaveBeenCalledWith('clean(raw_row="./in.csv")\n');
  });

  it("reads from disk when the document is not open", () => {
    const doc = { uri: { fsPath: "/tmp/closed.lm" }, fileName: "/tmp/closed.lm" };
    fireOpen(doc);

    expect(mockExecFile.mock.calls[0][1]).toEqual(["inspect", "/tmp/closed.lm", "--json"]);
    expect(mockStdin.end).not.toHaveBeenCalled();
  });

  it("watches .lm and .hu files on disk", () => {
    expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledWith("**/*.{lm,hu}");
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
        getText: () => "",
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

  it("displays semantic errors from inspect (missing args)", () => {
    const doc = { uri: { fsPath: "/tmp/sem.lm" }, fileName: "/tmp/sem.lm" };
    mockTextDocuments = [
      {
        uri: { fsPath: "/tmp/sem.lm" },
        getText: () => "",
        lineAt: () => ({ text: 'summarize(aspect="key")' }),
      },
    ];
    fireOpen(doc);

    const callback = mockExecFile.mock.calls[0][3] as Function;
    callback(
      null,
      JSON.stringify({
        executable: true,
        steps: [1],
        diagnostics: [
          {
            severity: "error",
            message: "summarize() missing required argument: article_path",
            line: 1,
            col: 0,
            source: "lamia-semantic",
          },
        ],
      }),
    );

    const [, diagnostics] = mockDiagnosticCollection.set.mock.calls[0];
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("missing required argument");
    expect(diagnostics[0].severity).toBe(0);
  });

  it("displays unresolved function errors from inspect", () => {
    const doc = { uri: { fsPath: "/tmp/unr.lm" }, fileName: "/tmp/unr.lm" };
    mockTextDocuments = [
      {
        uri: { fsPath: "/tmp/unr.lm" },
        getText: () => "",
        lineAt: () => ({ text: "nonexistent()" }),
      },
    ];
    fireOpen(doc);

    const callback = mockExecFile.mock.calls[0][3] as Function;
    callback(
      null,
      JSON.stringify({
        executable: true,
        steps: [1],
        diagnostics: [
          {
            severity: "error",
            message: "Unresolved function 'nonexistent' — no matching .hu or .lm function found",
            line: 1,
            col: 0,
            source: "lamia-semantic",
          },
        ],
      }),
    );

    const [, diagnostics] = mockDiagnosticCollection.set.mock.calls[0];
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain("Unresolved function");
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

  it("maps warning severity correctly", () => {
    const doc = { uri: { fsPath: "/tmp/w.lm" }, fileName: "/tmp/w.lm" };
    mockTextDocuments = [
      {
        uri: { fsPath: "/tmp/w.lm" },
        getText: () => "",
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
          { severity: "warning", message: "template mismatch", line: 1, col: 0, source: "lamia-semantic" },
        ],
      }),
    );

    const [, diagnostics] = mockDiagnosticCollection.set.mock.calls[0];
    expect(diagnostics[0].severity).toBe(1);
  });

  it("handles inspect error gracefully by clearing diagnostics", () => {
    const doc = { uri: { fsPath: "/tmp/crash.lm" }, fileName: "/tmp/crash.lm" };
    fireOpen(doc);

    const callback = mockExecFile.mock.calls[0][3] as Function;
    callback(new Error("lamia not found"), "");

    expect(mockDiagnosticCollection.delete).toHaveBeenCalledWith({ fsPath: "/tmp/crash.lm" });
  });

  it("underlines the whole error line when col is 0", () => {
    const doc = { uri: { fsPath: "/tmp/line.lm" }, fileName: "/tmp/line.lm" };
    mockTextDocuments = [
      {
        uri: { fsPath: "/tmp/line.lm" },
        getText: () => "",
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
});
