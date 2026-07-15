// @ts-nocheck
/* eslint-disable */
// Lamia chat webview — runs inside the VS Code webview sandbox.
// Plain JavaScript: no bundler, no template-literal escaping issues.

const vscodeApi = acquireVsCodeApi();

let visibleModels = [];
let allModelsCatalog = [];
let configuredProviders = [];
let keyInfos = {};

function formatMeta(model, tokens) {
  let meta = "";
  if (model) meta += model;
  if (tokens) {
    meta += (meta ? " | " : "") + (tokens.input || 0).toLocaleString() + " in / " + (tokens.output || 0).toLocaleString() + " out tokens";
  }
  return meta;
}

// ── Setup / Settings ──────────────────────────────────────────────────────────

function updateNavState() {
  var inSettings = document.body.classList.contains("settings-mode");
  var inHistory = document.body.classList.contains("history-mode");
  var backBtn = document.getElementById("back-to-chat-btn");
  backBtn.style.display = (inSettings || inHistory) ? "" : "none";
  document.getElementById("settings-btn").classList.toggle("active", inSettings);
  document.getElementById("history-btn").classList.toggle("active", inHistory);
}

function openSetup() {
  const panel = document.getElementById("setup-panel");
  panel.classList.remove("hidden");
  document.body.classList.add("settings-mode");
  document.body.classList.remove("history-mode");
  document.getElementById("chat-history-panel").classList.add("hidden");
  updateNavState();
  updateSetupStatus();
  vscodeApi.postMessage({ type: "getMcpServers" });
}

function closeSetup() {
  const panel = document.getElementById("setup-panel");
  panel.classList.add("hidden");
  document.body.classList.remove("settings-mode");
  updateNavState();
}

function openHistory() {
  closeSetup();
  document.body.classList.add("history-mode");
  const panel = document.getElementById("chat-history-panel");
  panel.classList.remove("hidden");
  updateNavState();
  vscodeApi.postMessage({ type: "listChats" });
}

function closeHistory() {
  document.body.classList.remove("history-mode");
  document.getElementById("chat-history-panel").classList.add("hidden");
  updateNavState();
}

function toggleSetup() {
  const panel = document.getElementById("setup-panel");
  if (panel.classList.contains("hidden")) {
    openSetup();
  } else {
    closeSetup();
  }
}

function onProviderChange() {
  document.getElementById("setup-key").value = "";
  keyValidationStatus = {};
  updateSetupStatus();
}

var keyValidationStatus = {};

function updateSetupStatus() {
  var el = document.getElementById("setup-status");
  var lines = [];
  var providers = ["anthropic", "openai"];
  for (var pi = 0; pi < providers.length; pi++) {
    var p = providers[pi];
    var label = p.charAt(0).toUpperCase() + p.slice(1);
    if (!configuredProviders.includes(p)) continue;
    var info = keyInfos[p];
    var v = keyValidationStatus[p];
    var statusText = "";
    if (v === "valid") {
      statusText = '<span class="configured">' + label + ': valid</span>';
    } else if (v === "invalid") {
      statusText = '<span class="key-invalid">' + label + ': invalid key</span>';
    } else if (v === "checking") {
      statusText = '<span>' + label + ': checking...</span>';
    } else {
      statusText = '<span class="configured">' + label + ': configured</span>';
    }
    if (info) {
      statusText += ' <span style="opacity:0.5;font-size:10px">(' + info.masked + ' via ' + info.source + ')</span>';
    }
    lines.push(statusText);
  }
  if (lines.length === 0) {
    lines.push("No API keys configured yet. Enter a key below to get started.");
  }
  var currentProvider = document.getElementById("setup-provider").value;
  if (configuredProviders.includes(currentProvider)) {
    var hint = document.getElementById("setup-key");
    if (hint) hint.placeholder = "Enter new key to override";
  } else {
    var hint2 = document.getElementById("setup-key");
    if (hint2) hint2.placeholder = "sk-...";
  }
  el.innerHTML = lines.join("<br/>");
}

function saveApiKey() {
  var provider = document.getElementById("setup-provider").value;
  var key = document.getElementById("setup-key").value.trim();
  if (!key) return;
  keyValidationStatus[provider] = "checking";
  updateSetupStatus();
  vscodeApi.postMessage({ type: "saveApiKey", provider: provider, key: key });
  document.getElementById("setup-key").value = "";
}

// ── MCP servers UI ────────────────────────────────────────────────────────────

var mcpServers = [];
var mcpEditingName = null;
var mcpSaving = false;

function setMcpStatus(message, kind) {
  var el = document.getElementById("mcp-status");
  if (!el) return;
  el.textContent = message || "";
  el.classList.remove("error", "ok");
  if (kind === "error") el.classList.add("error");
  if (kind === "ok") el.classList.add("ok");
}

function setMcpSavingState(saving) {
  mcpSaving = saving;
  var saveBtn = document.getElementById("mcp-save-btn");
  var deleteBtn = document.getElementById("mcp-delete-btn");
  var addBtn = document.getElementById("mcp-add-btn");
  saveBtn.disabled = saving;
  if (saving) {
    saveBtn.textContent = "Starting...";
  } else {
    saveBtn.textContent = "Save";
  }
  deleteBtn.disabled = saving;
  addBtn.disabled = saving;
}

