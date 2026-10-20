# Writing .lm Files

`.lm` files are Lamia's executable files — they use Lamia syntax and can augment it with Python syntax for the actions that are not supported by Lamia syntax.

## IDE Features for .lm Files

- **Syntax highlighting** — Python + Lamia extensions highlighted correctly
- **Go to definition** — `Ctrl+Click` / `Cmd+Click` on `.hu` file calls to jump to the template
- **Hover info** — hover over symbols for documentation
- **Code lens** — `Run` and `Debug` links appear above the file
- **Completions** — parameter names suggested when calling `.hu` files
- **Path completions** — inside a string that starts with `./`, `../`, `~/`, `/` or contains `/` (e.g. `clean("./input/crm/`), the entries of the typed directory are suggested; relative paths resolve against the `.lm` file

For the full Lamia language reference, see the [Lamia Language Docs](https://lamia-lang.github.io/lamia).
