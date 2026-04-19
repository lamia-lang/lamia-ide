import * as vscode from "vscode";

const DEF_RE = /^([ \t]*)(?:async\s+)?def\s+(\w+)\s*\(/gm;
const CLASS_RE = /^([ \t]*)class\s+(\w+)\s*[\(:]/gm;
const PARAM_RE = /\{(\w+)(?::([^}]*))?\}/g;
const FILE_REF_RE = /\{@(\w+)\}/g;

export class LamiaDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): vscode.DocumentSymbol[] {
    if (document.languageId === "lamia-prompt") {
      return this._huSymbols(document);
    }
    return this._lmSymbols(document);
  }

  private _lmSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    const text = document.getText();
    const symbols: vscode.DocumentSymbol[] = [];

    this._collectMatches(text, DEF_RE, document, vscode.SymbolKind.Function, symbols);
    this._collectMatches(text, CLASS_RE, document, vscode.SymbolKind.Class, symbols);

    symbols.sort((a, b) => a.range.start.line - b.range.start.line);
    return symbols;
  }

  private _collectMatches(
    text: string,
    regex: RegExp,
    document: vscode.TextDocument,
    kind: vscode.SymbolKind,
    out: vscode.DocumentSymbol[],
  ): void {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      const name = m[2];
      const pos = document.positionAt(m.index);
      const endOfLine = document.lineAt(pos.line).range.end;
      const range = new vscode.Range(pos, endOfLine);
      out.push(new vscode.DocumentSymbol(name, "", kind, range, range));
    }
  }

  private _huSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    const text = document.getText();
    const symbols: vscode.DocumentSymbol[] = [];
    const fullRange = new vscode.Range(0, 0, document.lineCount - 1, 0);
    const name = document.uri.path.split("/").pop()?.replace(".hu", "") ?? "prompt";

    const container = new vscode.DocumentSymbol(
      name,
      "hu function",
      vscode.SymbolKind.Function,
      fullRange,
      new vscode.Range(0, 0, 0, 0),
    );

    const seen = new Set<string>();

    PARAM_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PARAM_RE.exec(text)) !== null) {
      const pName = m[1];
      if (pName.startsWith("@") || seen.has(pName)) continue;
      seen.add(pName);
      const pos = document.positionAt(m.index);
      const range = new vscode.Range(pos, document.positionAt(m.index + m[0].length));
      container.children.push(
        new vscode.DocumentSymbol(pName, "param", vscode.SymbolKind.Variable, range, range),
      );
    }

    FILE_REF_RE.lastIndex = 0;
    while ((m = FILE_REF_RE.exec(text)) !== null) {
      const ref = m[1];
      if (seen.has(ref)) continue;
      seen.add(ref);
      const pos = document.positionAt(m.index);
      const range = new vscode.Range(pos, document.positionAt(m.index + m[0].length));
      container.children.push(
        new vscode.DocumentSymbol(ref, "file param", vscode.SymbolKind.File, range, range),
      );
    }

    symbols.push(container);
    return symbols;
  }
}
