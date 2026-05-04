# Lamia Studio

Lamia Studio is a dedicated IDE for the [Lamia programming language](https://lamia-lang.github.io/lamia), built on top of VS Code. It provides syntax highlighting, code execution, debugging, and an AI-powered chat assistant for writing Lamia code.

## Features

- **Syntax highlighting** for `.lm` and `.hu` files
- **AI Chat** that understands Lamia syntax and can help with writing code with support for Anthropic, OpenAI, Ollama, and custom LLM adapters
- **One-click run** and **step-by-step debugging** for `.lm` files
- **Go to definition**, hover info, references, and completions for Lamia syntax elements and functions
- **Project model discovery** — models from your `config.yaml` files appear in the chat model selector

## Quick Start

1. Download and install Lamia Studio
2. Open IDE with "lamia ." from a project directory or by launching the "Lamia Studio"
2. Open the chat panel (`Cmd+Shift+L` / `Ctrl+Shift+L`)
3. Configure an API key (gear icon in chat header)
4. Start asking questions or writing Lamia code

## Navigation

- **[Installation](getting-started/installation.md)** — system requirements and setup
- **[Using Lamia Chat](chat/using-chat.md)** — the AI assistant built into the IDE
- **[API Keys & Models](chat/api-keys-and-models.md)** — configure providers and select models
- **[Writing .lm Files](code/lm-files.md)** — hybrid Python-Lamia scripts
- **[Writing .hu Files](code/hu-files.md)** — human-readable prompt templates
- **[Running Code](code/running.md)** — execute `.lm` files from the IDE
- **[Debugging](code/debugging.md)** — step through `.lm` files with breakpoints
- **[Project Configuration](configuration/project-config.md)** — `config.yaml` setup
- **[Custom Models](chat/custom-models.md)** — Ollama, custom adapters, and more
- **[Reporting Issues](troubleshooting/reporting-issues.md)** — how to file bugs with system info

## Lamia Language Documentation

For the Lamia language itself (syntax, web automation, validation, etc.), see the [Lamia Language Docs](https://lamia-lang.github.io/lamia).
