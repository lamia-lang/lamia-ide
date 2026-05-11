import * as vscode from "vscode";
import { findCallableByName, HuParam } from "./symbolIndex";

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

    const sym = findCallableByName(fnName, document.uri.fsPath);
    if (!sym || sym.paramDetails.length === 0) return null;

    const returnType = "returnType" in sym ? sym.returnType : undefined;
    const sig = new vscode.SignatureInformation(buildLabel(sym.name, sym.paramDetails, returnType));
    sig.documentation = new vscode.MarkdownString(`*${sym.relativePath}*`);

    for (const p of sym.paramDetails) {
      let paramLabel: string;
      let doc: string;
      if (p.isFileRef) {
        paramLabel = `${p.name}: FilePath`;
        doc = "File path (required)";
      } else if (!p.required && p.defaultValue) {
        paramLabel = `${p.name}=${p.defaultValue}`;
        doc = `Optional (default: ${p.defaultValue})`;
      } else if (p.required) {
        paramLabel = p.name;
        doc = "Required parameter";
      } else {
        paramLabel = `${p.name}?`;
        doc = "Optional";
      }
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

function buildLabel(name: string, params: HuParam[], returnType?: string): string {
  const parts = params.map((p) => {
    if (p.isFileRef) return `${p.name}: FilePath`;
    if (!p.required && p.defaultValue) return `${p.name}=${p.defaultValue}`;
    return p.required ? p.name : `${p.name}?`;
  });
  const suffix = returnType ? ` -> ${returnType}` : "";
  return `${name}(${parts.join(", ")})${suffix}`;
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
