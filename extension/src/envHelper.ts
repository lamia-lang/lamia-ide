import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const LAMIA_DIR = path.join(os.homedir(), ".lamia");
const ENV_FILE = path.join(LAMIA_DIR, ".env");

const PROVIDER_KEY_MAP: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

function readEnvFile(): Record<string, string> {
  try {
    return parseEnvFile(fs.readFileSync(ENV_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeEnvFile(entries: Record<string, string>): void {
  fs.mkdirSync(LAMIA_DIR, { recursive: true });

  let existing: Record<string, string> = {};
  try {
    existing = parseEnvFile(fs.readFileSync(ENV_FILE, "utf8"));
  } catch {
    // file doesn't exist yet
  }

  const merged = { ...existing, ...entries };
  const lines = Object.entries(merged).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(ENV_FILE, lines.join("\n") + "\n", "utf8");
}

export type KeySource = "global_env" | "project_env" | "process_env";

export interface ApiKeyInfo {
  key: string;
  source: KeySource;
  sourceLabel: string;
  masked: string;
}

export function getApiKey(provider: string): string | undefined {
  const envVar = PROVIDER_KEY_MAP[provider];
  if (!envVar) return undefined;

  // 1. ~/.lamia/.env
  const fromFile = readEnvFile()[envVar];
  if (fromFile) return fromFile;

  // 2. process.env
  return process.env[envVar] || undefined;
}

export function getApiKeyInfo(provider: string): ApiKeyInfo | undefined {
  const envVar = PROVIDER_KEY_MAP[provider];
  if (!envVar) return undefined;

  const fromFile = readEnvFile()[envVar];
  if (fromFile) {
    return { key: fromFile, source: "global_env", sourceLabel: "~/.lamia/.env", masked: maskKey(fromFile) };
  }
  const fromEnv = process.env[envVar];
  if (fromEnv) {
    return { key: fromEnv, source: "process_env", sourceLabel: "environment variable", masked: maskKey(fromEnv) };
  }
  return undefined;
}

export function setApiKey(provider: string, key: string): void {
  const envVar = PROVIDER_KEY_MAP[provider];
  if (!envVar) return;
  writeEnvFile({ [envVar]: key });
}

export function getConfiguredProviders(): string[] {
  return Object.keys(PROVIDER_KEY_MAP).filter((p) => !!getApiKey(p));
}

export function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "..." + key.slice(-4);
}

const VALIDATION_ENDPOINTS: Record<string, { url: string; headers: (key: string) => Record<string, string> }> = {
  openai: {
    url: "https://api.openai.com/v1/models",
    headers: (key) => ({ "Authorization": `Bearer ${key}` }),
  },
  anthropic: {
    url: "https://api.anthropic.com/v1/models",
    headers: (key) => ({
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    }),
  },
};

export type KeyValidationResult = { valid: true } | { valid: false; error: string };

export async function validateApiKey(provider: string, key: string): Promise<KeyValidationResult> {
  const endpoint = VALIDATION_ENDPOINTS[provider];
  if (!endpoint) {
    return { valid: true };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(endpoint.url, {
      method: "GET",
      headers: endpoint.headers(key),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.ok) {
      return { valid: true };
    }
    if (res.status === 401 || res.status === 403) {
      return { valid: false, error: "Invalid API key" };
    }
    if (res.status === 429) {
      return { valid: true };
    }
    return { valid: false, error: `API returned ${res.status}` };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return { valid: true };
    }
    return { valid: true };
  }
}
