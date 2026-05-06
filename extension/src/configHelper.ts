import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFile } from "child_process";
import * as vscode from "vscode";
import { getApiKey, getConfiguredProviders } from "./envHelper";
import { LamiaProcess } from "./lamiaProcess";

const LAMIA_HOME = path.join(os.homedir(), ".lamia");

interface ModelEntry {
  id: string;
  label: string;
}

export type ModelList = Record<string, ModelEntry[]>;
export type ModelOption = { value: string; label: string; disabled?: boolean; provider?: string; isCustom?: boolean };

export interface SubProjectInfo {
  name: string;
  root: string;
  configPath: string;
}

type LamiaModelsOutput = Record<string, string[]>;
const NATIVE_PROVIDERS = new Set<string>(["openai", "anthropic", "ollama"]);
const PRIMARY_NATIVE_PROVIDERS = new Set<string>(["openai", "anthropic"]);
const MAX_DEFAULT_MODELS = 12;
const MODEL_SEPARATOR: ModelOption = { value: "__separator__", label: "────────────────", disabled: true };

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

  const ideConfig = path.join(LAMIA_HOME, "ide", "config.yaml");
  if (fs.existsSync(ideConfig)) {
    visited.add(ideConfig);
    results.push({ name: "ide", root: path.join(LAMIA_HOME, "ide"), configPath: ideConfig });
  }

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
          if (name) result[currentProvider].push(ensureProviderPrefix(name, currentProvider));
        } else {
          const raw = trimmed.slice(2).trim().replace(/^["']|["']$/g, "");
          const name = stripComment(raw);
          if (name) result[currentProvider].push(ensureProviderPrefix(name, currentProvider));
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

export async function fetchRuntimeProviderModels(configPath?: string): Promise<LamiaModelsOutput> {
  let cliPath: string;
  try {
    cliPath = await LamiaProcess.resolveCliPath();
  } catch {
    return {};
  }

  const args: string[] = [];
  if (configPath) {
    args.push("--config", configPath);
  }
  args.push("models");

  const cwd = LamiaProcess.resolveWorkingDirForFile(vscode.window.activeTextEditor?.document.uri.fsPath);
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );

  const openaiKey = getApiKey("openai");
  if (openaiKey) env.OPENAI_API_KEY = openaiKey;
  const anthropicKey = getApiKey("anthropic");
  if (anthropicKey) env.ANTHROPIC_API_KEY = anthropicKey;

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(cliPath, args, { cwd, env, timeout: 20000 }, (error, out, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message || "failed")));
          return;
        }
        resolve(out || "");
      });
    });
    return parseLamiaModelsOutput(stdout);
  } catch {
    return {};
  }
}

export function buildModelDropdown(
  projectModels: string[],
  providerModels: Record<string, string[]>,
  fallbackModels: ModelList,
  configuredProviders: string[]
): { defaultModels: ModelOption[]; allModels: ModelOption[] } {
  const seen = new Set<string>();
  const allItems: ModelOption[] = [];
  const customItems: ModelOption[] = [];

  const fallbackLabelMap = new Map<string, string>();
  for (const [provider, models] of Object.entries(fallbackModels)) {
    for (const model of models) {
      const full = ensureProviderPrefix(model.id, provider);
      fallbackLabelMap.set(normalizeModelKey(full), modelLabel(model.label, provider));
    }
  }

  const addModel = (
    rawModel: string,
    providerHint?: string,
    options?: { forceCustom?: boolean },
  ) => {
    const fullModel = ensureProviderPrefix(rawModel, providerHint);
    if (!fullModel) return;
    const key = normalizeModelKey(fullModel);
    if (seen.has(key)) return;
    seen.add(key);

    const provider = getProvider(fullModel) || (providerHint || "unknown");
    const friendly = fallbackLabelMap.get(key);
    const label = friendly || humanLabel(fullModel);
    const item: ModelOption = {
      value: fullModel,
      label,
      provider,
      isCustom: !!options?.forceCustom || isCustomProvider(provider),
    };
    if (item.isCustom) {
      customItems.push(item);
    } else {
      allItems.push(item);
    }
  };

  for (const m of projectModels) {
    addModel(m, undefined, { forceCustom: true });
  }

  // Runtime/API models — only present when the key was accepted by the provider.
  for (const [provider, models] of Object.entries(providerModels)) {
    for (const model of models) {
      addModel(model, provider);
    }
  }

  // Fallback: only for providers that have a configured key but returned
  // zero runtime models (API momentarily unreachable).  Never show models
  // for providers without a key — they won't work.
  for (const [provider, models] of Object.entries(fallbackModels)) {
    if (!configuredProviders.includes(provider)) continue;
    const hasRuntimeModels = (providerModels[provider] || []).length > 0;
    if (hasRuntimeModels) continue;
    for (const model of models) {
      addModel(model.id, provider);
    }
  }

  const defaultOthers = pickDefaultModels(allItems);
  const allModels = joinWithSeparator(customItems, allItems);
  const defaultModels = joinWithSeparator(customItems, defaultOthers);
  return { defaultModels, allModels };
}

