import * as path from "path";
import * as vscode from "vscode";
import { getHuSymbols, findHuByName, HuSymbol, HuParam } from "./symbolIndex";

export class LamiaCompletionProvider implements vscode.CompletionItemProvider {

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext,
  ): vscode.CompletionItem[] | undefined {
    const lineText = document.lineAt(position).text;
    const textBefore = lineText.substring(0, position.character);
    const ctxFile = document.uri.fsPath;

    const paramCtx = this._paramContext(textBefore, ctxFile);
    if (paramCtx) {
      return this._completeParams(paramCtx);
    }

    return this._completeFunctionNames(textBefore, ctxFile);
  }

  // ── Function name completion ────────────────────────────────────────────

  private _completeFunctionNames(textBefore: string, ctxFile: string): vscode.CompletionItem[] | undefined {
    const wordMatch = textBefore.match(/([a-zA-Z_]\w*)$/);
    if (!wordMatch) return undefined;

    const prefix = wordMatch[1].toLowerCase();
    const symbols = getHuSymbols(ctxFile);
    const ctxDir = path.dirname(ctxFile);
    symbols.sort((a, b) => {
      const distA = path.relative(ctxDir, path.dirname(a.filePath)).split(path.sep).length;
      const distB = path.relative(ctxDir, path.dirname(b.filePath)).split(path.sep).length;
      return distA - distB;
    });
    const items: vscode.CompletionItem[] = [];

    for (const sym of symbols) {
      if (!sym.name.toLowerCase().startsWith(prefix)) continue;

      const item = new vscode.CompletionItem(
        sym.name,
        vscode.CompletionItemKind.Function,
      );
      item.detail = `${sym.relativePath}`;
      const reqParams = sym.paramDetails.filter((p) => p.required);
      const optParams = sym.paramDetails.filter((p) => !p.required);
      const docParts: string[] = [];
      if (reqParams.length > 0) {
        docParts.push(`Required: ${reqParams.map((p) => formatParamDoc(p)).join(", ")}`);
      }
      if (optParams.length > 0) {
        docParts.push(`Optional: ${optParams.map((p) => formatParamDoc(p)).join(", ")}`);
      }
      item.documentation = docParts.length > 0 ? docParts.join("\n") : "No parameters";

      const allParams = [...reqParams, ...optParams];
      if (allParams.length > 0) {
        const paramSnippet = allParams
          .map((p, i) => formatParamSnippet(p, i + 1))
          .join(", ");
        item.insertText = new vscode.SnippetString(`${sym.name}(${paramSnippet})`);
      } else {
        item.insertText = new vscode.SnippetString(`${sym.name}()`);
      }

      item.filterText = sym.name;
      item.sortText = `0_${sym.name}`;
      items.push(item);
    }

    return items.length > 0 ? items : undefined;
  }

  // ── Parameter completion (inside parens) ──────────────────────────────

  private _paramContext(textBefore: string, ctxFile: string): HuSymbol | null {
    const m = textBefore.match(/([a-zA-Z_]\w*)\s*\([^)]*$/);
    if (!m) return null;
    return findHuByName(m[1], ctxFile) ?? null;
  }

  private _completeParams(sym: HuSymbol): vscode.CompletionItem[] | undefined {
    if (sym.paramDetails.length === 0) return undefined;

    const items: vscode.CompletionItem[] = [];
    for (const pd of sym.paramDetails) {
      const defaultDisplay = pd.defaultValue ? `=${formatDefaultDisplay(pd.defaultValue)}` : "";
      const label = pd.required
        ? `${pd.name}=`
        : `${pd.name}${defaultDisplay}  (optional)`;
      const item = new vscode.CompletionItem(
        label,
        pd.required ? vscode.CompletionItemKind.Field : vscode.CompletionItemKind.Property,
      );
      item.detail = pd.required
        ? `${sym.name} param (required)`
        : `${sym.name} param (optional, default: ${formatDefaultDisplay(pd.defaultValue ?? "")})`;
      item.insertText = pd.isFileRef
        ? new vscode.SnippetString(`${pd.name}="\${1:path/to/file}"`)
        : formatParamInsert(pd);
      item.sortText = pd.required ? `0_${pd.name}` : `1_${pd.name}`;
      item.filterText = pd.name;
      items.push(item);
    }

    return items;
  }
}

function isPrimitiveLiteral(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value) || value === "true" || value === "false";
}

function formatDefaultDisplay(value: string): string {
  if (!value) return '""';
  if (isPrimitiveLiteral(value)) return value;
  return `"${value}"`;
}

function formatParamSnippet(p: HuParam, tabStop: number): string {
  if (p.isFileRef) {
    return `${p.name}="\${${tabStop}:path/to/file}"`;
  }
  if (!p.required && p.defaultValue) {
    if (isPrimitiveLiteral(p.defaultValue)) {
      return `${p.name}=\${${tabStop}:${p.defaultValue}}`;
    }
    return `${p.name}=\${${tabStop}:${p.defaultValue}}`;
  }
  return `${p.name}="\${${tabStop}}"`;
}

function formatParamInsert(p: HuParam): vscode.SnippetString {
  if (!p.required && p.defaultValue) {
    if (isPrimitiveLiteral(p.defaultValue)) {
      return new vscode.SnippetString(`${p.name}=\${1:${p.defaultValue}}`);
    }
    return new vscode.SnippetString(`${p.name}=\${1:${p.defaultValue}}`);
  }
  return new vscode.SnippetString(`${p.name}="\${1}"`);
}

function formatParamDoc(p: HuParam): string {
  if (p.isFileRef) return `${p.name} (file)`;
  if (p.defaultValue) {
    return `${p.name}=${formatDefaultDisplay(p.defaultValue)}`;
  }
  return p.name;
}
