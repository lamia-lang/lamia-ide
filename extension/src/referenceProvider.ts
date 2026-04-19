import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { findHuByName } from "./symbolIndex";

const SKIP_DIRS = new Set([
  "node_modules", "__pycache__", ".git", "venv", ".venv",
  ".tox", ".mypy_cache", "dist", "build", ".lamia_sessions",
]);

export class LamiaReferenceProvider implements vscode.ReferenceProvider {
  provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.ReferenceContext,
    _token: vscode.CancellationToken,
  ): vscode.Location[] | null {
    const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_]\w*/);
    if (!wordRange) return null;

    const word = document.getText(wordRange);
    if (!word || word.length < 2) return null;

    const sym = findHuByName(word);
    const isKnownSymbol = !!sym;

    if (!isKnownSymbol) {
      const text = document.getText();
      const defRe = new RegExp(`^[ \\t]*(?:async\\s+)?def\\s+${escapeRegex(word)}\\s*\\(`, "m");
      const classRe = new RegExp(`^[ \\t]*class\\s+${escapeRegex(word)}\\s*[\\(:]`, "m");
      if (!defRe.test(text) && !classRe.test(text)) return null;
    }

    const root = workspaceRoot();
    if (!root) return null;

    const pattern = new RegExp(`(?<![a-zA-Z_])${escapeRegex(word)}(?![a-zA-Z_\\d])`, "g");
    const locations: vscode.Location[] = [];

    for (const file of collectLamiaFiles(root, 6)) {
      try {
        const content = fs.readFileSync(file, "utf8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          pattern.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = pattern.exec(lines[i])) !== null) {
            locations.push(
              new vscode.Location(
                vscode.Uri.file(file),
                new vscode.Position(i, m.index),
              ),
            );
          }
        }
      } catch { /* skip unreadable */ }
    }

    return locations.length > 0 ? locations : null;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function workspaceRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : null;
}

function collectLamiaFiles(dir: string, maxDepth: number): string[] {
  const result: string[] = [];
  (function walk(d: string, depth: number) {
    if (depth <= 0) return;
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isFile() && (e.name.endsWith(".lm") || e.name.endsWith(".hu") || e.name.endsWith(".py"))) {
          result.push(full);
        } else if (e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)) {
          walk(full, depth - 1);
        }
      }
    } catch { /* skip */ }
  })(dir, maxDepth);
  return result;
}
