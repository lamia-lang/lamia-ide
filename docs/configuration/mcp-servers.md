# MCP Servers

Lamia IDE supports [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) servers, which extend the chat with additional tools. Any MCP-compatible server works out of the box.

## Quick Setup

1. Open VS Code Settings (`Cmd+,` / `Ctrl+,`)
2. Search for **"lamia mcp"**
3. Click **"Edit in settings.json"** under `lamia.mcp.servers`
4. Add your server config:

```json
{
  "lamia.mcp.servers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  }
}
```

5. Save -- servers start automatically

## Configuration Format

Each server entry needs a `command` and optional `args` and `env`:

```json
{
  "lamia.mcp.servers": {
    "<server-name>": {
      "command": "npx",
      "args": ["@package/name@latest", "--flag"],
      "env": {
        "API_KEY": "your-key"
      }
    }
  }
}
```

| Field | Required | Description |
|---|---|---|
| `command` | Yes | Executable to launch the server (`npx`, `node`, `python`, etc.) |
| `args` | No | Arguments passed to the command |
| `env` | No | Extra environment variables for the server process |

## Prerequisites

Most MCP servers require **Node.js 18+**. Check with `node --version` in your terminal.

## Example: Playwright MCP

Playwright MCP gives the chat 40+ browser automation tools -- forms, keyboard, dialogs, tabs, network inspection, JS execution, and more.

### Install

No separate install needed. Just add the config:

```json
{
  "lamia.mcp.servers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  }
}
```

### Headless mode (no visible browser)

```json
"args": ["@playwright/mcp@latest", "--headless"]
```

### Firefox instead of Chrome

```json
"args": ["@playwright/mcp@latest", "--browser", "firefox"]
```

## Multiple Servers

Add as many servers as you need:

```json
{
  "lamia.mcp.servers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    },
    "github": {
      "command": "npx",
      "args": ["@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..."
      }
    }
  }
}
```

## Lamia Web vs Playwright MCP

Lamia has built-in browser tools. Playwright MCP adds a separate, more feature-rich browser. Use Lamia's built-in tools first; fall back to Playwright when you need capabilities Lamia doesn't have.

### Lamia built-in (7 tools)

`browser_navigate`, `browser_click`, `browser_type`, `browser_get_text`, `browser_screenshot`, `browser_wait`, `get_accessibility_tree`

Strengths: session persistence, tight `.lm` script integration, no extra setup.

### Playwright MCP (40+ tools)

Everything Lamia has, plus: `browser_fill_form`, `browser_hover`, `browser_drag`, `browser_press_key`, `browser_evaluate`, `browser_handle_dialog`, `browser_select_option`, `browser_file_upload`, `browser_tabs`, `browser_navigate_back`, `browser_snapshot`, `browser_console_messages`, `browser_network_requests`, and more.

Strengths: richer tool set, accessibility-ref targeting, multi-browser, devtools.

### When to use which

| Scenario | Use |
|---|---|
| `.lm` script automation (Pinterest, cron jobs) | Lamia web |
| Complex forms, multi-step workflows | Playwright MCP |
| Debugging web apps (network, console, JS eval) | Playwright MCP |
| Simple page reading / navigation | Either |
| Login session reuse across runs | Lamia web |
| File uploads, dropdowns, keyboard shortcuts | Playwright MCP |

## Troubleshooting

**"MCP server failed to start"**
- Verify the command works: run `npx @playwright/mcp@latest` in your terminal
- Check Node.js version: `node --version` (need 18+)

**Tools not appearing in chat**
- Restart VS Code after changing MCP settings
- Ask the chat "What tools do you have?" to check

**Server crashes mid-session**
- MCP servers restart automatically on the next chat message
- Lamia's built-in tools are unaffected
