import * as vscode from "vscode";
import * as path from "path";

/**
 * Provides autocomplete inside {@...} blocks in .lm and .hu files.
 *
 * When the cursor is between `{@` and `}`, this provider lists all files
 * reachable from the `files()` context paths declared in the current file.
 * Each suggestion shows the minimal unique path that disambiguates the file.
 */
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

    const prefix = inRef[1].toLowerCase();
    const contextPaths = this._extractFilesPaths(document);

    if (contextPaths.length === 0) {
      return undefined;
    }

    return this._listFiles(contextPaths, prefix, document.uri);
  }

  private _extractFilesPaths(document: vscode.TextDocument): string[] {
    const text = document.getText();
    const paths: string[] = [];

    const pattern = /\bwith\s+files\s*\(([^)]*)\)/g;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const argsStr = m[1];
      const strPattern = /["']([^"']+)["']/g;
      let s: RegExpExecArray | null;
      while ((s = strPattern.exec(argsStr)) !== null) {
        paths.push(s[1]);
      }
    }

    const filesPattern = /\bfiles\s*\(([^)]*)\)/g;
    while ((m = filesPattern.exec(text)) !== null) {
      const argsStr = m[1];
      const strPattern = /["']([^"']+)["']/g;
      let s: RegExpExecArray | null;
      while ((s = strPattern.exec(argsStr)) !== null) {
        if (!paths.includes(s[1])) {
          paths.push(s[1]);
        }
      }
    }

    return paths;
  }

  private async _listFiles(
    contextPaths: string[],
    prefix: string,
    documentUri: vscode.Uri,
  ): Promise<vscode.CompletionItem[]> {
    const docDir = path.dirname(documentUri.fsPath);
    const resolvedPaths = contextPaths.map((p) => {
      if (p.startsWith("~/")) {
        const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
        return path.resolve(home, p.slice(2));
      }
      if (path.isAbsolute(p)) {
        return p;
      }
      return path.resolve(docDir, p);
    });

    const allFiles: string[] = [];
    for (const dir of resolvedPaths) {
      try {
        const files = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
        await this._collectFiles(dir, files, allFiles, 3);
      } catch {
        // path doesn't exist or can't read — skip
      }
    }

    if (allFiles.length === 0) {
      return [];
    }

    const minimalPaths = computeMinimalUniquePaths(allFiles);
    const items: vscode.CompletionItem[] = [];

    for (const [fullPath, minimal] of Object.entries(minimalPaths)) {
      if (prefix && !minimal.toLowerCase().includes(prefix)) {
        continue;
      }
      const item = new vscode.CompletionItem(
        minimal,
        vscode.CompletionItemKind.File,
      );
      item.detail = fullPath;
      item.insertText = minimal;
      item.filterText = minimal;
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
      } else if (type === vscode.FileType.Directory) {
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

export function computeMinimalUniquePaths(
  paths: string[],
): Record<string, string> {
  if (paths.length <= 1) {
    const result: Record<string, string> = {};
    for (const p of paths) {
      result[p] = path.basename(p);
    }
    return result;
  }

  const split: Record<string, string[]> = {};
  for (const p of paths) {
    split[p] = p.replace(/\\/g, "/").split("/");
  }

  const result: Record<string, string> = {};
  for (const target of paths) {
    const parts = split[target];
    let found = false;
    for (let depth = 1; depth <= parts.length; depth++) {
      const suffix = parts.slice(-depth).join("/");
      const othersMatch = paths.some(
        (other) =>
          other !== target &&
          split[other].slice(-depth).join("/") === suffix,
      );
      if (!othersMatch) {
        result[target] = suffix;
        found = true;
        break;
      }
    }
    if (!found) {
      result[target] = target;
    }
  }

  return result;
}
