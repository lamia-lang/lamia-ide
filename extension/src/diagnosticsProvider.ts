import * as vscode from "vscode";
import { execFile } from "child_process";
import { resolveLamiaCli } from "./lamiaDebugRuntime";

interface InspectDiagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  line: number;
  col: number;
  source: string;
}

interface InspectResultEntry {
  executable: boolean;
  steps: number[];
  diagnostics?: InspectDiagnostic[];
}

const DEBOUNCE_MS = 500;
const INSPECT_TIMEOUT_MS = 15_000;

export class LamiaDiagnosticsProvider implements vscode.Disposable {
  private readonly _collection: vscode.DiagnosticCollection;
  private readonly _timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly _disposables: vscode.Disposable[] = [];

  constructor() {
    this._collection = vscode.languages.createDiagnosticCollection("lamia");

    this._disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this._isLamiaFile(e.document)) {
          this._scheduleCheck(e.document);
        }
      }),
    );

    this._disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => {
        if (this._isLamiaFile(doc)) {
          this._runCheck(doc.uri, doc.fileName);
        }
      }),
    );

    this._disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (this._isLamiaFile(doc)) {
          this._runCheck(doc.uri, doc.fileName);
        }
      }),
    );

    this._disposables.push(
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this._collection.delete(doc.uri);
        const timer = this._timers.get(doc.uri.fsPath);
        if (timer) {
          clearTimeout(timer);
          this._timers.delete(doc.uri.fsPath);
        }
      }),
    );

    for (const doc of vscode.workspace.textDocuments) {
      if (this._isLamiaFile(doc)) {
        this._runCheck(doc.uri, doc.fileName);
      }
    }
  }

  dispose(): void {
    for (const timer of this._timers.values()) {
      clearTimeout(timer);
    }
    this._timers.clear();
    this._collection.dispose();
    for (const d of this._disposables) {
      d.dispose();
    }
  }

  private _isLamiaFile(doc: vscode.TextDocument): boolean {
    return doc.uri.fsPath.endsWith(".lm");
  }

  private _scheduleCheck(doc: vscode.TextDocument): void {
    const existing = this._timers.get(doc.uri.fsPath);
    if (existing) {
      clearTimeout(existing);
    }
    this._timers.set(
      doc.uri.fsPath,
      setTimeout(() => {
        this._timers.delete(doc.uri.fsPath);
        this._runCheck(doc.uri, doc.fileName);
      }, DEBOUNCE_MS),
    );
  }

  private _runCheck(uri: vscode.Uri, filePath: string): void {
    const cli = resolveLamiaCli();
    execFile(
      cli,
      ["inspect", filePath, "--json"],
      { timeout: INSPECT_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) {
          this._collection.delete(uri);
          return;
        }

        try {
          const data: InspectResultEntry = JSON.parse(stdout.trim());
          const diagnostics = this._mapDiagnostics(data.diagnostics || [], uri);
          this._collection.set(uri, diagnostics);
        } catch {
          this._collection.delete(uri);
        }
      },
    );
  }

  private _mapDiagnostics(
    raw: InspectDiagnostic[],
    uri: vscode.Uri,
  ): vscode.Diagnostic[] {
    return raw.map((d) => {
      const line = Math.max(0, d.line - 1);
      const col = Math.max(0, d.col);

      const doc = vscode.workspace.textDocuments.find(
        (td) => td.uri.fsPath === uri.fsPath,
      );
      let endCol = col;
      if (doc) {
        const lineText = doc.lineAt(line).text;
        endCol = lineText.length;
      }

      const range = new vscode.Range(line, col, line, endCol);
      const severity = this._mapSeverity(d.severity);
      const diag = new vscode.Diagnostic(range, d.message, severity);
      diag.source = "lamia";
      return diag;
    });
  }

  private _mapSeverity(s: string): vscode.DiagnosticSeverity {
    switch (s) {
      case "error":
        return vscode.DiagnosticSeverity.Error;
      case "warning":
        return vscode.DiagnosticSeverity.Warning;
      case "info":
        return vscode.DiagnosticSeverity.Information;
      default:
        return vscode.DiagnosticSeverity.Error;
    }
  }
}
