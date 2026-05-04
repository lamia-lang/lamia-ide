# Debugging .lm Files

Lamia Studio includes a full debugger for `.lm` files with breakpoints, step-by-step execution, and variable inspection.

## Starting a Debug Session

### From the Editor

1. Open a `.lm` file
2. Click the debug icon in the editor title bar or right-click the file in the explorer and select **Lamia: Debug Current File**
3. Or right-click the file in the explorer and select **Lamia: Debug Current File**

### From the Debug Panel

1. Open the Run and Debug panel (`Cmd+Shift+D` / `Ctrl+Shift+D`)
2. Select **Debug Lamia File** from the dropdown
3. Press the green play button

### From a Code Lens

A `Debug` link appears at the top of `.lm` files. Click it to start debugging.

## Setting Breakpoints

Click in the gutter (left margin) next to any line in a `.lm` file to set a breakpoint. A red dot appears. The debugger will pause execution at that line.

## Debug Controls

Once paused at a breakpoint, use the debug toolbar:

- **Continue** (F5) — resume execution until the next breakpoint
- **Step Over** (F10) — execute the current line and move to the next
- **Step Into** (F11) — step into a function call
- **Step Out** (Shift+F11) — run until the current function returns
- **Stop** (Shift+F5) — terminate the debug session

## Inspecting Variables

While paused:

- The **Variables** panel shows local and global variables
- Hover over variables in the editor to see their values
- Use the **Debug Console** to evaluate expressions

## Debug Configuration

The default configuration works for most cases. For custom setups, create a `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "lamia",
      "request": "launch",
      "name": "Debug Lamia File",
      "program": "${file}",
      "cwd": "${fileDirname}",
      "stopOnEntry": false
    }
  ]
}
```

### Options

| Option | Description | Default |
|---|---|---|
| `program` | Path to the `.lm` file | `${file}` (current file) |
| `cwd` | Working directory | `${fileDirname}` (file's folder) |
| `stopOnEntry` | Pause on the first line | `false` |
