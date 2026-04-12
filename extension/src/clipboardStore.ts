export interface CopiedSnippet {
  text: string;
  filePath: string;
  fileName: string;
  startLine: number;
  endLine: number;
}

let _lastCopied: CopiedSnippet | null = null;

export function setLastCopied(snippet: CopiedSnippet): void {
  _lastCopied = snippet;
}

export function getLastCopied(): CopiedSnippet | null {
  return _lastCopied;
}

export function clearLastCopied(): void {
  _lastCopied = null;
}
