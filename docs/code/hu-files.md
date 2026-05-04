# Writing .hu Files

`.hu` (Human) files are plain-text prompt templates. They define instructions for an LLM in natural language, with parameter placeholders for dynamic content.

## Syntax

A `.hu` file is plain text with single-brace parameter placeholders:

```
You are an expert code reviewer.

Review the following code for correctness, security, and performance issues.

Code to review:
{code}

Focus areas:
{focus_areas}
```

## Rules

- **Plain text only** — no markdown (no `**bold**`, `# headers`, `` `backticks` ``, or HTML)
- **Single braces** for parameters: `{param_name}` (double braces `{{text}}` become literal text with {text} value when sent to the LLM)
- **No output format descriptions** — Lamia enforces output schemas and .hu files should be return type agnostic to be reusable.
- **Keep them concise** — shorter prompts perform better

## Calling .hu Files

From a `.lm` file:

```python
result = review_code(code=source_text, focus_areas="security") -> JSON[ReviewResult]
```

This calls `review_code.hu`, substitutes the parameters, sends it to the LLM, and parses the response as `ReviewResult`.

## IDE Features for .hu Files

- **Syntax highlighting** — parameters `{name}` are highlighted distinctly
- **Go to definition** — `Ctrl+Click` / `Cmd+Click` on a `.hu` filename in `.lm` code jumps to the file
- **Hover info** — hover over a `.hu` call to see the template contents and parameters
- **Completions** — parameter names suggested when calling `.hu` files

## Navigation

To quickly navigate between `.lm` and `.hu` files:

1. In a `.lm` file, `Ctrl+Click` / `Cmd+Click` on any `.hu` call to jump to it
2. Use `Ctrl+Shift+O` / `Cmd+Shift+O` for document symbols — lists all functions and `.hu` calls
3. Use `Ctrl+P` / `Cmd+P` and type `.hu` to find prompt files by name

For the full `.hu` syntax reference, see the [Lamia Language Docs — .hu Syntax](https://lamia-lang.github.io/lamia).