function renderMcpList() {
  var list = document.getElementById("mcp-list");
  list.innerHTML = "";
  if (mcpServers.length === 0) {
    list.innerHTML = '<div style="font-size:11px;opacity:0.5;padding:4px 0;">No MCP servers configured.</div>';
    return;
  }
  for (var i = 0; i < mcpServers.length; i++) {
    (function(srv) {
      var item = document.createElement("div");
      item.className = "mcp-item";

      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = srv.enabled;
      cb.title = srv.enabled ? "Disable" : "Enable";
      cb.addEventListener("change", function(e) {
        e.stopPropagation();
        vscodeApi.postMessage({ type: "toggleMcpServer", name: srv.name, enabled: cb.checked });
      });

      var nameSpan = document.createElement("span");
      nameSpan.className = "mcp-item-name";
      nameSpan.textContent = srv.name;

      var status = document.createElement("span");
      if (srv.connected) {
        status.className = "mcp-item-status running";
        status.textContent = "running (" + srv.toolCount + " tool" + (srv.toolCount !== 1 ? "s" : "") + ")";
      } else if (!srv.enabled) {
        status.className = "mcp-item-status";
        status.textContent = "disabled";
      } else if (srv.lastError) {
        status.className = "mcp-item-status failed";
        status.textContent = "failed";
        status.title = srv.lastError;
      } else {
        status.className = "mcp-item-status";
        status.textContent = "stopped";
      }

      item.appendChild(cb);
      item.appendChild(nameSpan);
      item.appendChild(status);

      var wrapper = document.createElement("div");

      item.addEventListener("click", function() {
        if (mcpSaving) return;
        mcpEditingName = srv.name;
        document.getElementById("mcp-name").value = srv.name;
        document.getElementById("mcp-name").disabled = false;
        var cfg = Object.assign({}, srv.config);
        delete cfg.enabled;
        populateMcpEditor(cfg);
        document.getElementById("mcp-editor").classList.remove("hidden");
        document.getElementById("mcp-delete-btn").classList.remove("hidden");
        var saveBtn = document.getElementById("mcp-save-btn");
        saveBtn.textContent = (srv.enabled && !srv.connected) ? "Retry" : "Save";
        setMcpStatus("");
      });

      wrapper.appendChild(item);

      if (srv.connected && srv.toolNames && srv.toolNames.length > 0) {
        var toolsDiv = document.createElement("div");
        toolsDiv.className = "mcp-tools-list";
        toolsDiv.textContent = srv.toolNames.join(", ");
        wrapper.appendChild(toolsDiv);
      }

      list.appendChild(wrapper);
    })(mcpServers[i]);
  }
}

function populateMcpEditor(cfg) {
  var commandField = document.getElementById("mcp-command");
  var envField = document.getElementById("mcp-env");
  var envRow = document.getElementById("mcp-env-row");
  var jsonRow = document.getElementById("mcp-json-row");
  var configField = document.getElementById("mcp-config");
  var toggle = document.getElementById("mcp-advanced-toggle");

  configField.value = JSON.stringify(cfg, null, 2);

  if (cfg.url) {
    commandField.value = "";
    envRow.classList.add("hidden");
    jsonRow.classList.remove("hidden");
    toggle.textContent = "Hide advanced (JSON)";
  } else {
    var parts = [cfg.command || ""];
    if (cfg.args) parts = parts.concat(cfg.args);
    commandField.value = parts.join(" ");
    if (cfg.env && Object.keys(cfg.env).length > 0) {
      envRow.classList.remove("hidden");
      envField.value = Object.entries(cfg.env).map(function(e) { return e[0] + "=" + e[1]; }).join("\n");
    } else {
      envRow.classList.add("hidden");
      envField.value = "";
    }
    jsonRow.classList.add("hidden");
    toggle.textContent = "Show advanced (JSON)";
  }
}

function showMcpAddForm() {
  if (mcpSaving) return;
  mcpEditingName = null;
  document.getElementById("mcp-name").value = "";
  document.getElementById("mcp-name").disabled = false;
  document.getElementById("mcp-command").value = "npx @playwright/mcp@latest";
  document.getElementById("mcp-env").value = "";
  document.getElementById("mcp-env-row").classList.add("hidden");
  document.getElementById("mcp-json-row").classList.add("hidden");
  document.getElementById("mcp-advanced-toggle").textContent = "Show advanced (JSON)";
  document.getElementById("mcp-config").value = "";
  document.getElementById("mcp-editor").classList.remove("hidden");
  document.getElementById("mcp-delete-btn").classList.add("hidden");
  document.getElementById("mcp-save-btn").textContent = "Save";
  setMcpStatus("");
}

function buildConfigFromFields() {
  var jsonRow = document.getElementById("mcp-json-row");
  if (!jsonRow.classList.contains("hidden")) {
    return document.getElementById("mcp-config").value.trim();
  }
  var cmdText = document.getElementById("mcp-command").value.trim();
  if (!cmdText) return "";
  var parts = cmdText.split(/\s+/);
  var config = { command: parts[0] };
  if (parts.length > 1) config.args = parts.slice(1);
  var envText = document.getElementById("mcp-env").value.trim();
  if (envText) {
    config.env = {};
    envText.split(/\r?\n/).forEach(function(line) {
      var eq = line.indexOf("=");
      if (eq > 0) config.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    });
  }
  return JSON.stringify(config);
}

