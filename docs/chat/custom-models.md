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

Lamia supports custom LLM adapters for providers not built into the system. These are Python files placed in the `extensions/adapters/` folder of your project. See [Lamia Docs — Custom LLM Adapters](https://lamia-lang.github.io/lamia/user-guide/custom-llm-adapters/) for the adapter API and implementation guide.

### Creating an Adapter

An adapter is a Python file that implements the Lamia LLM adapter interface. The file name should match the provider name returned by the adapter's `name()` method — for example, a provider named `"my_provider"` should live in `my_provider.py`.

Place it in your project's `extensions/adapters/` folder:

```text
your-project/
├── extensions/
│   └── adapters/
│       └── my_provider.py
└── config.yaml
```

Lamia Studio automatically copies custom adapters from your workspace into the IDE's internal folder (`~/.lamia/ide/extensions/adapters/`). The copied file is named after the provider name from the adapter's `name()` classmethod, ensuring unique identification.

Add the adapter's provider to your `config.yaml`:

```yaml
model_chain:
  - name: "my_provider:my-model-v1"
    max_retries: 3
```

### API Keys for Custom Adapters

For custom providers that require API keys, add the key to `~/.lamia/.env`:

```
# The env var name is defined by the adapter's env_var_names() method
MY_PROVIDER_API_KEY=your-key-here
```

### Listing Available Models

Use the CLI to discover models from any provider:

```bash
# List models from all configured providers
lamia models

# List models from a specific provider
lamia models --provider anthropic
```

Custom adapters can support this by implementing the `models()` classmethod.