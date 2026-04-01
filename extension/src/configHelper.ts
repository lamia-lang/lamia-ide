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

interface YamlModelChainEntry {
  name?: string;
  [key: string]: unknown;
}

interface YamlProviderConfig {
  enabled?: boolean;
  models?: (string | { name: string; [key: string]: unknown })[];
  [key: string]: unknown;
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
  const configPath = findConfigYaml();
  if (!configPath) return { chain: [], providerModels: {} };

  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const chain = parseModelChain(raw);
    const providerModels = parseProviderModels(raw);
    return { chain, providerModels };
  } catch {
    return { chain: [], providerModels: {} };
  }
}

function findConfigYaml(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    const p = path.join(folders[0].uri.fsPath, "config.yaml");
    if (fs.existsSync(p)) return p;
  }

  const global = path.join(LAMIA_HOME, "config.yaml");
  if (fs.existsSync(global)) return global;

  return null;
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
        const name = trimmed.replace("- name:", "").trim().replace(/^["']|["']$/g, "");
        if (name) models.push(name);
      } else if (trimmed.startsWith("- ") && !trimmed.includes(":")) {
        const name = trimmed.slice(2).trim().replace(/^["']|["']$/g, "");
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
          const name = trimmed.replace("- name:", "").trim().replace(/^["']|["']$/g, "");
          if (name) result[currentProvider].push(`${currentProvider}:${name}`);
        } else {
          const name = trimmed.slice(2).trim().replace(/^["']|["']$/g, "");
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

const MODELS_URL = "https://raw.githubusercontent.com/LamiaOrg/lamia-ide/main/models.json";

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
  providerModels: Record<string, string[]>,
  fallbackModels: ModelList,
  configuredProviders: string[]
): { value: string; label: string }[] {
  const seen = new Set<string>();
  const items: { value: string; label: string }[] = [];

  for (const m of projectModels) {
    if (seen.has(m)) continue;
    seen.add(m);
    items.push({ value: m, label: humanLabel(m) });
  }

  for (const [provider, models] of Object.entries(providerModels)) {
    if (!configuredProviders.includes(provider)) continue;
    for (const m of models) {
      if (seen.has(m)) continue;
      seen.add(m);
      items.push({ value: m, label: humanLabel(m) });
    }
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
  if (parts.length < 2) return providerModel;
  const model = parts.slice(1).join(":");
  const provider = parts[0];
  return provider === "ollama" ? `${model} (ollama)` : model;
}
