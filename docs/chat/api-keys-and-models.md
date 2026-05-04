# API Keys & Models

## Configuring API Keys

### From the Chat Panel

1. Click the gear icon (⚙) in the chat header bar
2. Select a provider (Anthropic or OpenAI)
3. Paste your API key
4. Click **Save Key**

The status line shows which providers are configured.

### Manual Configuration

API keys are stored in `~/.lamia/.env`. You can edit this file directly:

```
ANTHROPIC_API_KEY=sk-ant-api03-...
OPENAI_API_KEY=sk-...
```

### Changing API Keys

To update a key, simply click the gear icon (⚙) in the chat header bar, select the provider, and enter the new key.

## Selecting a Model

Use the dropdown in the chat header bar. Models appear from three sources, in priority order:

### 1. Project Models (from config.yaml)

If your project has a `config.yaml` or multiple `config.yaml` files in case of multi project workspace, all models from the `model_chain` section are discovered and appear first:

```yaml
model_chain:
  - name: "anthropic:claude-sonnet-4-20250514"
    max_retries: 3
  - name: "openai:gpt-4o"
    max_retries: 2
```

Lamia Studio discovers `config.yaml` files in your workspace (up to 4 directories deep) and the global `~/.lamia/config.yaml`.

### 2. Built-in Model List (models.json)

After project models, Lamia Studio adds models from a built-in list. This list is fetched from the [lamia-ide repository](https://raw.githubusercontent.com/lamia-lang/lamia-ide/main/models.json) on startup, with a bundled copy as fallback.

Models whose provider has no configured API key show a lock icon (🔒). Configure the key to unlock them.

## Model Format

Models use the format `provider:model-id`, for example:

- `anthropic:claude-sonnet-4-20250514`
- `openai:gpt-4o`
- `ollama:llama3`

## Switching Models Mid-Chat

You can switch models at any time using the dropdown. The next message will use the new model. The backend config is updated automatically.
