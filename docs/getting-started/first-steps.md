# First Steps

After installing Lamia Studio, here is how to get productive quickly.

## 1. Open the Chat Panel

Press `Cmd+Shift+L` (macOS) or `Ctrl+Shift+L` (Windows/Linux) to open the Lamia Chat panel in the secondary sidebar.

## 2. Configure an API Key

The chat assistant requires an LLM provider. Click the gear icon (⚙) in the chat header bar and enter your API key for Anthropic or OpenAI.

## 3. Create a Lamia Project

Create a folder with a `config.yaml` file. It is recommended to start with something simple like this:

```yaml
model_chain:
  - name: "anthropic:claude-sonnet-4-20250514"
    max_retries: 2
```

Then create your first `.lm` file. Start with the help of the chat assistant. Describe what you want to do and the chat assistant will write the first version of the code.

## 4. Run Your Code

With a `.lm` file open, press `Cmd+Shift+R` (macOS) or `Ctrl+Shift+R` to run it. You can also click the play button (▶) in the editor title bar.

## 5. Ask the Chat for Fixes

Type a question in the chat panel. The assistant can help with syntax, web automation, validation, and more. It can also read and edit files in your project.

## Keyboard Shortcuts

| Action | macOS | Windows/Linux |
|---|---|---|
| Open Chat | `Cmd+Shift+L` | `Ctrl+Shift+L` |
| Run .lm File | `Cmd+Shift+R` | `Ctrl+Shift+R` |
| Debug .lm File | Click bug icon or use debug menu | Same |
| Copy with context | `Cmd+C` (in editor) | `Ctrl+C` |