function saveMcpServer() {
  if (mcpSaving) return;
  var name = document.getElementById("mcp-name").value.trim();
  var configText = buildConfigFromFields();
  if (!name) {
    setMcpStatus("Server name is required.", "error");
    return;
  }
  if (!configText) {
    setMcpStatus("Configuration JSON is required.", "error");
    return;
  }
  try {
    var newCfg = JSON.parse(configText);
    var newCmd = (newCfg.command || "") + " " + (newCfg.args || []).join(" ");
    var duplicate = mcpServers.find(function(s) {
      if (s.name === mcpEditingName) return false;
      var existCmd = (s.config.command || "") + " " + ((s.config.args || []).join ? s.config.args.join(" ") : "");
      return existCmd.trim() === newCmd.trim() && newCmd.trim();
    });
    if (duplicate) {
      setMcpStatus('Server "' + duplicate.name + '" already uses the same command.', "error");
      return;
    }
  } catch(ex) {}
  setMcpSavingState(true);
  setMcpStatus("Saving config...", "");
  vscodeApi.postMessage({ type: "saveMcpServer", name: name, oldName: mcpEditingName || undefined, config: configText });
}

function deleteCurrentMcpServer() {
  if (mcpSaving || !mcpEditingName) return;
  setMcpSavingState(true);
  setMcpStatus("Removing MCP server...", "");
  vscodeApi.postMessage({ type: "deleteMcpServer", name: mcpEditingName });
}

// ── Model dropdown ────────────────────────────────────────────────────────────

function populateModels(serverSelectedModel) {
  const sel = document.getElementById("model-select");
  const prev = serverSelectedModel || sel.value || (vscodeApi.getState() || {}).selectedModel || "";
  sel.innerHTML = "";

  let hasOptions = false;
  for (const m of visibleModels) {
    const opt = document.createElement("option");
    opt.value = m.value;
    opt.textContent = m.label;
    if (m.disabled) opt.disabled = true;
    if (opt.value === prev) opt.selected = true;
    sel.appendChild(opt);
    if (!opt.disabled) hasOptions = true;
  }

  if (!hasOptions) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "-- set an API key first --";
    opt.disabled = true;
    sel.appendChild(opt);
  }

  if (allModelsCatalog.length > visibleModels.length) {
    const sep = document.createElement("option");
    sep.value = "__separator__";
    sep.textContent = "────────────────";
    sep.disabled = true;
    sel.appendChild(sep);

    const addOpt = document.createElement("option");
    addOpt.value = "__add_models__";
    addOpt.textContent = "Add Models…";
    sel.appendChild(addOpt);
  }
}

function openAddModelsDialog() {
  const overlay = document.getElementById("add-models-overlay");
  const list = document.getElementById("add-models-list");
  list.innerHTML = "";

  const currentModel = document.getElementById("model-select").value;

  for (const m of allModelsCatalog) {
    if (m.disabled) continue;
    const row = document.createElement("div");
    row.className = "add-model-row";
    if (m.value === currentModel) row.classList.add("selected");
    row.textContent = m.label;
    row.addEventListener("click", function () {
      selectModelFromDialog(m.value);
    });
    list.appendChild(row);
  }

  overlay.classList.remove("hidden");
}

function selectModelFromDialog(modelValue) {
  closeAddModelsDialog();
  const sel = document.getElementById("model-select");
  let found = false;
  for (const opt of sel.options) {
    if (opt.value === modelValue) {
      found = true;
      break;
    }
  }
  if (!found) {
    const matchingModel = allModelsCatalog.find(function (m) { return m.value === modelValue; });
    if (matchingModel) {
      const sep = sel.querySelector('option[value="__separator__"]');
      const newOpt = document.createElement("option");
      newOpt.value = matchingModel.value;
      newOpt.textContent = matchingModel.label;
      if (sep) {
        sel.insertBefore(newOpt, sep);
      } else {
        sel.appendChild(newOpt);
      }
    }
  }
  sel.value = modelValue;
  onModelChange();
}

function closeAddModelsDialog() {
  document.getElementById("add-models-overlay").classList.add("hidden");
}

// ── Messages ──────────────────────────────────────────────────────────────────

let thinkingEl = null;

function hideEmptyState() {
  const es = document.getElementById("empty-state");
  if (es) es.remove();
}

function appendMessage(role, text, meta) {
  hideEmptyState();
  removeThinking();

  const container = document.getElementById("chat-messages");
  const wrapper = document.createElement("div");
  wrapper.className = "message " + role;

  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = role === "user" ? "You" : role === "error" ? "Error" : "Assistant";
  wrapper.appendChild(label);

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.textContent = text;
  if (role === "assistant" && text.length > 3500) {
    bubble.classList.add("compact-more");
  } else if (role === "assistant" && text.length > 1800) {
    bubble.classList.add("compact");
  }
  wrapper.appendChild(bubble);

  if (meta) {
    const metaEl = document.createElement("div");
    metaEl.className = "message-meta";
    metaEl.textContent = meta;
    wrapper.appendChild(metaEl);
  }

  container.appendChild(wrapper);
  container.scrollTop = container.scrollHeight;
  return wrapper;
}

