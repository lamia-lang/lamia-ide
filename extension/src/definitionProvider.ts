import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

const SKIP_DIRS = new Set([
  "node_modules", "__pycache__", ".git", "venv", ".venv",
  ".tox", ".mypy_cache", "dist", "build", ".lamia_sessions",
]);

export class LamiaDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.Definition> {
    const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_]\w*/);
    if (!wordRange) return null;

    const word = document.getText(wordRange);
    if (!word || word.length < 2) return null;

    const filePath = document.uri.fsPath;

    // 1. .hu file whose stem matches the word (e.g. developer → developer.hu)
    const huPath = findHuFile(word, filePath);
    if (huPath) {
      return new vscode.Location(vscode.Uri.file(huPath), new vscode.Position(0, 0));
    }

    // 2. def / class in the current document
    const local = findDefInDocument(word, document);
    if (local) return local;

    // 3. def / class in other .lm files in the project
    return findDefInProject(word, filePath);
  }
}

// ---------------------------------------------------------------------------
// Project root: walk up to config.yaml, fall back to workspace root
// ---------------------------------------------------------------------------

function findProjectRoot(filePath: string): string {
  let dir = path.dirname(filePath);
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, "config.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) return folders[0].uri.fsPath;
  return path.dirname(filePath);
}

// ---------------------------------------------------------------------------
// .hu file lookup (mirrors runtime: recursive scan from project root)
// ---------------------------------------------------------------------------

function findHuFile(name: string, fromFile: string): string | null {
  const root = findProjectRoot(fromFile);
  return searchFile(root, `${name}.hu`, 6);
}

function searchFile(dir: string, fileName: string, maxDepth: number): string | null {
  if (maxDepth <= 0) return null;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name === fileName) return path.join(dir, e.name);
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)) {
        const found = searchFile(path.join(dir, e.name), fileName, maxDepth - 1);
        if (found) return found;
      }
    }
  } catch { /* permission / broken symlink */ }
  return null;
}

// ---------------------------------------------------------------------------
// def / class lookup
// ---------------------------------------------------------------------------

function defPatterns(name: string): RegExp[] {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    new RegExp(`^[ \\t]*(?:async\\s+)?def\\s+${esc}\\s*\\(`, "gm"),
    new RegExp(`^[ \\t]*class\\s+${esc}\\s*[\\(:]`, "gm"),
  ];
}

function findDefInDocument(
  name: string,
  document: vscode.TextDocument,
): vscode.Location | null {
  const text = document.getText();
  for (const re of defPatterns(name)) {
    const m = re.exec(text);
    if (m) {
      return new vscode.Location(document.uri, document.positionAt(m.index));
    }
  }
  return null;
}

function findDefInProject(name: string, fromFile: string): vscode.Location | null {
  const root = findProjectRoot(fromFile);
  const lmFiles = collectFiles(root, ".lm", 6);

  for (const file of lmFiles) {
    if (file === fromFile) continue;
    try {
      const text = fs.readFileSync(file, "utf8");
      for (const re of defPatterns(name)) {
        re.lastIndex = 0;
        const m = re.exec(text);
        if (m) {
          const lineNum = text.substring(0, m.index).split("\n").length - 1;
          return new vscode.Location(
            vscode.Uri.file(file),
            new vscode.Position(lineNum, 0),
          );
        }
      }
    } catch { /* unreadable */ }
  }
  return null;
}

function collectFiles(dir: string, ext: string, maxDepth: number): string[] {
  const result: string[] = [];
  (function walk(d: string, depth: number) {
    if (depth <= 0) return;
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isFile() && e.name.endsWith(ext)) {
          result.push(full);
        } else if (e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)) {
          walk(full, depth - 1);
        }
      }
    } catch { /* skip */ }
  })(dir, maxDepth);
  return result;
}
