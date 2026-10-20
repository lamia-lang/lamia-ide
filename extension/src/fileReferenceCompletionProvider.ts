import * as vscode from "vscode";
import * as path from "path";

/**
 * Provides autocomplete inside {@...} blocks in .hu files.
 *
 * When the cursor is between `{@` and `}`, this provider lists files under
 * the document's directory as paths relative to it.
 */

const SKIP_DIRS = new Set(["node_modules", "__pycache__", "venv", "dist", "build"]);
const SCAN_DEPTH = 3;

export class FileReferenceCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    const lineText = document.lineAt(position).text;
    const textBefore = lineText.substring(0, position.character);

    const inRef = /\{@([^}]*)$/.exec(textBefore);
    if (!inRef) {
      return undefined;
    }

    return this._listRelativeFiles(inRef[1].toLowerCase(), document.uri);
  }

  private async _listRelativeFiles(
    prefix: string,
    documentUri: vscode.Uri,
  ): Promise<vscode.CompletionItem[]> {
    const docDir = path.dirname(documentUri.fsPath);
    const allFiles: string[] = [];
    try {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(docDir));
      await this._collectFiles(docDir, entries, allFiles, SCAN_DEPTH);
    } catch {
      return [];
    }

    const items: vscode.CompletionItem[] = [];
    for (const fullPath of allFiles) {
      if (fullPath === documentUri.fsPath) {
        continue;
      }
      const label = path.relative(docDir, fullPath).replace(/\\/g, "/");
      if (prefix && !label.toLowerCase().includes(prefix)) {
        continue;
      }
      const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.File);
      item.detail = fullPath;
      item.insertText = label;
      item.filterText = label;
      items.push(item);
    }
    return items;
  }

  private async _collectFiles(
    dir: string,
    entries: [string, vscode.FileType][],
    result: string[],
    depth: number,
  ): Promise<void> {
    if (depth <= 0) {
      return;
    }
    for (const [name, type] of entries) {
      if (name.startsWith(".")) {
        continue;
      }
      const fullPath = path.join(dir, name);
      if (type === vscode.FileType.File) {
        result.push(fullPath);
      } else if (type === vscode.FileType.Directory && !SKIP_DIRS.has(name)) {
        try {
          const subEntries = await vscode.workspace.fs.readDirectory(
            vscode.Uri.file(fullPath),
          );
          await this._collectFiles(fullPath, subEntries, result, depth - 1);
        } catch {
          // skip unreadable dirs
        }
      }
    }
  }
}
