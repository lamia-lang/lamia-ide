import * as vscode from "vscode";
import { findCallableByName, CallableSymbol, HuParam } from "./symbolIndex";

export class LamiaHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): vscode.Hover | null {
    const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_]\w*/);
    if (!wordRange) return null;

    const word = document.getText(wordRange);
    const sym = findCallableByName(word, document.uri.fsPath);
    if (!sym) return null;

    const returnType = "returnType" in sym ? sym.returnType : undefined;
    const sig = buildSignature(sym.name, sym.paramDetails, returnType);
    const md = new vscode.MarkdownString();
    md.appendCodeblock(sig, "python");

    const fileRefs = sym.paramDetails.filter((p) => p.isFileRef);
    const req = sym.paramDetails.filter((p) => p.required && !p.isFileRef);
    const opt = sym.paramDetails.filter((p) => !p.required);
    if (fileRefs.length > 0) {
      md.appendMarkdown(`\n**File refs:** ${fileRefs.map((p) => `\`${p.name}\``).join(", ")}\n`);
    }
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

function buildSignature(name: string, params: HuParam[], returnType?: string): string {
  const suffix = returnType ? ` -> ${returnType}` : "";
  if (params.length === 0) return `${name}()${suffix}`;
  const parts = params.map((p) => {
    if (p.isFileRef) {
      return `${p.name}: FilePath`;
    }
    if (!p.required && p.defaultValue !== undefined) {
      if (isPrimitive(p.defaultValue)) {
        return `${p.name}=${p.defaultValue}`;
      }
      return `${p.name}="${p.defaultValue}"`;
    }
    return p.name;
  });
  return `${name}(${parts.join(", ")})${suffix}`;
}

function isPrimitive(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value) || value === "true" || value === "false";
}

function formatOptional(p: HuParam): string {
  if (p.isFileRef) return `\`${p.name}\` *(file path)*`;
  if (p.defaultValue) {
    const display = isPrimitive(p.defaultValue) ? p.defaultValue : `"${p.defaultValue}"`;
    return `\`${p.name}=${display}\``;
  }
  return `\`${p.name}\``;
}
