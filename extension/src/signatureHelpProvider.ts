import * as vscode from "vscode";
import { findHuByName, HuParam } from "./symbolIndex";

export class LamiaSignatureHelpProvider implements vscode.SignatureHelpProvider {
  provideSignatureHelp(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.SignatureHelpContext,
  ): vscode.SignatureHelp | null {
    const lineText = document.lineAt(position).text;
    const textBefore = lineText.substring(0, position.character);

    const fnMatch = textBefore.match(/([a-zA-Z_]\w*)\s*\(([^)]*)$/);
    if (!fnMatch) return null;

    const fnName = fnMatch[1];
    const argsText = fnMatch[2];

    const sym = findHuByName(fnName, document.uri.fsPath);
    if (!sym || sym.paramDetails.length === 0) return null;

    const sig = new vscode.SignatureInformation(buildLabel(sym.name, sym.paramDetails));
    sig.documentation = new vscode.MarkdownString(`*${sym.relativePath}*`);

    for (const p of sym.paramDetails) {
      const paramLabel = p.required ? p.name : `${p.name}?`;
      const doc = p.required
        ? `Required parameter`
        : `Optional${p.defaultValue ? ` (default: "${p.defaultValue}")` : ""}`;
      sig.parameters.push(new vscode.ParameterInformation(paramLabel, doc));
    }

    const activeParam = countCommas(argsText);

    const help = new vscode.SignatureHelp();
    help.signatures = [sig];
    help.activeSignature = 0;
    help.activeParameter = Math.min(activeParam, sym.paramDetails.length - 1);
    return help;
  }
}

function buildLabel(name: string, params: HuParam[]): string {
  const parts = params.map((p) => (p.required ? p.name : `${p.name}?`));
  return `${name}(${parts.join(", ")})`;
}

function countCommas(text: string): number {
  let count = 0;
  let depth = 0;
  for (const ch of text) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) count++;
  }
  return count;
}
