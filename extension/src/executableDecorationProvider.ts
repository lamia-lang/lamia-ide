import * as vscode from "vscode";
import { execFile } from "child_process";
import { resolveLamiaCli } from "./lamiaDebugRuntime";

/**
 * Detects whether a .lm file is "executable" (has top-level steps)
 * and adds a play ▶ badge overlay in the file explorer.
 *
 * Delegates to `lamia inspect <file...> --json` which uses the same Lamia
 * parser pipeline as the debugger. Multiple files are batched into a single
 * CLI invocation to avoid spawning many processes.
 */

const BATCH_DELAY_MS = 50;
const INSPECT_TIMEOUT_MS = 30_000;

export class LamiaExecutableDecorationProvider implements vscode.FileDecorationProvider {
  private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  private _cache = new Map<string, boolean>();
  private _batchQueue = new Map<string, vscode.Uri>();
  private _batchTimer: ReturnType<typeof setTimeout> | null = null;
  private _batchRunning = false;

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!uri.fsPath.endsWith(".lm")) return undefined;

    const cached = this._cache.get(uri.fsPath);
    if (cached === undefined) {
      this._scheduleBatch(uri);
      return undefined;
    }
    if (!cached) return undefined;

    return new vscode.FileDecoration("▶", "Executable — has top-level steps");
  }

  invalidate(uri: vscode.Uri): void {
    this._cache.delete(uri.fsPath);
    this._onDidChangeFileDecorations.fire(uri);
  }

  invalidateAll(): void {
    this._cache.clear();
    this._onDidChangeFileDecorations.fire(
      [...vscode.workspace.textDocuments]
        .filter(d => d.uri.fsPath.endsWith(".lm"))
        .map(d => d.uri)
    );
  }

  private _scheduleBatch(uri: vscode.Uri): void {
    this._batchQueue.set(uri.fsPath, uri);
    if (this._batchTimer !== null) return;
    this._batchTimer = setTimeout(() => this._flushBatch(), BATCH_DELAY_MS);
  }

  private _flushBatch(): void {
    this._batchTimer = null;

    if (this._batchRunning) {
      this._batchTimer = setTimeout(() => this._flushBatch(), BATCH_DELAY_MS);
      return;
    }

    const entries = new Map(this._batchQueue);
    this._batchQueue.clear();

    if (entries.size === 0) return;

    this._batchRunning = true;
    const paths = [...entries.keys()];
    const cli = resolveLamiaCli();

    const args = ["inspect", ...paths, "--json"];
    execFile(cli, args, { timeout: INSPECT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      this._batchRunning = false;

      if (err) {
        for (const fsPath of paths) {
          this._cache.set(fsPath, false);
        }
      } else {
        try {
          const data = JSON.parse(stdout.trim());
          if (paths.length === 1) {
            this._cache.set(paths[0], data.executable === true);
          } else {
            const results: Record<string, { executable: boolean }> = data.results || {};
            for (const fsPath of paths) {
              const info = results[fsPath];
              this._cache.set(fsPath, info?.executable === true);
            }
          }
        } catch {
          for (const fsPath of paths) {
            this._cache.set(fsPath, false);
          }
        }
      }

      const changedUris = paths.map(p => entries.get(p)!);
      this._onDidChangeFileDecorations.fire(changedUris);

      if (this._batchQueue.size > 0) {
        this._flushBatch();
      }
    });
  }
}
