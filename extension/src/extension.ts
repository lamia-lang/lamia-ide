import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  const run = vscode.commands.registerCommand("lamia.run", () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !editor.document.fileName.endsWith(".lm")) {
      vscode.window.showWarningMessage("Open a .lm file to run it");
      return;
    }

    const filePath = editor.document.fileName;
    const workDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    const terminal =
      vscode.window.terminals.find((t) => t.name === "Lamia") ??
      vscode.window.createTerminal({ name: "Lamia", cwd: workDir });

    terminal.show();
    terminal.sendText(`lamia "${filePath}"`);
  });

  context.subscriptions.push(run);
}

export function deactivate() {}
