import * as vscode from "vscode";
import * as path from "path";

/**
 * Provides file path autocomplete inside string literals in .lm files.
 *
 * Activates when the open string before the cursor contains `/` or starts
 * with `.` or `~`, e.g. `clean("./input/crm/hub`. Lists the entries of the
 * single directory being typed (relative paths resolve against the
 * document's directory); directories end with `/` and re-open suggestions.
 */

const OPEN_STRING_RE = /(["'])([^"'\n]*)$/;

export class StringPathCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    const lineText = document.lineAt(position).text;
    const textBefore = lineText.substring(0, position.character);

    const m = OPEN_STRING_RE.exec(textBefore);
    if (!m || !isOpenString(textBefore.substring(0, m.index))) {
      return undefined;
    }

    const typed = m[2];
    if (!typed.includes("/") && !typed.startsWith(".") && !typed.startsWith("~")) {
      return undefined;
    }

    const slash = typed.lastIndexOf("/");
    const dirPart = slash >= 0 ? typed.substring(0, slash + 1) : "";
    const partial = typed.substring(slash + 1);
    const dir = resolveDir(dirPart, path.dirname(document.uri.fsPath));

    const range = new vscode.Range(
      position.line,
      position.character - partial.length,
      position.line,
      position.character,
    );
    return this._listDir(dir, partial, range);
  }

  private async _listDir(
    dir: string,
    partial: string,
    range: vscode.Range,
  ): Promise<vscode.CompletionItem[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
    } catch {
      return [];
    }

    const showHidden = partial.startsWith(".");
    const items: vscode.CompletionItem[] = [];
    for (const [name, type] of entries) {
      if (name.startsWith(".") && !showHidden) {
        continue;
      }
      const isDir = (type & vscode.FileType.Directory) !== 0;
      const label = isDir ? `${name}/` : name;
      const item = new vscode.CompletionItem(
        label,
        isDir ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File,
      );
      item.insertText = label;
      item.filterText = name;
      item.range = range;
      item.detail = path.join(dir, name);
      if (isDir) {
        item.command = { command: "editor.action.triggerSuggest", title: "" };
      }
      items.push(item);
    }
    return items;
  }
}

/** True when the quote following `before` opens a string rather than closing one or sitting in a comment. */
function isOpenString(before: string): boolean {
  let open: string | null = null;
  for (const ch of before) {
    if (open) {
      if (ch === open) {
        open = null;
      }
    } else if (ch === '"' || ch === "'") {
      open = ch;
    } else if (ch === "#") {
      return false;
    }
  }
  return open === null;
}

function resolveDir(dirPart: string, docDir: string): string {
  if (dirPart.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return path.resolve(home, dirPart.slice(2));
  }
  if (path.isAbsolute(dirPart)) {
    return dirPart;
  }
  return path.resolve(docDir, dirPart);
}