var isGenerating = false;

function setGenerating(on) {
  isGenerating = on;
  document.getElementById("send-btn").style.display = on ? "none" : "";
  document.getElementById("stop-btn").style.display = on ? "inline-block" : "none";
}

function showThinking() {
  hideEmptyState();
  removeThinking();
  const container = document.getElementById("chat-messages");
  thinkingEl = document.createElement("div");
  thinkingEl.className = "thinking";
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement("span");
    dot.className = "thinking-dot";
    thinkingEl.appendChild(dot);
  }
  container.appendChild(thinkingEl);
  container.scrollTop = container.scrollHeight;
  setGenerating(true);
}

function removeThinking() {
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
}

function clearMessages() {
  const container = document.getElementById("chat-messages");
  container.innerHTML = '<div id="empty-state"><div class="icon">&#128172;</div><p>Ask anything. Lamia syntax help is automatic<br>when your question is about Lamia.</p></div>';
}

function restoreMessages(messages) {
  if (!messages || messages.length === 0) return;
  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.turnContext) {
      const meta = formatMeta(msg.model, msg.tokens);
      const el = appendMessage(msg.role, msg.text, meta || undefined);
      if (msg.role === "assistant" && el) renderCodeBlocks(el.querySelector(".message-bubble"));
      continue;
    }
    var tc = msg.turnContext;
    var items = [];
    if (Array.isArray(tc.toolCalls)) {
      tc.toolCalls.forEach(function(t) {
        items.push({ kind: "tool", data: t, ts: t.ts || 0 });
      });
    }
    items.push({ kind: "response", data: msg, ts: tc.responseTs || msg.ts || 0 });
    if (Array.isArray(tc.fileWrites)) {
      tc.fileWrites.forEach(function(f) {
        items.push({ kind: "file", data: f, ts: f.ts || 0 });
      });
    }
    items.sort(function(a, b) { return a.ts - b.ts; });
    var toolBatch = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.kind === "tool") {
        toolBatch.push(it.data);
      } else {
        if (toolBatch.length > 0) {
          renderCompletedToolCalls(toolBatch);
          toolBatch = [];
        }
        if (it.kind === "response") {
          var meta = formatMeta(msg.model, msg.tokens);
          var el = appendMessage(msg.role, msg.text, meta || undefined);
          if (el) renderCodeBlocks(el.querySelector(".message-bubble"));
        } else if (it.kind === "file") {
          renderFileChanges([it.data]);
        }
      }
    }
    if (toolBatch.length > 0) {
      renderCompletedToolCalls(toolBatch);
    }
  }
}

// ── Tool progress ─────────────────────────────────────────────────────────────

let toolProgressEl = null;

