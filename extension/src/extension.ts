import * as vscode from "vscode";
import { LamiaChatProvider } from "./chatProvider";
import { writeIdePath, ensureLamia, isPythonAvailable, isLamiaReady, showNoPythonWarning } from "./lamiaInstaller";

let _chatProvider: LamiaChatProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
  writeIdePath();

  if (isLamiaReady()) {
    // Already installed from a previous launch — nothing to do
  } else if (isPythonAvailable()) {
    ensureLamia().catch(() => {});
  } else {
    showNoPythonWarning();
  }

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

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && chatProvider) {
        chatProvider.switchProjectIfNeeded(editor.document.uri.fsPath);
      }
    })
  );

  setTimeout(() => {
    vscode.commands.executeCommand("lamia.chatView.focus");
  }, 1500);
}

export function deactivate() {
  _chatProvider?.dispose();
}
