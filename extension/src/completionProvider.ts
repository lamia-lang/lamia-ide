import * as vscode from "vscode";
import { getHuSymbols, findHuByName, HuSymbol } from "./symbolIndex";

export class LamiaCompletionProvider implements vscode.CompletionItemProvider {

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext,
  ): vscode.CompletionItem[] | undefined {
    const lineText = document.lineAt(position).text;
    const textBefore = lineText.substring(0, position.character);

    const paramCtx = this._paramContext(textBefore);
    if (paramCtx) {
      return this._completeParams(paramCtx);
    }

    return this._completeFunctionNames(textBefore);
  }

  // ── Function name completion ────────────────────────────────────────────

  private _completeFunctionNames(textBefore: string): vscode.CompletionItem[] | undefined {
    const wordMatch = textBefore.match(/([a-zA-Z_]\w*)$/);
    if (!wordMatch) return undefined;

    const prefix = wordMatch[1].toLowerCase();
    const symbols = getHuSymbols();
    const items: vscode.CompletionItem[] = [];

    for (const sym of symbols) {
      if (!sym.name.toLowerCase().startsWith(prefix)) continue;

      const item = new vscode.CompletionItem(
        sym.name,
        vscode.CompletionItemKind.Function,
      );
      item.detail = `${sym.relativePath}`;
      item.documentation = sym.params.length > 0
        ? `Parameters: ${sym.params.join(", ")}`
        : "No parameters";

      if (sym.params.length > 0) {
        const paramSnippet = sym.params
          .map((p, i) => `${p}=\${${i + 1}}`)
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

  private _paramContext(textBefore: string): HuSymbol | null {
    const m = textBefore.match(/([a-zA-Z_]\w*)\s*\([^)]*$/);
    if (!m) return null;
    return findHuByName(m[1]) ?? null;
  }

  private _completeParams(sym: HuSymbol): vscode.CompletionItem[] | undefined {
    if (sym.params.length === 0) return undefined;

    const items: vscode.CompletionItem[] = [];
    for (const param of sym.params) {
      const item = new vscode.CompletionItem(
        `${param}=`,
        vscode.CompletionItemKind.Field,
      );
      item.detail = `${sym.name} parameter`;
      item.insertText = new vscode.SnippetString(`${param}=\${1}`);
      item.sortText = `0_${param}`;
      items.push(item);
    }

    return items;
  }
}
