# Custom Models

Lamia Studio supports models beyond the built-in Anthropic and OpenAI options, including Ollama local models and custom LLM adapters.

## Ollama (Local Models)

To use local models via [Ollama](https://ollama.ai):

1. Install and start Ollama on your machine
2. Add the model to your project `config.yaml`:

```yaml
model_chain:
  - name: "ollama:llama3"
    max_retries: 2
```

3. The model will appear in the chat dropdown as `llama3 (ollama)`.

No API key is needed for Ollama — it runs locally.

## Custom LLM Adapters

Lamia supports custom LLM adapters for providers not built into the system. See [Lamia Docs — Custom LLM Adapters](https://lamia-lang.github.io/lamia/user-guide/custom-llm-adapters/) for the adapter interface and implementation examples. This page covers how Lamia Studio discovers and loads adapter files.

### Where Lamia Studio Looks

Place adapter files in an `extensions/adapters/` folder anywhere in your workspace:

```text
your-project/
├── extensions/
│   └── adapters/
│       └── my_provider.py
└── config.yaml
```

Lamia Studio searches each workspace folder up to 5 directories deep for an `extensions/adapters/` folder, skipping `node_modules`, `__pycache__`, `venv`, and dot-directories. This means the adapter folder doesn't have to sit at the workspace root — it works from a nested package too.

Only `.py` files are picked up, and files starting with `_` are skipped.

### How Adapters Get Loaded

Lamia Studio copies matching files into `~/.lamia/ide/extensions/adapters/`, renaming each one to `{provider_name}.py`. The provider name comes from parsing the adapter's `name()` classmethod as source text — not by importing the file. Keep it a plain `return "..."` with a string literal; a computed value won't be picked up.

This sync happens when the chat panel starts (or restarts) its backend process. If you add or edit an adapter file while a chat session is already running, close and reopen the chat panel to pick up the change — an in-progress session won't notice edits on its own.

Once an adapter is detected, Lamia Studio adds it to the chat backend's config automatically; you don't need to edit that file by hand.

### Using the Adapter

Add the adapter's provider to your `config.yaml`:

```yaml
model_chain:
  - name: "my_provider:my-model-v1"
    max_retries: 3
```

The model will appear in the chat dropdown as `my-model-v1 (my_provider)`.

### Example: Claude Pro or Max Subscription

To run Lamia Studio chat on a Claude Pro or Max subscription instead of pay-per-token API billing, use the [Claude subscription adapter](https://lamia-lang.github.io/lamia/user-guide/custom-llm-adapters/#claude-subscription) from the Lamia docs. Once it is in `extensions/adapters/` and its model is in `config.yaml`, the model appears in the chat dropdown.

### API Keys for Custom Adapters

For custom providers that require API keys, add the key to `~/.lamia/.env` the same way as for [built-in providers](api-keys-and-models.md#configuring-api-keys). The env var name is whatever the adapter's `env_var_names()` method returns.

### Listing Available Models

Use the CLI to discover models from any provider:

```bash
lamia models --provider my_provider
```

Custom adapters support this by implementing the `models()` classmethod.
