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

export function getApiKey(provider: string): string | undefined {
  const envVar = PROVIDER_KEY_MAP[provider];
  if (!envVar) return undefined;

  // 1. ~/.lamia/.env
  const fromFile = readEnvFile()[envVar];
  if (fromFile) return fromFile;

  // 2. process.env
  return process.env[envVar] || undefined;
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
