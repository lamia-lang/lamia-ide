import * as vscode from "vscode";
import { LamiaChatProvider } from "./chatProvider";

export function activate(context: vscode.ExtensionContext) {
  const chatProvider = new LamiaChatProvider(context);
  _chatProvider = chatProvider;

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      LamiaChatProvider.viewType,
      chatProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("lamia.openChat", () => {
      vscode.commands.executeCommand("workbench.action.toggleAuxiliaryBar");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("lamia.run", () => {
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
    })
  );

  // Open the secondary sidebar on startup so the chat is visible
  setTimeout(() => {
    vscode.commands.executeCommand("lamia.chatView.focus");
  }, 1500);
}

let _chatProvider: LamiaChatProvider | undefined;

export function deactivate() {
  _chatProvider?.dispose();
}