function parseLamiaModelsOutput(output: string): LamiaModelsOutput {
  const modelsByProvider: LamiaModelsOutput = {};
  const lines = output.split(/\r?\n/);
  let currentProvider = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const header = trimmed.match(/^([a-zA-Z0-9._-]+)\s+\(\d+\s+models\):$/);
    if (header) {
      currentProvider = header[1];
      if (!modelsByProvider[currentProvider]) {
        modelsByProvider[currentProvider] = [];
      }
      continue;
    }

    const nonListHeader = trimmed.match(/^([a-zA-Z0-9._-]+):\s+(skipped|error|no models found)/);
    if (nonListHeader) {
      currentProvider = "";
      continue;
    }

    if (!currentProvider) continue;
    if (!line.startsWith("  ")) continue;

    const modelId = trimmed;
    if (!modelId) continue;

    const fullName = ensureProviderPrefix(modelId, currentProvider);
    const target = modelsByProvider[currentProvider];
    if (fullName && !target.includes(fullName)) {
      target.push(fullName);
    }
  }

  return modelsByProvider;
}

function modelLabel(label: string, provider: string): string {
  return shouldShowProviderSuffix(provider) ? `${label} (${provider})` : label;
}

function humanLabel(providerModel: string): string {
  const parts = providerModel.split(":");
  if (parts.length < 2) return stripComment(providerModel);
  const model = stripComment(parts.slice(1).join(":"));
  const provider = parts[0];
  return shouldShowProviderSuffix(provider) ? `${model} (${provider})` : model;
}

function normalizeModelKey(providerModel: string): string {
  return providerModel.trim().toLowerCase();
}

function getProvider(providerModel: string): string | null {
  const idx = providerModel.indexOf(":");
  if (idx <= 0) return null;
  return providerModel.slice(0, idx).trim();
}

function ensureProviderPrefix(model: string, providerHint?: string): string {
  const raw = stripComment(model).trim();
  if (!raw) return "";
  if (raw.includes(":")) return raw;
  if (!providerHint) return raw;
  return `${providerHint}:${raw}`;
}

function isCustomProvider(provider: string): boolean {
  return !NATIVE_PROVIDERS.has(provider);
}

function pickDefaultModels(allItems: ModelOption[]): ModelOption[] {
  const popular = allItems.filter((item) => {
    const provider = item.provider || "";
    return PRIMARY_NATIVE_PROVIDERS.has(provider);
  });
  if (popular.length > 0) {
    return popular.slice(0, MAX_DEFAULT_MODELS);
  }
  return allItems.filter((item) => (item.provider || "") !== "ollama").slice(0, MAX_DEFAULT_MODELS);
}

function joinWithSeparator(top: ModelOption[], rest: ModelOption[]): ModelOption[] {
  if (top.length === 0) {
    return [...rest];
  }
  if (rest.length === 0) {
    return [...top];
  }
  return [...top, MODEL_SEPARATOR, ...rest];
}

function shouldShowProviderSuffix(provider: string): boolean {
  return provider === "ollama" || isCustomProvider(provider);
}

function stripComment(s: string): string {
  const idx = s.indexOf("#");
  return idx >= 0 ? s.slice(0, idx).trim() : s.trim();
}
