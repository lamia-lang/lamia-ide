import * as path from "path";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
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
import { collectSystemInfo } from "./systemInfo";
import { LamiaExecutableDecorationProvider } from "./executableDecorationProvider";
import { FileReferenceCompletionProvider } from "./fileReferenceCompletionProvider";

let _chatProvider: LamiaChatProvider | undefined;
let _runningExecution: vscode.TaskExecution | undefined;

function setRunning(running: boolean): void {
  vscode.commands.executeCommand("setContext", "lamia.isRunning", running);
}

class LamiaRunPseudoTerminal implements vscode.Pseudoterminal {
  private readonly _writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite: vscode.Event<string> = this._writeEmitter.event;

  private readonly _closeEmitter = new vscode.EventEmitter<number>();
  readonly onDidClose: vscode.Event<number> = this._closeEmitter.event;

  private _proc: ChildProcessWithoutNullStreams | null = null;

  constructor(
    private readonly _cli: string,
    private readonly _fileName: string,
    private readonly _cwd: string,
  ) {}

  open(): void {
    this._proc = spawn(this._cli, [this._fileName], {
      cwd: this._cwd,
      env: process.env,
    });

    this._proc.stdout.on("data", (chunk: Buffer | string) => {
      this._writeEmitter.fire(chunk.toString().replace(/\r?\n/g, "\r\n"));
    });
    this._proc.stderr.on("data", (chunk: Buffer | string) => {
      this._writeEmitter.fire(chunk.toString().replace(/\r?\n/g, "\r\n"));
    });

    this._proc.on("error", (err) => {
      this._writeEmitter.fire(`Failed to start Lamia process: ${err.message}\r\n`);
      this._closeEmitter.fire(1);
      this._proc = null;
    });

    this._proc.on("close", (code) => {
      this._closeEmitter.fire(code ?? 0);
      this._proc = null;
    });
  }

  handleInput(data: string): void {
    if (data === "\u0003" && this._proc && !this._proc.killed) {
      this._proc.kill("SIGINT");
    }
  }

  close(): void {
    if (this._proc && !this._proc.killed) {
      this._proc.kill("SIGTERM");
    }
    this._proc = null;
  }
}

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

  const fileRefProvider = new FileReferenceCompletionProvider();
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { language: "lamia" },
      fileRefProvider,
      "@",
    ),
    vscode.languages.registerCompletionItemProvider(
      { language: "lamia-prompt" },
      fileRefProvider,
      "@",
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

  const execDecoProvider = new LamiaExecutableDecorationProvider();
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(execDecoProvider)
  );
  const lmContentWatcher = vscode.workspace.createFileSystemWatcher("**/*.lm");
  lmContentWatcher.onDidChange((uri) => execDecoProvider.invalidate(uri));
  lmContentWatcher.onDidCreate((uri) => execDecoProvider.invalidate(uri));
  lmContentWatcher.onDidDelete((uri) => execDecoProvider.invalidate(uri));
  context.subscriptions.push(lmContentWatcher);
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.fsPath.endsWith(".lm")) {
        execDecoProvider.invalidate(e.document.uri);
      }
    })
  );

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
    vscode.commands.registerCommand("lamia.run", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !editor.document.fileName.endsWith(".lm")) {
        vscode.window.showWarningMessage("Open a .lm file to run it");
        return;
      }

      if (_runningExecution) {
        _runningExecution.terminate();
        _runningExecution = undefined;
      }

      const filePath = editor.document.fileName;
      const fileDir = path.dirname(filePath);
      const fileName = path.basename(filePath);
      const cli = resolveLamiaCli();

      const taskDef: vscode.TaskDefinition = { type: "lamia", file: filePath };
      const execution = new vscode.CustomExecution(async () => {
        return new LamiaRunPseudoTerminal(cli, fileName, fileDir);
      });
      const task = new vscode.Task(
        taskDef,
        vscode.TaskScope.Workspace,
        `Run ${fileName}`,
        "lamia",
        execution,
        [],
      );
      task.presentationOptions = {
        reveal: vscode.TaskRevealKind.Always,
        panel: vscode.TaskPanelKind.Shared,
        clear: true,
        showReuseMessage: false,
      };

      _runningExecution = await vscode.tasks.executeTask(task);
      setRunning(true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("lamia.stop", () => {
      if (_runningExecution) {
        _runningExecution.terminate();
        _runningExecution = undefined;
        setRunning(false);
      }
    })
  );

  context.subscriptions.push(
    vscode.tasks.onDidEndTask((e) => {
      if (_runningExecution && e.execution === _runningExecution) {
        _runningExecution = undefined;
        setRunning(false);
      }
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

  context.subscriptions.push(
    vscode.commands.registerCommand("lamia.copySystemInfo", async () => {
      const info = await collectSystemInfo();
      await vscode.env.clipboard.writeText(info);
      vscode.window.showInformationMessage(
        "System info copied to clipboard. Paste it into your issue report."
      );
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
