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
  isFileRef?: boolean;
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
  kind: "def";
  name: string;
  params: string[];
  paramDetails: HuParam[];
  returnType?: string;
  filePath: string;
  relativePath: string;
  line: number;
}

export type LamiaSymbol = HuSymbol | LmDefSymbol;
export type CallableSymbol = HuSymbol | LmDefSymbol;

// ── Index ───────────────────────────────────────────────────────────────────

let _symbols: LamiaSymbol[] | null = null;
let _scopeRoot: string | null = null;

export function getSymbols(contextFile?: string): LamiaSymbol[] {
  const root = resolveProjectRoot(contextFile);
  if (root !== _scopeRoot) {
    _symbols = null;
    _scopeRoot = root;
  }
  if (!_symbols) {
    _symbols = buildIndex(root);
  }
  return _symbols;
}

export function invalidateSymbols(): void {
  _symbols = null;
  _scopeRoot = null;
}

export function getHuSymbols(contextFile?: string): HuSymbol[] {
  return getSymbols(contextFile).filter((s): s is HuSymbol => s.kind === "hu");
}

export function getLmDefSymbols(contextFile?: string): LmDefSymbol[] {
  return getSymbols(contextFile).filter((s): s is LmDefSymbol => s.kind === "def");
}

export function getCallableSymbols(contextFile?: string): CallableSymbol[] {
  return getSymbols(contextFile).filter(
    (s): s is CallableSymbol => s.kind === "hu" || s.kind === "def",
  );
}

export function findHuByName(name: string, contextFile?: string): HuSymbol | undefined {
  const matches = getHuSymbols(contextFile).filter((s) => s.name === name);
  if (matches.length <= 1) return matches[0];
  if (!contextFile) return matches[0];
  return _closestByPath(matches, contextFile);
}

export function findCallableByName(name: string, contextFile?: string): CallableSymbol | undefined {
  const matches = getCallableSymbols(contextFile).filter((s) => s.name === name);
  if (matches.length <= 1) return matches[0];
  if (!contextFile) return matches[0];
  return _closestByPath(matches, contextFile);
}

function _closestByPath<T extends { filePath: string }>(matches: T[], contextFile: string): T {
  const ctxDir = path.dirname(contextFile);
  matches.sort((a, b) => {
    const distA = _pathDistance(ctxDir, path.dirname(a.filePath));
    const distB = _pathDistance(ctxDir, path.dirname(b.filePath));
    return distA - distB;
  });
  return matches[0];
}

function _pathDistance(from: string, to: string): number {
  const rel = path.relative(from, to);
  if (!rel) return 0;
  return rel.split(path.sep).length;
}

// ── Build ───────────────────────────────────────────────────────────────────

function buildIndex(root: string | null): LamiaSymbol[] {
  if (!root) return [];

  const symbols: LamiaSymbol[] = [];

  for (const file of collectFiles(root, MAX_DEPTH)) {
    const ext = path.extname(file).toLowerCase();
    if (ext === ".hu") {
      const sym = parseHuFile(file, root);
      if (sym) symbols.push(sym);
    } else if (ext === ".lm") {
      const defs = parseLmFileDefs(file, root);
      symbols.push(...defs);
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
    FILE_REF_RE.lastIndex = 0;
    while ((m = FILE_REF_RE.exec(content)) !== null) {
      const ref = m[1];
      if (!seen.has(ref)) {
        seen.add(ref);
        paramDetails.push({ name: ref, required: true, isFileRef: true });
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

// Regex: def funcname(params) -> ReturnType:
const LM_DEF_RE = /^def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*(.+?))?\s*:\s*$/;
const LM_DEF_PARAM_RE = /(\w+)(?:\s*:\s*\w+)?\s*(?:=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?|True|False|None))?/g;

function parseLmFileDefs(filePath: string, root: string): LmDefSymbol[] {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    const symbols: LmDefSymbol[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const defMatch = LM_DEF_RE.exec(line);
      if (!defMatch) continue;

      const funcName = defMatch[1];
      const rawParams = defMatch[2].trim();
      const returnType = defMatch[3]?.trim();

      // Collect the function body (string literal on next indented line(s))
      let template = "";
      for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
        const bodyLine = lines[j];
        if (!bodyLine.match(/^\s/)) break;
        const strMatch = bodyLine.match(/^\s+["'](.*)["']\s*$/);
        if (strMatch) {
          template = strMatch[1];
          break;
        }
        const tripleMatch = bodyLine.match(/^\s+"""(.*)"""\s*$/);
        if (tripleMatch) {
          template = tripleMatch[1];
          break;
        }
      }

      const paramDetails = parseLmDefParams(rawParams, template);
      symbols.push({
        kind: "def",
        name: funcName,
        params: paramDetails.map((p) => p.name),
        paramDetails,
        returnType,
        filePath,
        relativePath: path.relative(root, filePath),
        line: i + 1,
      });
    }

    return symbols;
  } catch {
    return [];
  }
}

function parseLmDefParams(rawParams: string, template: string): HuParam[] {
  if (!rawParams) return extractTemplateOnlyParams(template);

  const paramDetails: HuParam[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  LM_DEF_PARAM_RE.lastIndex = 0;
  while ((m = LM_DEF_PARAM_RE.exec(rawParams)) !== null) {
    const pName = m[1];
    if (seen.has(pName)) continue;
    seen.add(pName);
    const rawDefault = m[2];
    if (rawDefault !== undefined) {
      const cleaned = cleanDefault(rawDefault);
      paramDetails.push({ name: pName, required: false, defaultValue: cleaned });
    } else {
      paramDetails.push({ name: pName, required: true });
    }
  }

  return paramDetails;
}

function extractTemplateOnlyParams(template: string): HuParam[] {
  if (!template) return [];
  const params: HuParam[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  PARAM_RE.lastIndex = 0;
  while ((m = PARAM_RE.exec(template)) !== null) {
    const pName = m[1];
    if (pName.startsWith("@") || seen.has(pName)) continue;
    seen.add(pName);
    const defaultVal = m[2];
    params.push({
      name: pName,
      required: defaultVal === undefined,
      defaultValue: defaultVal !== undefined ? (defaultVal === "None" ? "" : defaultVal) : undefined,
    });
  }
  FILE_REF_RE.lastIndex = 0;
  while ((m = FILE_REF_RE.exec(template)) !== null) {
    const ref = m[1];
    if (!seen.has(ref)) {
      seen.add(ref);
      params.push({ name: ref, required: true, isFileRef: true });
    }
  }
  return params;
}

function cleanDefault(raw: string): string {
  if (raw === "None") return "";
  if (raw === "True") return "true";
  if (raw === "False") return "false";
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

// ── Scanning helpers ────────────────────────────────────────────────────────

function resolveProjectRoot(contextFile?: string): string | null {
  if (contextFile) {
    let dir = path.dirname(contextFile);
    const fsRoot = path.parse(dir).root;
    while (dir !== fsRoot) {
      if (fs.existsSync(path.join(dir, "config.yaml"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
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
