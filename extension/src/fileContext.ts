import * as vscode from "vscode";
import * as path from "path";

export interface ProjectFile {
  name: string;
  relativePath: string;
  absolutePath: string;
  type: "lm" | "hu" | "yaml" | "py";
}

const SCAN_EXTENSIONS = new Set([".lm", ".hu", ".yaml", ".yml", ".py"]);
const IGNORE_DIRS = new Set(["node_modules", "__pycache__", ".git", ".venv", "venv", ".lamia_sessions"]);

let _cachedFiles: ProjectFile[] | null = null;
let _watcher: vscode.FileSystemWatcher | null = null;

export function getProjectFiles(): ProjectFile[] {
  if (_cachedFiles) return _cachedFiles;
  _cachedFiles = scanWorkspace();
  return _cachedFiles;
}

export function invalidateCache(): void {
  _cachedFiles = null;
}

export function startWatching(context: vscode.ExtensionContext): void {
  if (_watcher) return;
  _watcher = vscode.workspace.createFileSystemWatcher("**/*.{lm,hu,yaml,yml,py}");
  _watcher.onDidCreate(() => invalidateCache());
  _watcher.onDidDelete(() => invalidateCache());
  _watcher.onDidChange(() => invalidateCache());
  context.subscriptions.push(_watcher);
}

export function filterFiles(query: string): ProjectFile[] {
  const files = getProjectFiles();
  if (!query) return files;

  const lower = query.toLowerCase();
  return files.filter(
    (f) =>
      f.name.toLowerCase().includes(lower) ||
      f.relativePath.toLowerCase().includes(lower)
  );
}

function scanWorkspace(): ProjectFile[] {
  const results: ProjectFile[] = [];
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) return results;

  for (const folder of folders) {
    const root = folder.uri.fsPath;
    scanDir(root, root, results);
  }

  return results;
}

function scanDir(dir: string, root: string, results: ProjectFile[]): void {
  const fs = require("fs") as typeof import("fs");
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.isDirectory()) continue;
    if (IGNORE_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      scanDir(fullPath, root, results);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!SCAN_EXTENSIONS.has(ext)) continue;

      const type = ext === ".lm" ? "lm"
        : ext === ".hu" ? "hu"
        : ext === ".yaml" || ext === ".yml" ? "yaml"
        : "py";

      results.push({
        name: entry.name,
        relativePath: path.relative(root, fullPath),
        absolutePath: fullPath,
        type,
      });
    }
  }
}
