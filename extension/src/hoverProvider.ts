import * as vscode from "vscode";
import { findHuByName, HuParam } from "./symbolIndex";

export class LamiaHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): vscode.Hover | null {
    const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_]\w*/);
    if (!wordRange) return null;

    const word = document.getText(wordRange);
    const sym = findHuByName(word, document.uri.fsPath);
    if (!sym) return null;

    const sig = buildSignature(sym.name, sym.paramDetails);
    const md = new vscode.MarkdownString();
    md.appendCodeblock(sig, "python");

    const req = sym.paramDetails.filter((p) => p.required);
    const opt = sym.paramDetails.filter((p) => !p.required);
    if (req.length > 0) {
      md.appendMarkdown(`\n**Required:** ${req.map((p) => `\`${p.name}\``).join(", ")}\n`);
    }
    if (opt.length > 0) {
      md.appendMarkdown(`\n**Optional:** ${opt.map((p) => formatOptional(p)).join(", ")}\n`);
    }
    md.appendMarkdown(`\n*${sym.relativePath}*`);

    return new vscode.Hover(md, wordRange);
  }
}

function buildSignature(name: string, params: HuParam[]): string {
  if (params.length === 0) return `${name}()`;
  const parts = params.map((p) => {
    if (!p.required && p.defaultValue !== undefined) {
      return `${p.name}="${p.defaultValue}"`;
    }
    return p.name;
  });
  return `${name}(${parts.join(", ")})`;
}

function formatOptional(p: HuParam): string {
  if (p.defaultValue) return `\`${p.name}="${p.defaultValue}"\``;
  return `\`${p.name}\``;
}