function escapeHtml(s) {
  const text = String(s ?? "");
  return text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function addToolProgress(label) {
  hideEmptyState();
  removeThinking();

  const container = document.getElementById("chat-messages");

  if (!toolProgressEl) {
    toolProgressEl = document.createElement("div");
    toolProgressEl.className = "tool-progress";
    container.appendChild(toolProgressEl);
  }

  toolProgressEl.querySelectorAll(".ts-spinner").forEach(function(s) {
    var icon = document.createElement("span");
    icon.className = "ts-check";
    icon.textContent = "✓";
    s.replaceWith(icon);
  });

  const step = document.createElement("div");
  step.className = "tool-step";
  step.innerHTML = '<span class="ts-spinner"></span><span class="ts-label">' + escapeHtml(label) + '</span>';
  toolProgressEl.appendChild(step);
  container.scrollTop = container.scrollHeight;
}

function markLastToolResult(success, error) {
  if (!toolProgressEl) return;
  var spinners = toolProgressEl.querySelectorAll(".ts-spinner");
  if (spinners.length === 0) return;
  var last = spinners[spinners.length - 1];
  var icon = document.createElement("span");
  icon.className = success ? "ts-check" : "ts-fail";
  icon.textContent = success ? "✓" : "✗";
  last.replaceWith(icon);
  if (!success && error) {
    var step = icon.closest(".tool-step");
    if (step) {
      var errEl = document.createElement("span");
      errEl.className = "ts-error-detail";
      errEl.textContent = "Error: " + error;
      step.appendChild(errEl);
    }
  }
}

function completeToolProgress() {
  if (!toolProgressEl) return;
  toolProgressEl.querySelectorAll(".ts-spinner").forEach(function(s) {
    var icon = document.createElement("span");
    icon.className = "ts-check";
    icon.textContent = "✓";
    s.replaceWith(icon);
  });
  toolProgressEl = null;
}

function renderCompletedToolCalls(toolCalls) {
  const container = document.getElementById("chat-messages");
  const wrapper = document.createElement("div");
  wrapper.className = "tool-progress";
  toolCalls.forEach(function(t) {
    const step = document.createElement("div");
    step.className = "tool-step";
    const label = t && t.label ? t.label : (t && t.tool ? "Using tool: " + t.tool : "Using tool");
    var ok = t.success !== false;
    var cls = ok ? "ts-check" : "ts-fail";
    var sym = ok ? "✓" : "✗";
    step.innerHTML = '<span class="' + cls + '">' + sym + '</span><span class="ts-label">' + escapeHtml(label) + '</span>';
    if (!ok && t.error) {
      var errEl = document.createElement("span");
      errEl.className = "ts-error-detail";
      errEl.textContent = "Error: " + t.error;
      step.appendChild(errEl);
    }
    wrapper.appendChild(step);
  });
  container.appendChild(wrapper);
  container.scrollTop = container.scrollHeight;
}

// ── File changes ──────────────────────────────────────────────────────────────

function renderFileChanges(files) {
  const container = document.getElementById("chat-messages");
  const wrapper = document.createElement("div");
  wrapper.className = "file-changes";

  files.forEach(function(f) {
    var basename = f.path.split("/").pop() || f.path;
    var item = document.createElement("div");
    item.className = "file-change-item";

    var icon = document.createElement("span");
    icon.className = "fc-icon " + f.action;
    icon.textContent = f.action === "create" ? "+" : f.action === "delete" ? "−" : "✎";
    item.appendChild(icon);

    var label = f.action === "create" ? "Created: " : f.action === "delete" ? "Deleted: " : "Modified: ";
    var name = document.createElement("span");
    name.className = "fc-name";
    name.title = f.path;
    name.textContent = label + basename;
    item.appendChild(name);

    if (f.action === "modify" && f.original != null) {
      var diffBtn = document.createElement("button");
      diffBtn.className = "fc-btn";
      diffBtn.textContent = "View Diff";
      diffBtn.addEventListener("click", function() {
        vscodeApi.postMessage({ type: "openDiff", path: f.path, original: f.original });
      });
      item.appendChild(diffBtn);
    }

    if (f.action !== "delete") {
      var openBtn = document.createElement("button");
      openBtn.className = "fc-btn";
      openBtn.textContent = "Open";
      openBtn.addEventListener("click", function() {
        vscodeApi.postMessage({ type: "openFile", path: f.path });
      });
      item.appendChild(openBtn);
    }

    wrapper.appendChild(item);
  });

  container.appendChild(wrapper);
  container.scrollTop = container.scrollHeight;
}

// ── Send ──────────────────────────────────────────────────────────────────────

function sendMessage() {
  const input = document.getElementById("user-input");
  const text = input.value.trim();
  if (!text) return;

  const model = document.getElementById("model-select").value;
  if (!model) {
    appendMessage("error", "No model selected. Click the gear icon to configure an API key first.", undefined);
    return;
  }

  appendMessage("user", text, undefined);
  const filePaths = attachedFiles.map(f => f.absolutePath);
  const snippets = attachedSnippets.slice();
  attachedFiles = [];
  attachedSnippets = [];
  renderFileChips();
  input.value = "";
  input.style.height = "";
  document.getElementById("send-btn").disabled = true;
  vscodeApi.postMessage({
    type: "send",
    message: text,
    model,
    files: filePaths.length > 0 ? filePaths : undefined,
    snippets: snippets.length > 0 ? snippets : undefined,
  });
}

// ── State ─────────────────────────────────────────────────────────────────────

function onModelChange() {
  const sel = document.getElementById("model-select");
  const model = sel?.value;
  if (model === "__separator__") return;
  if (model === "__add_models__") {
    const state = vscodeApi.getState() || {};
    sel.value = state.selectedModel || "";
    openAddModelsDialog();
    return;
  }
  if (model) {
    vscodeApi.postMessage({ type: "changeModel", model });
    vscodeApi.setState({ selectedModel: model });
  }
}

// ── File chips (attached files) ───────────────────────────────────────────────

let attachedFiles = [];
let attachedSnippets = [];

function addFileChip(file) {
  if (attachedFiles.some(f => f.absolutePath === file.absolutePath)) return;
  attachedFiles.push(file);
  renderFileChips();
}

function removeFileChip(idx) {
  attachedFiles.splice(idx, 1);
  renderFileChips();
}

function addSnippetChip(snippet) {
  attachedSnippets.push(snippet);
  renderFileChips();
}

function removeSnippetChip(idx) {
  attachedSnippets.splice(idx, 1);
  renderFileChips();
}

function renderFileChips() {
  const container = document.getElementById("file-chips");
  container.innerHTML = "";
  attachedFiles.forEach((f, i) => {
    const chip = document.createElement("span");
    chip.className = "file-chip";
    chip.textContent = f.name;
    const rm = document.createElement("span");
    rm.className = "remove";
    rm.textContent = "×";
    rm.addEventListener("click", () => removeFileChip(i));
    chip.appendChild(rm);
    container.appendChild(chip);
  });
  attachedSnippets.forEach((s, i) => {
    const chip = document.createElement("span");
    chip.className = "snippet-chip";
    const lines = s.startLine === s.endLine ? ":" + s.startLine : ":" + s.startLine + "-" + s.endLine;
    chip.textContent = s.fileName + lines;
    const rm = document.createElement("span");
    rm.className = "remove";
    rm.textContent = "×";
    rm.addEventListener("click", () => removeSnippetChip(i));
    chip.appendChild(rm);
    container.appendChild(chip);
  });
}

// ── @-mention popup ───────────────────────────────────────────────────────────

let mentionFiles = [];
let mentionIdx = 0;
let mentionStart = -1;

function showMentionPopup(files) {
  mentionFiles = files;
  mentionIdx = 0;
  const popup = document.getElementById("mention-popup");
  popup.innerHTML = "";
  files.forEach((f, i) => {
    const item = document.createElement("div");
    item.className = "mention-item" + (i === 0 ? " active" : "");
    item.innerHTML = '<span>' + f.name + '</span><span class="path">' + f.relativePath + '</span>';
    item.addEventListener("click", () => selectMention(f));
    popup.appendChild(item);
  });
  popup.classList.remove("hidden");
}

function hideMentionPopup() {
  document.getElementById("mention-popup").classList.add("hidden");
  mentionFiles = [];
  mentionStart = -1;
}

function selectMention(file) {
  addFileChip(file);
  const input = document.getElementById("user-input");
  const val = input.value;
  input.value = val.slice(0, mentionStart) + val.slice(input.selectionStart);
  hideMentionPopup();
  input.focus();
}

// ── Code block rendering ──────────────────────────────────────────────────────

function renderCodeBlocks(el) {
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  const html = el.innerHTML;
  el.innerHTML = html.replace(codeBlockRegex, function(match, lang, code) {
    var badgeHtml = '';
    if (lang) {
      var label = lang === 'lamia' ? 'lamia (.lm)' : lang === 'hu' ? 'lamia (.hu)' : lang;
      badgeHtml = '<span class="code-lang-badge">' + label + '</span>';
    }
    return '<div class="code-block-wrapper">' +
      badgeHtml +
      '<div class="code-actions">' +
      '<button class="copy-btn" data-code="' + code.replace(/"/g, '&quot;') + '">Copy</button>' +
      '<button class="insert-btn" data-code="' + code.replace(/"/g, '&quot;') + '">Insert</button>' +
      '</div>' +
      '<pre><code>' + code.replace(/</g, '&lt;') + '</code></pre></div>';
  });
  el.querySelectorAll(".copy-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      navigator.clipboard.writeText(btn.dataset.code);
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = "Copy"; }, 1500);
    });
  });
  el.querySelectorAll(".insert-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      vscodeApi.postMessage({ type: "insertSnippet", code: btn.dataset.code });
    });
  });
}

