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

Lamia supports custom LLM adapters for providers not built into the system. These are Python files placed in the `extension/adapters/` folder of your Lamia installation or in your project. See [Lamia Docs — Custom LLM Adapters](https://lamia-lang.github.io/lamia/user-guide/custom-llm-adapters/) for the adapter API and implementation guide.

### Creating an Adapter and registering

An adapter is a Python file that implements the Lamia LLM adapter interface. Place it in your project directory or the global adapters folder.

Add the adapter's provider to your `config.yaml`:

```yaml

model_chain:
  - name: "my_custom_provider:my-model-v1"
    max_retries: 3
```

### API Keys for Custom Adapters

For custom providers that require API keys, add the key to `~/.lamia/.env`:

```
# The LLM adapter implementation requires specifying the name of the API key name in the python file
MY_PROVIDER_API_KEY=your-key-here
```
