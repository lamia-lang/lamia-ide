# FAQ

## General

**Q: What is the difference between Lamia Studio and VS Code?**

Lamia Studio is a custom build of VS Code with the Lamia extension pre-installed and configured. It includes branding, default settings optimized for Lamia development, and the chat panel enabled by default.

**Q: Can I install the Lamia extension in regular VS Code?**

Yes. The extension can be packaged as a `.vsix` and installed in any VS Code instance:

1. Clone the repository: `git clone https://github.com/lamia-lang/lamia-ide.git`
2. Install dependencies: `cd lamia-ide/extension && npm install`
3. Compile: `npm run compile`
4. Package: `npx @vscode/vsce package --no-dependencies`
5. In VS Code, open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
6. Run **"Extensions: Install from VSIX..."** and select the generated `.vsix` file
7. Reload VS Code

You will also need Python 3.10+ and the Lamia runtime (`pip install lamia-lang`).

**Q: Where is the Lamia language documentation?**

The language docs are at [lamia-lang.github.io/lamia](https://lamia-lang.github.io/lamia). The IDE docs (this site) cover the editor features.

## Chat

**Q: Which LLM providers are supported?**

Built-in support for Anthropic and OpenAI. Ollama and custom adapters are supported via `config.yaml`. See [Custom Models](../chat/custom-models.md).

**Q: Are my API keys stored securely?**

Keys are stored in `~/.lamia/.env` as plain text. They are never leave your computer. Lamia does not have servers and does not collect any telemetry data.

**Q: Can I use the chat without an API key?**

Only if you have a local models configured. See [Custom Models](../chat/custom-models.md) for more information. You need API keys only for cloud providers.

**Q: Why does the model dropdown show a lock icon?**

The lock (🔒) means no API key is configured for that model's provider. Click the gear icon to add one.

**Q: Where are my chat conversations stored?**

In `~/.lamia/ide/chats/<workspace-hash>/`. Each chat is a JSON file. They persist across IDE restarts.

## Code

**Q: Can I run .hu files directly?**

No. `.hu` files are prompt templates — they are called from `.lm` files. Use Go to Definition to navigate from a `.lm` call to its `.hu` file.

**Q: How do I navigate from a .lm file to a .hu file?**

`Ctrl+Click` / `Cmd+Click` on the `.hu` file name in your `.lm` code. The definition provider resolves it automatically.

**Q: Does the debugger work with web automation?**

Yes. You can set breakpoints and step through `web.navigate()`, `web.click()`, etc. The browser operations execute at each step.

## Configuration

**Q: How do I reset everything?**

Delete `~/.lamia/` to remove all config, keys, and chat history. On next launch, Lamia Studio will recreate the defaults.
