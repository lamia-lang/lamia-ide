import * as vscode from "vscode";
import * as path from "path";

export class LamiaDebugConfigProvider
  implements vscode.DebugConfigurationProvider
{
  resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    _token?: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    if (!config.type && !config.request && !config.name) {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.languageId === "lamia") {
        config.type = "lamia";
        config.name = "Debug Lamia File";
        config.request = "launch";
        config.program = editor.document.uri.fsPath;
        config.cwd = path.dirname(editor.document.uri.fsPath);
        config.stopOnEntry = true;
      }
    }

    if (!config.program) {
      return vscode.window
        .showInformationMessage("Open a .lm file to debug")
        .then(() => undefined);
    }

    if (!config.cwd) {
      config.cwd = path.dirname(config.program);
    }

    return config;
  }
}