// ── Chat history ──────────────────────────────────────────────────────────────

function toggleHistory() {
  const panel = document.getElementById("chat-history-panel");
  if (panel.classList.contains("hidden")) {
    openHistory();
  } else {
    closeHistory();
  }
}

function renderChatList(chats, currentId) {
  const panel = document.getElementById("chat-history-panel");
  panel.innerHTML = "";
  if (chats.length === 0) {
    panel.innerHTML = '<div style="padding:10px;font-size:12px;opacity:0.5">No saved chats</div>';
    return;
  }
  for (var i = 0; i < chats.length; i++) {
    (function(chat) {
      var item = document.createElement("div");
      item.className = "chat-item" + (chat.id === currentId ? " active" : "");

      var title = document.createElement("span");
      title.className = "chat-item-title";
      title.textContent = chat.title;

      var date = document.createElement("span");
      date.className = "chat-item-date";
      var d = new Date(chat.updated);
      date.textContent = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });

      var del = document.createElement("button");
      del.className = "chat-item-delete";
      del.textContent = "×";
      del.title = "Delete chat";
      del.addEventListener("click", function(e) {
        e.stopPropagation();
        vscodeApi.postMessage({ type: "deleteChat", id: chat.id });
      });

      item.appendChild(title);
      item.appendChild(date);
      item.appendChild(del);
      item.addEventListener("click", function() {
        document.getElementById("chat-history-panel").classList.add("hidden");
        vscodeApi.postMessage({ type: "loadChat", id: chat.id });
      });
      panel.appendChild(item);
    })(chats[i]);
  }
}

// ── Event wiring ──────────────────────────────────────────────────────────────

