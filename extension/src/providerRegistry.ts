/**
 * Central provider registry — single source of truth for all LLM provider
 * configuration in the IDE extension.
 *
 * When adding a new provider, update ONLY this file.  Every other module
 * derives its provider knowledge from here.
 */

export interface ProviderDef {
  /** Environment variable that holds the API key (e.g. "OPENAI_API_KEY"). */
  envVar: string;
  /** Human-readable label for the UI. */
  label: string;
  /** Primary providers are shown prominently in the default model dropdown. */
  primary?: true;
  /** Whether an API key is required (true) or optional (false/omitted). */
  keyRequired?: boolean;
  /** Endpoint + header builder for one-shot key validation (omit if not applicable). */
  validation?: {
    url: string;
    headers: (key: string) => Record<string, string>;
  };
}

/**
 * IDE-owned OpenRouter proxy endpoints.
 */
export const OPENROUTER_PROXY_BASE_URL = "https://lamia-free.serg-sargsyan.workers.dev";
export const OPENROUTER_PROXY_API_URL = `${OPENROUTER_PROXY_BASE_URL}/v1`;
export const OPENROUTER_PROXY_AUTH_KEY_URL = `${OPENROUTER_PROXY_BASE_URL}/v1/auth/key`;

/**
 * The canonical list of built-in LLM providers.
 *
 * Ordering matters: the settings dropdown renders providers in this order.
 */
export const PROVIDERS: Record<string, ProviderDef> = {
  anthropic: {
    envVar: "ANTHROPIC_API_KEY",
    label: "Anthropic",
    primary: true,
    keyRequired: true,
    validation: {
      url: "https://api.anthropic.com/v1/models",
      headers: (key) => ({
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      }),
    },
  },
  openai: {
    envVar: "OPENAI_API_KEY",
    label: "OpenAI",
    primary: true,
    keyRequired: true,
    validation: {
      url: "https://api.openai.com/v1/models",
      headers: (key) => ({ Authorization: `Bearer ${key}` }),
    },
  },
  openrouter: {
    envVar: "OPENROUTER_API_KEY",
    label: "OpenRouter",
    keyRequired: true,
    validation: {
      url: OPENROUTER_PROXY_AUTH_KEY_URL,
      headers: (key) => ({ Authorization: `Bearer ${key}` }),
    },
  },
  ollama: {
    envVar: "",
    label: "Ollama (local)",
    keyRequired: false,
  },
};

// ── Derived constants ─────────────────────────────────────────────────────────

/** Provider name → env var.  Omits providers with no env var (e.g. ollama). */
export const PROVIDER_KEY_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(PROVIDERS)
    .filter(([, def]) => def.envVar)
    .map(([name, def]) => [name, def.envVar]),
);

/** Primary providers shown prominently in the default model dropdown. */
export const PRIMARY_PROVIDERS: ReadonlySet<string> = new Set(
  Object.entries(PROVIDERS)
    .filter(([, def]) => def.primary)
    .map(([name]) => name),
);

/** Validation endpoints keyed by provider name. */
export const VALIDATION_ENDPOINTS: Record<
  string,
  { url: string; headers: (key: string) => Record<string, string> }
> = Object.fromEntries(
  Object.entries(PROVIDERS)
    .filter(([, def]) => def.validation)
    .map(([name, def]) => [name, def.validation!]),
);

/** Ordered list of providers that accept API keys (for the settings dropdown). */
export const KEY_PROVIDERS: { name: string; label: string }[] = Object.entries(PROVIDERS)
  .filter(([, def]) => def.envVar)
  .map(([name, def]) => ({ name, label: def.label }));
