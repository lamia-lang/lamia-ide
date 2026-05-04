# Global Settings

## IDE Settings

Lamia Studio settings are accessible via `Cmd+,` (macOS) or `Ctrl+,` (Windows/Linux). Search for "Lamia" or navigate to the "Extensions"->"Lamia" section to find all Lamia-specific settings.

| Setting | Description | Default |
|---|---|---|
| `lamia.cliPath` | Path to the `lamia` CLI executable | `"lamia"` (from PATH) |
| `lamia.chat.timeoutMs` | Timeout for chat responses in milliseconds | `300000` (5 min) |

## Chat Config

Lamia Studio maintains `~/.lamia/ide/config.yaml` for the chat panel's selected model. This file is auto-managed.

## File Locations Summary

| File | Purpose |
|---|---|
| `~/.lamia/.env` | API keys for LLM providers |
| `~/.lamia/ide/config.yaml` | Chat panel selected model (auto-managed) |
| `~/.lamia/ide/chats/<hash>/` | Saved chat history (per workspace) |
| `<project>/config.yaml` | Project-specific model and provider config |
