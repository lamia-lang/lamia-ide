import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

const SKIP_DIRS = new Set([
  "node_modules", "__pycache__", ".git", "venv", ".venv",
  ".tox", ".mypy_cache", "dist", "build", ".lamia_sessions",
]);

const MAX_DEPTH = 6;
const PARAM_RE = /\{(\w+)(?::([^}]*))?\}/g;
const FILE_REF_RE = /\{@(\w+)\}/g;

// ── Symbol types ────────────────────────────────────────────────────────────

export interface HuParam {
  name: string;
  required: boolean;
  defaultValue?: string;
}

export interface HuSymbol {
  kind: "hu";
  name: string;
  params: string[];
  paramDetails: HuParam[];
  filePath: string;
  relativePath: string;
}

export interface LmDefSymbol {
  kind: "def" | "class";
  name: string;
  params: string[];
  filePath: string;
  line: number;
}

export type LamiaSymbol = HuSymbol | LmDefSymbol;

// ── Index ───────────────────────────────────────────────────────────────────

let _symbols: LamiaSymbol[] | null = null;

export function getSymbols(): LamiaSymbol[] {
  if (!_symbols) {
    _symbols = buildIndex();
  }
  return _symbols;
}

export function invalidateSymbols(): void {
  _symbols = null;
}

export function getHuSymbols(): HuSymbol[] {
  return getSymbols().filter((s): s is HuSymbol => s.kind === "hu");
}

export function findHuByName(name: string): HuSymbol | undefined {
  return getHuSymbols().find((s) => s.name === name);
}

// ── Build ───────────────────────────────────────────────────────────────────

function buildIndex(): LamiaSymbol[] {
  const root = projectRoot();
  if (!root) return [];

  const symbols: LamiaSymbol[] = [];

  for (const file of collectFiles(root, MAX_DEPTH)) {
    const ext = path.extname(file).toLowerCase();
    if (ext === ".hu") {
      const sym = parseHuFile(file, root);
      if (sym) symbols.push(sym);
    }
  }

  return symbols;
}

function parseHuFile(filePath: string, root: string): HuSymbol | null {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const name = path.basename(filePath, ".hu");
    const seen = new Set<string>();
    const paramDetails: HuParam[] = [];
    let m: RegExpExecArray | null;
    PARAM_RE.lastIndex = 0;
    while ((m = PARAM_RE.exec(content)) !== null) {
      const pName = m[1];
      const defaultVal = m[2]; // undefined if no `:...`
      if (pName.startsWith("@") || seen.has(pName)) continue;
      seen.add(pName);
      const isOptional = defaultVal !== undefined;
      paramDetails.push({
        name: pName,
        required: !isOptional,
        defaultValue: isOptional
          ? (defaultVal === "None" ? "" : defaultVal)
          : undefined,
      });
    }
    // {@identifier} file refs are optional parameters (caller provides filepath)
    FILE_REF_RE.lastIndex = 0;
    while ((m = FILE_REF_RE.exec(content)) !== null) {
      const ref = m[1];
      if (!seen.has(ref)) {
        seen.add(ref);
        paramDetails.push({ name: ref, required: false, defaultValue: "" });
      }
    }
    return {
      kind: "hu",
      name,
      params: paramDetails.map((p) => p.name),
      paramDetails,
      filePath,
      relativePath: path.relative(root, filePath),
    };
  } catch {
    return null;
  }
}

// ── Scanning helpers ────────────────────────────────────────────────────────

function projectRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return folders[0].uri.fsPath;
}

function collectFiles(dir: string, maxDepth: number): string[] {
  const result: string[] = [];
  (function walk(d: string, depth: number) {
    if (depth <= 0) return;
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isFile() && (e.name.endsWith(".hu") || e.name.endsWith(".lm"))) {
          result.push(full);
        } else if (e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)) {
          walk(full, depth - 1);
        }
      }
    } catch { /* skip */ }
  })(dir, maxDepth);
  return result;
}
