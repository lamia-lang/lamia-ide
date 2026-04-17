import * as vscode from "vscode";

export class LamiaRunCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!document.fileName.endsWith(".lm")) return [];
    const topLine = new vscode.Range(0, 0, 0, 0);
    return [
      new vscode.CodeLens(topLine, {
        title: "$(play) Run",
        command: "lamia.run",
        tooltip: "Run this .lm file with Lamia",
      }),
    ];
  }
}
