import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";
import { getApiKey, getConfiguredProviders } from "./envHelper";

const LAMIA_HOME = path.join(os.homedir(), ".lamia");

interface ModelEntry {
  id: string;
  label: string;
}

export type ModelList = Record<string, ModelEntry[]>;

export interface SubProjectInfo {
  name: string;
  root: string;
  configPath: string;
}

export function readProjectModels(): string[] {
  const configPath = findConfigYaml();
  if (!configPath) return [];

  try {
    const raw = fs.readFileSync(configPath, "utf8");
    return parseModelChain(raw);
  } catch {
    return [];
  }
}

export function readAllProviderModels(): { chain: string[]; providerModels: Record<string, string[]> } {
  const configs = findAllConfigYamls();
  const chain: string[] = [];
  const providerModels: Record<string, string[]> = {};
  const seen = new Set<string>();

  for (const sub of configs) {
    try {
      const raw = fs.readFileSync(sub.configPath, "utf8");
      for (const m of parseModelChain(raw)) {
        if (!seen.has(m)) {
          seen.add(m);
          chain.push(m);
        }
      }
      for (const [prov, models] of Object.entries(parseProviderModels(raw))) {
        if (!providerModels[prov]) providerModels[prov] = [];
        for (const m of models) {
          if (!seen.has(m)) {
            seen.add(m);
            providerModels[prov].push(m);
          }
        }
      }
    } catch {}
  }

  return { chain, providerModels };
}

export function findAllConfigYamls(): SubProjectInfo[] {
  const results: SubProjectInfo[] = [];
  const visited = new Set<string>();

  const folders = vscode.workspace.workspaceFolders;
  if (folders) {
    for (const folder of folders) {
      walkForConfigs(folder.uri.fsPath, folder.name, results, visited, 4);
    }
  }

  const globalConfig = path.join(LAMIA_HOME, "config.yaml");
  if (fs.existsSync(globalConfig) && !visited.has(globalConfig)) {
    results.push({ name: "global", root: LAMIA_HOME, configPath: globalConfig });
  }

  return results;
}

function walkForConfigs(
  dir: string,
  displayName: string,
  results: SubProjectInfo[],
  visited: Set<string>,
  maxDepth: number
): void {
  if (maxDepth < 0) return;

  const configPath = path.join(dir, "config.yaml");
  if (fs.existsSync(configPath) && !visited.has(configPath)) {
    visited.add(configPath);
    results.push({ name: displayName, root: dir, configPath });
    return;
  }

  if (maxDepth <= 0) return;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "__pycache__" || entry.name === "venv") continue;
      walkForConfigs(
        path.join(dir, entry.name),
        `${displayName}/${entry.name}`,
        results,
        visited,
        maxDepth - 1
      );
    }
  } catch {}
}

function findConfigYaml(): string | null {
  const configs = findAllConfigYamls();
  return configs.length > 0 ? configs[0].configPath : null;
}