document.getElementById("back-to-chat-btn").addEventListener("click", function() {
  closeHistory();
  closeSetup();
});
document.getElementById("new-chat-btn").addEventListener("click", function() {
  closeHistory();
  closeSetup();
  vscodeApi.postMessage({ type: "newChat" });
});
document.getElementById("close-models-btn").addEventListener("click", closeAddModelsDialog);
document.getElementById("add-models-overlay").addEventListener("click", function(e) {
  if (e.target === this) closeAddModelsDialog();
});
document.getElementById("history-btn").addEventListener("click", toggleHistory);
document.getElementById("settings-btn").addEventListener("click", toggleSetup);
document.getElementById("model-select").addEventListener("change", onModelChange);
document.getElementById("setup-provider").addEventListener("change", onProviderChange);
document.getElementById("save-key-btn").addEventListener("click", saveApiKey);
document.getElementById("mcp-add-btn").addEventListener("click", showMcpAddForm);
document.getElementById("mcp-save-btn").addEventListener("click", saveMcpServer);
document.getElementById("mcp-delete-btn").addEventListener("click", deleteCurrentMcpServer);
document.getElementById("mcp-advanced-toggle").addEventListener("click", function(e) {
  e.preventDefault();
  var jsonRow = document.getElementById("mcp-json-row");
  var envRow = document.getElementById("mcp-env-row");
  if (jsonRow.classList.contains("hidden")) {
    var configText = buildConfigFromFields();
    if (configText) {
      try { document.getElementById("mcp-config").value = JSON.stringify(JSON.parse(configText), null, 2); }
      catch(ex) { document.getElementById("mcp-config").value = configText; }
    }
    jsonRow.classList.remove("hidden");
    envRow.style.display = "none";
    this.textContent = "Hide advanced (JSON)";
  } else {
    jsonRow.classList.add("hidden");
    envRow.style.display = "";
    try {
      var cfg = JSON.parse(document.getElementById("mcp-config").value);
      var parts = [cfg.command || ""];
      if (cfg.args) parts = parts.concat(cfg.args);
      document.getElementById("mcp-command").value = parts.join(" ");
      if (cfg.env && Object.keys(cfg.env).length > 0) {
        envRow.classList.remove("hidden");
        document.getElementById("mcp-env").value = Object.entries(cfg.env).map(function(e) { return e[0] + "=" + e[1]; }).join("\n");
      }
    } catch(ex) {}
    this.textContent = "Show advanced (JSON)";
  }
});
document.getElementById("mcp-docs-link").addEventListener("click", function(e) {
  e.preventDefault();
  vscodeApi.postMessage({ type: "openExternal", url: "https://lamia-lang.github.io/lamia-ide/configuration/mcp-servers/" });
});
document.getElementById("send-btn").addEventListener("click", sendMessage);
document.getElementById("stop-btn").addEventListener("click", function() {
  completeToolProgress();
  removeThinking();
  setGenerating(false);
  document.getElementById("send-btn").disabled = false;
  vscodeApi.postMessage({ type: "stop" });
});

const userInput = document.getElementById("user-input");

userInput.addEventListener("keydown", function(e) {
  if (mentionFiles.length > 0) {
    if (e.key === "ArrowDown") { e.preventDefault(); mentionIdx = Math.min(mentionIdx + 1, mentionFiles.length - 1); updateMentionActive(); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); mentionIdx = Math.max(mentionIdx - 1, 0); updateMentionActive(); return; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); selectMention(mentionFiles[mentionIdx]); return; }
    if (e.key === "Escape") { hideMentionPopup(); return; }
  }
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

function updateMentionActive() {
  const items = document.getElementById("mention-popup").querySelectorAll(".mention-item");
  items.forEach((it, i) => it.classList.toggle("active", i === mentionIdx));
}

userInput.addEventListener("input", function() {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 140) + "px";

  const val = this.value;
  const cursor = this.selectionStart;
  const before = val.slice(0, cursor);
  const atIdx = before.lastIndexOf("@");

  if (atIdx >= 0 && (atIdx === 0 || before[atIdx - 1] === " " || before[atIdx - 1] === "\n")) {
    const query = before.slice(atIdx + 1);
    if (query.length <= 40 && !query.includes(" ")) {
      mentionStart = atIdx;
      vscodeApi.postMessage({ type: "getFiles", query });
      return;
    }
  }
  hideMentionPopup();
});

userInput.addEventListener("paste", function() {
  vscodeApi.postMessage({ type: "getClipboardContext" });
});

// ── Drag and drop ─────────────────────────────────────────────────────────────

const inputArea = document.getElementById("input-area");
function onDragOver(e) {
  e.preventDefault();
  inputArea.style.outline = "2px dashed var(--vscode-focusBorder)";
}
function onDragLeave() {
  inputArea.style.outline = "";
}
function handleDrop(e) {
  e.preventDefault();
  inputArea.style.outline = "";

  // 1) VSCode/Electron file drop from explorer/editor
  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    for (var i = 0; i < e.dataTransfer.files.length; i++) {
      var filePath = e.dataTransfer.files[i].path;
      if (filePath) {
        vscodeApi.postMessage({ type: "dropFile", uri: filePath });
      }
    }
    return;
  }

  // 2) VSCode explorer custom payload
  var explorerPayload = e.dataTransfer.getData("application/vnd.code.tree.explorer");
  if (explorerPayload) {
    try {
      var parsed = JSON.parse(explorerPayload);
      var items = Array.isArray(parsed) ? parsed : [parsed];
      items.forEach(function(it) {
        if (it && typeof it.resourceUri === "string") {
          vscodeApi.postMessage({ type: "dropFile", uri: it.resourceUri });
        }
      });
      return;
    } catch {
      // ignore and continue with other mime types
    }
  }

  // 3) Generic URI list
  var uriList = e.dataTransfer.getData("text/uri-list");
  if (uriList) {
    uriList.split("\n").forEach(function(uri) {
      uri = uri.trim();
      if (uri && !uri.startsWith("#")) {
        vscodeApi.postMessage({ type: "dropFile", uri: uri });
      }
    });
    return;
  }

  // 4) Plain path fallback
  var plain = e.dataTransfer.getData("text/plain");
  if (plain) {
    plain.split("\n").forEach(function(line) {
      line = line.trim();
      if (line) {
        vscodeApi.postMessage({ type: "dropFile", uri: line });
      }
    });
  }
}

inputArea.addEventListener("dragover", onDragOver);
inputArea.addEventListener("dragleave", onDragLeave);
inputArea.addEventListener("drop", handleDrop);
userInput.addEventListener("dragover", onDragOver);
userInput.addEventListener("dragleave", onDragLeave);
userInput.addEventListener("drop", handleDrop);

