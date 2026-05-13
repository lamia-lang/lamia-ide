import * as vscode from "vscode";
import { execFile } from "child_process";
import { resolveLamiaCli } from "./lamiaDebugRuntime";
import { findCallableByName, CallableSymbol } from "./symbolIndex";

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

const FUNC_CALL_RE = /^(\s*)(?:\w+\s*=\s*)?(\w+)\(([^)]*)\)/;
const INLINE_DEF_RE = /^(\s*)def\s+(\w+)\s*\(([^)]*)\)[^:]*:\s*$/;
const TEMPLATE_PARAM_RE = /\{(\w+)(?::[^}]*)?\}/g;
const TEMPLATE_FILE_REF_RE = /\{@(\w+)\}/g;

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
          const semanticDiags = this._checkCallSites(uri);
          this._collection.set(uri, semanticDiags);
          return;
        }

        try {
          const data: InspectResultEntry = JSON.parse(stdout.trim());
          const syntaxDiags = this._mapDiagnostics(data.diagnostics || [], uri);
          const semanticDiags = this._checkCallSites(uri);
          this._collection.set(uri, [...syntaxDiags, ...semanticDiags]);
        } catch {
          const semanticDiags = this._checkCallSites(uri);
          this._collection.set(uri, semanticDiags);
        }
      },
    );
  }

  private _checkCallSites(uri: vscode.Uri): vscode.Diagnostic[] {
    const doc = vscode.workspace.textDocuments.find(
      (td) => td.uri.fsPath === uri.fsPath,
    );
    if (!doc) return [];

    const diagnostics: vscode.Diagnostic[] = [];
    const lineCount = doc.lineCount;
    const localDefs = _collectLocalDefs(doc);

    for (let i = 0; i < lineCount; i++) {
      const lineText = doc.lineAt(i).text;

      const defDiags = this._checkInlineDefMismatch(doc, i);
      diagnostics.push(...defDiags);

      const match = FUNC_CALL_RE.exec(lineText);
      if (!match) continue;

      const funcName = match[2];
      if (_isBuiltinOrKeyword(funcName)) continue;
      if (localDefs.has(funcName)) continue;
      if (_hasDotPrefix(lineText, funcName)) continue;

      const sym = findCallableByName(funcName, uri.fsPath);

      if (!sym) {
        const callStart = lineText.indexOf(funcName);
        const range = new vscode.Range(i, callStart, i, callStart + funcName.length);
        const diag = new vscode.Diagnostic(
          range,
          `Unresolved function '${funcName}' — no matching .hu file or inline def found`,
          vscode.DiagnosticSeverity.Error,
        );
        diag.source = "lamia";
        diagnostics.push(diag);
        continue;
      }

      const providedArgs = _extractKwargNames(match[3]);
      const missing = _findMissingRequired(sym, providedArgs);

      if (missing.length > 0) {
        const callStart = lineText.indexOf(funcName);
        const range = new vscode.Range(i, callStart, i, lineText.length);
        const msg =
          missing.length === 1
            ? `${funcName}() missing required argument: ${missing[0]}`
            : `${funcName}() missing required arguments: ${missing.join(", ")}`;
        const diag = new vscode.Diagnostic(
          range,
          msg,
          vscode.DiagnosticSeverity.Error,
        );
        diag.source = "lamia";
        diagnostics.push(diag);
      }
    }

    return diagnostics;
  }

  private _checkInlineDefMismatch(
    doc: vscode.TextDocument,
    lineIdx: number,
  ): vscode.Diagnostic[] {
    const lineText = doc.lineAt(lineIdx).text;
    const defMatch = INLINE_DEF_RE.exec(lineText);
    if (!defMatch) return [];

    const funcName = defMatch[2];
    const rawParams = defMatch[3];
    const sigParams = new Set(
      rawParams
        .split(",")
        .map((p) => p.trim().split("=")[0].trim())
        .filter((p) => p.length > 0),
    );

    const bodyLine = lineIdx + 1;
    if (bodyLine >= doc.lineCount) return [];
    const body = doc.lineAt(bodyLine).text;

    const templateParams = new Set<string>();
    let m: RegExpExecArray | null;

    TEMPLATE_PARAM_RE.lastIndex = 0;
    while ((m = TEMPLATE_PARAM_RE.exec(body)) !== null) {
      templateParams.add(m[1]);
    }

    TEMPLATE_FILE_REF_RE.lastIndex = 0;
    while ((m = TEMPLATE_FILE_REF_RE.exec(body)) !== null) {
      templateParams.add(m[1]);
    }

    const missing: string[] = [];
    for (const tp of templateParams) {
      if (!sigParams.has(tp)) {
        missing.push(tp);
      }
    }

    if (missing.length === 0) return [];

    const defStart = lineText.indexOf("def ");
    const range = new vscode.Range(lineIdx, defStart, lineIdx, lineText.length);
    const msg =
      `${funcName}() template references ${missing.map((n) => "'" + n + "'").join(", ")} ` +
      `but ${missing.length === 1 ? "it is" : "they are"} not in the function signature`;
    const diag = new vscode.Diagnostic(
      range,
      msg,
      vscode.DiagnosticSeverity.Warning,
    );
    diag.source = "lamia";
    return [diag];
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

const PYTHON_BUILTINS = new Set([
  "print", "len", "range", "str", "int", "float", "list", "dict", "set",
  "tuple", "type", "isinstance", "open", "super", "enumerate", "zip", "map",
  "filter", "sorted", "reversed", "any", "all", "min", "max", "sum", "abs",
  "round", "getattr", "setattr", "delattr", "vars", "dir", "id", "hash",
  "input", "format", "repr", "bool", "bytes", "bytearray", "memoryview",
  "object", "staticmethod", "classmethod", "property",
]);

const KEYWORDS = new Set([
  "if", "else", "elif", "for", "while", "def", "class", "import", "from",
  "return", "yield", "with", "as", "try", "except", "finally", "raise",
  "pass", "break", "continue", "and", "or", "not", "in", "is", "lambda",
  "global", "nonlocal", "assert", "del", "async", "await",
]);

function _isBuiltinOrKeyword(name: string): boolean {
  return PYTHON_BUILTINS.has(name) || KEYWORDS.has(name);
}

const LOCAL_DEF_RE = /^def\s+(\w+)\s*\(/;

function _collectLocalDefs(doc: { lineCount: number; lineAt(i: number): { text: string } }): Set<string> {
  const defs = new Set<string>();
  for (let i = 0; i < doc.lineCount; i++) {
    const m = LOCAL_DEF_RE.exec(doc.lineAt(i).text);
    if (m) defs.add(m[1]);
  }
  return defs;
}

function _hasDotPrefix(lineText: string, funcName: string): boolean {
  const idx = lineText.indexOf(funcName + "(");
  if (idx <= 0) return false;
  return lineText[idx - 1] === ".";
}

function _extractKwargNames(argsStr: string): Set<string> {
  const names = new Set<string>();
  if (!argsStr.trim()) return names;

  const parts = _splitArgs(argsStr);
  for (const part of parts) {
    const eqIdx = part.indexOf("=");
    if (eqIdx > 0) {
      const key = part.slice(0, eqIdx).trim();
      if (/^\w+$/.test(key)) {
        names.add(key);
      }
    }
  }
  return names;
}

function _splitArgs(argsStr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let inStr: string | null = null;

  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];
    if (inStr) {
      current += ch;
      if (ch === inStr && argsStr[i - 1] !== "\\") {
        inStr = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      current += ch;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      current += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function _findMissingRequired(sym: CallableSymbol, provided: Set<string>): string[] {
  const missing: string[] = [];
  for (const p of sym.paramDetails) {
    if (!p.required) continue;
    if (!provided.has(p.name)) {
      missing.push(p.name);
    }
  }
  return missing;
}