function parseModelChain(yamlContent: string): string[] {
  const models: string[] = [];
  const lines = yamlContent.split("\n");
  let inModelChain = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "model_chain:") {
      inModelChain = true;
      continue;
    }
    if (inModelChain) {
      if (trimmed.startsWith("- name:")) {
        const raw = trimmed.replace("- name:", "").trim().replace(/^["']|["']$/g, "");
        const name = stripComment(raw);
        if (name) models.push(name);
      } else if (trimmed.startsWith("- ") && !trimmed.includes(":")) {
        const raw = trimmed.slice(2).trim().replace(/^["']|["']$/g, "");
        const name = stripComment(raw);
        if (name) models.push(name);
      } else if (trimmed && !trimmed.startsWith("-") && !trimmed.startsWith("#") && !trimmed.startsWith("max_retries") && !trimmed.startsWith("temperature")) {
        if (!trimmed.startsWith(" ") && !trimmed.startsWith("\t")) {
          inModelChain = false;
        }
      }
    }
  }
  return models;
}

function parseProviderModels(yamlContent: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  const lines = yamlContent.split("\n");
  let currentProvider = "";
  let inProviders = false;
  let inModels = false;
  let providerIndent = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    if (trimmed === "providers:") {
      inProviders = true;
      continue;
    }

    if (inProviders && trimmed && !trimmed.startsWith("#")) {
      if (indent === 2 && trimmed.endsWith(":") && !trimmed.startsWith("-")) {
        currentProvider = trimmed.slice(0, -1);
        if (!result[currentProvider]) result[currentProvider] = [];
        providerIndent = indent;
        inModels = false;
        continue;
      }

      if (currentProvider && trimmed === "models:") {
        inModels = true;
        continue;
      }

      if (inModels && trimmed.startsWith("- ")) {
        if (trimmed.startsWith("- name:")) {
          const raw = trimmed.replace("- name:", "").trim().replace(/^["']|["']$/g, "");
          const name = stripComment(raw);
          if (name) result[currentProvider].push(`${currentProvider}:${name}`);
        } else {
          const raw = trimmed.slice(2).trim().replace(/^["']|["']$/g, "");
          const name = stripComment(raw);
          if (name) result[currentProvider].push(`${currentProvider}:${name}`);
        }
        continue;
      }

      if (indent <= providerIndent && indent > 0 && trimmed && !trimmed.startsWith("-")) {
        inModels = false;
      }

      if (indent === 0 && trimmed && trimmed !== "providers:") {
        inProviders = false;
      }
    }
  }
  return result;
}

export function ensureGlobalConfig(): void {
  const globalConfig = path.join(LAMIA_HOME, "config.yaml");
  if (fs.existsSync(globalConfig)) return;

  const providers = getConfiguredProviders();
  if (providers.length === 0) return;

  const defaultModels: Record<string, string> = {
    anthropic: "anthropic:claude-sonnet-4-20250514",
    openai: "openai:gpt-4o",
  };

  const primary = defaultModels[providers[0]] || `${providers[0]}`;
  const lines = [
    "model_chain:",
    `  - name: "${primary}"`,
    "    max_retries: 3",
  ];

  for (const p of providers.slice(1)) {
    const m = defaultModels[p] || p;
    lines.push(`  - name: "${m}"`);
    lines.push("    max_retries: 2");
  }

  lines.push("");
  lines.push("providers:");
  for (const p of providers) {
    lines.push(`  ${p}:`);
    lines.push("    enabled: true");
  }
  lines.push("");

  fs.mkdirSync(LAMIA_HOME, { recursive: true });
  fs.writeFileSync(globalConfig, lines.join("\n"), "utf8");
}

const MODELS_URL = "https://raw.githubusercontent.com/lamia-lang/lamia-ide/main/models.json";

let _cachedFallbackModels: ModelList | undefined;

export async function fetchFallbackModels(): Promise<ModelList> {
  if (_cachedFallbackModels) return _cachedFallbackModels;

  try {
    const res = await fetch(MODELS_URL);
    if (res.ok) {
      _cachedFallbackModels = (await res.json()) as ModelList;
      return _cachedFallbackModels;
    }
  } catch {}

  try {
    const bundled = path.join(__dirname, "..", "models.json");
    _cachedFallbackModels = JSON.parse(fs.readFileSync(bundled, "utf8")) as ModelList;
    return _cachedFallbackModels;
  } catch {
    return {
      anthropic: [{ id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" }],
      openai: [{ id: "gpt-4o", label: "GPT-4o" }],
    };
  }
}

export function buildModelDropdown(
  projectModels: string[],
  _providerModels: Record<string, string[]>,
  fallbackModels: ModelList,
  configuredProviders: string[]
): { value: string; label: string }[] {
  const seen = new Set<string>();
  const items: { value: string; label: string }[] = [];

  const fallbackLabelMap = new Map<string, string>();
  for (const [provider, models] of Object.entries(fallbackModels)) {
    for (const model of models) {
      fallbackLabelMap.set(`${provider}:${model.id}`, modelLabel(model.label, provider));
    }
  }

  for (const m of projectModels) {
    if (seen.has(m)) continue;
    seen.add(m);
    const friendly = fallbackLabelMap.get(m);
    items.push({ value: m, label: friendly || humanLabel(m) });
  }

  for (const [provider, models] of Object.entries(fallbackModels)) {
    for (const model of models) {
      const full = `${provider}:${model.id}`;
      if (seen.has(full)) continue;
      seen.add(full);
      const hasKey = configuredProviders.includes(provider);
      const label = modelLabel(model.label, provider) + (hasKey ? "" : " \u{1F512}");
      items.push({ value: full, label });
    }
  }

  return items;
}

function modelLabel(label: string, provider: string): string {
  return provider === "ollama" ? `${label} (ollama)` : label;
}

function humanLabel(providerModel: string): string {
  const parts = providerModel.split(":");
  if (parts.length < 2) return stripComment(providerModel);
  const model = stripComment(parts.slice(1).join(":"));
  const provider = parts[0];
  return provider === "ollama" ? `${model} (ollama)` : model;
}

function stripComment(s: string): string {
  const idx = s.indexOf("#");
  return idx >= 0 ? s.slice(0, idx).trim() : s.trim();
}