// ── Message listener ──────────────────────────────────────────────────────────

window.addEventListener("message", event => {
  try {
    const msg = event.data;
    switch (msg.type) {
    case "init":
      visibleModels = msg.models || [];
      allModelsCatalog = msg.allModels || msg.models || [];
      configuredProviders = msg.configuredProviders;
      keyInfos = msg.keyInfos || {};
      populateModels(msg.selectedModel);
      updateSetupStatus();
      clearMessages();
      restoreMessages(msg.messages);
      vscodeApi.postMessage({ type: "getMcpServers" });
      {
        const banner = document.getElementById("free-tier-banner");
        if (banner) banner.classList.toggle("hidden", !msg.freeTier);
      }
      closeHistory();
      closeSetup();
      break;
    case "updateModels":
      visibleModels = msg.models || [];
      allModelsCatalog = msg.allModels || msg.models || [];
      configuredProviders = msg.configuredProviders;
      keyInfos = msg.keyInfos || {};
      populateModels(null);
      updateSetupStatus();
      break;
    case "mcpServers":
      mcpServers = msg.servers || [];
      renderMcpList();
      var failedServers = mcpServers.filter(function(s) { return s.enabled && !s.connected; });
      if (failedServers.length > 0) {
        var names = failedServers.map(function(s) { return s.name; }).join(", ");
        setMcpStatus(names + " failed to start. Click the server name to check its config. Saving the config will restart it.", "error");
      }
      break;
    case "mcpActionResult":
      setMcpStatus(msg.message || (msg.ok ? "Done." : "Failed."), msg.ok ? "ok" : "error");
      if (msg.final) {
        setMcpSavingState(false);
        if (msg.ok) {
          document.getElementById("mcp-editor").classList.add("hidden");
          document.getElementById("mcp-delete-btn").classList.add("hidden");
          mcpEditingName = null;
        }
      }
      break;
    case "apiKeyValidation":
      keyValidationStatus[msg.provider] = msg.valid ? "valid" : "invalid";
      updateSetupStatus();
      break;
    case "toolProgress":
      addToolProgress(msg.label);
      break;
    case "toolResult":
      markLastToolResult(msg.success, msg.error);
      if (isGenerating) showThinking();
      break;
    case "fileChanges":
      renderFileChanges(msg.files);
      break;
    case "response": {
      completeToolProgress();
      removeThinking();
      setGenerating(false);
      const meta = formatMeta(msg.model, msg.tokens);
      const el = appendMessage("assistant", msg.text, meta || undefined);
      if (el) renderCodeBlocks(el.querySelector(".message-bubble"));
      document.getElementById("send-btn").disabled = false;
      break;
    }
    case "error": {
      completeToolProgress();
      removeThinking();
      setGenerating(false);
      var eType = msg.errorType || "provider";
      const errEl = appendMessage("error", msg.text, undefined);
      if (errEl) {
        errEl.classList.add("error-" + eType);
        var bubble = errEl.querySelector(".message-bubble");
        if (eType === "auth" || eType === "rate_limit") {
          var keyBtn = document.createElement("button");
          keyBtn.className = "error-action-btn";
          keyBtn.textContent = eType === "rate_limit" ? "Switch provider" : "Update API Key";
          keyBtn.addEventListener("click", function() {
            if (eType === "rate_limit") {
              openAddModelsDialog();
              return;
            }
            var settingsBtn = document.getElementById("settings-btn");
            if (settingsBtn) settingsBtn.click();
          });
          bubble.appendChild(keyBtn);
        }
        if (eType !== "auth" && eType !== "quota" && eType !== "rate_limit") {
          var retryBtn = document.createElement("button");
          retryBtn.className = "error-action-btn";
          retryBtn.textContent = "Retry";
          retryBtn.addEventListener("click", function() {
            vscodeApi.postMessage({ type: "retry" });
          });
          bubble.appendChild(retryBtn);
        }
      }
      document.getElementById("send-btn").disabled = false;
      break;
    }
    case "populateInput": {
      var inp = document.getElementById("user-input");
      inp.value = msg.text;
      inp.style.height = "auto";
      inp.style.height = Math.min(inp.scrollHeight, 140) + "px";
      inp.focus();
      break;
    }
    case "stopped": {
      completeToolProgress();
      removeThinking();
      setGenerating(false);
      document.getElementById("send-btn").disabled = false;
      break;
    }
    case "thinking":
      if (msg.active) showThinking();
      else { removeThinking(); setGenerating(false); }
      break;
    case "fileList":
      if (msg.files.length > 0) showMentionPopup(msg.files);
      else hideMentionPopup();
      break;
    case "clipboardContext":
      if (msg.snippet) addSnippetChip(msg.snippet);
      break;
    case "chatList":
      renderChatList(msg.chats, msg.currentId);
      break;
    case "addFile":
      addFileChip(msg.file);
      break;
    }
  } catch (err) {
    console.error("Lamia chat webview message handler failed:", err);
    completeToolProgress();
    removeThinking();
    setGenerating(false);
    document.getElementById("send-btn").disabled = false;
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

vscodeApi.postMessage({ type: "ready" });
