import * as path from "path";
import * as vscode from "vscode";
import { LamiaChatProvider } from "./chatProvider";
import { LamiaDefinitionProvider } from "./definitionProvider";
import { LamiaCompletionProvider } from "./completionProvider";
import { LamiaRunCodeLensProvider } from "./runCodeLensProvider";
import { LamiaHoverProvider } from "./hoverProvider";
import { LamiaDocumentSymbolProvider } from "./documentSymbolProvider";
import { LamiaReferenceProvider } from "./referenceProvider";
import { LamiaSignatureHelpProvider } from "./signatureHelpProvider";
import { invalidateSymbols } from "./symbolIndex";
import { writeIdePath, ensureLamia, isPythonAvailable, isLamiaReady, showNoPythonWarning } from "./lamiaInstaller";
import { startWatching } from "./fileContext";
import { setLastCopied } from "./clipboardStore";
import { LamiaDebugConfigProvider } from "./lamiaDebugConfigProvider";
import { LamiaDebugSession } from "./lamiaDebugSession";
import { resolveLamiaCli } from "./lamiaDebugRuntime";

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

  startWatching(context);

  const defProvider = new LamiaDefinitionProvider();
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider({ language: "lamia" }, defProvider),
    vscode.languages.registerDefinitionProvider({ language: "lamia-prompt" }, defProvider),
  );

  const completionProvider = new LamiaCompletionProvider();
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { language: "lamia" },
      completionProvider,
      "(", ",",
    ),
  );

  const hoverProvider = new LamiaHoverProvider();
  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ language: "lamia" }, hoverProvider),
    vscode.languages.registerHoverProvider({ language: "lamia-prompt" }, hoverProvider),
  );

  const symbolProvider = new LamiaDocumentSymbolProvider();
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider({ language: "lamia" }, symbolProvider),
    vscode.languages.registerDocumentSymbolProvider({ language: "lamia-prompt" }, symbolProvider),
  );

  const refProvider = new LamiaReferenceProvider();
  context.subscriptions.push(
    vscode.languages.registerReferenceProvider({ language: "lamia" }, refProvider),
    vscode.languages.registerReferenceProvider({ language: "lamia-prompt" }, refProvider),
  );

  context.subscriptions.push(
    vscode.languages.registerSignatureHelpProvider(
      { language: "lamia" },
      new LamiaSignatureHelpProvider(),
      "(", ",",
    ),
  );

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { language: "lamia" },
      new LamiaRunCodeLensProvider(),
    ),
  );

  const symbolWatcher = vscode.workspace.createFileSystemWatcher("**/*.{hu,lm}");
  symbolWatcher.onDidCreate(() => invalidateSymbols());
  symbolWatcher.onDidDelete(() => invalidateSymbols());
  symbolWatcher.onDidChange(() => invalidateSymbols());
  context.subscriptions.push(symbolWatcher);

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
      const fileDir = path.dirname(filePath);
      const fileName = path.basename(filePath);
      const cli = resolveLamiaCli();

      const terminal =
        vscode.window.terminals.find((t) => t.name === "Lamia") ??
        vscode.window.createTerminal({ name: "Lamia", cwd: fileDir });

      terminal.show();
      terminal.sendText(`cd "${fileDir}" && "${cli}" "${fileName}"`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("lamia.debug", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !editor.document.fileName.endsWith(".lm")) {
        vscode.window.showWarningMessage("Open a .lm file to debug it");
        return;
      }
      const filePath = editor.document.uri.fsPath;
      vscode.debug.startDebugging(
        vscode.workspace.getWorkspaceFolder(editor.document.uri),
        {
          type: "lamia",
          request: "launch",
          name: "Debug Lamia File",
          program: filePath,
          cwd: path.dirname(filePath),
          stopOnEntry: false,
        },
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("lamia.trackCopy", async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor && !editor.selection.isEmpty) {
        const sel = editor.selection;
        const text = editor.document.getText(sel);
        const filePath = editor.document.uri.fsPath;
        const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
        setLastCopied({
          text,
          filePath,
          fileName,
          startLine: sel.start.line + 1,
          endLine: sel.end.line + 1,
        });
      }
      await vscode.commands.executeCommand("editor.action.clipboardCopyAction");
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && chatProvider) {
        chatProvider.switchProjectIfNeeded(editor.document.uri.fsPath);
      }
    })
  );

  // ── Debug adapter ────────────────────────────────────────────────
  const debugProvider = new LamiaDebugConfigProvider();
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider("lamia", debugProvider),
  );
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory("lamia", {
      createDebugAdapterDescriptor(): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        return new vscode.DebugAdapterInlineImplementation(
          new LamiaDebugSession(),
        );
      },
    }),
  );

  setTimeout(() => {
    vscode.commands.executeCommand("lamia.chatView.focus");
  }, 1500);
}

export function deactivate() {
  _chatProvider?.dispose();
}
