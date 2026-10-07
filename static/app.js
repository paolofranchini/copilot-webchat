const messagesEl = document.getElementById("messages");
const form = document.getElementById("chatForm");
const input = document.getElementById("input");
const sendBtn = document.getElementById("sendBtn");
const newChatBtn = document.getElementById("newChatBtn");
const settingsBtn = document.getElementById("settingsBtn");
const settingsView = document.getElementById("settingsView");
const chatView = document.getElementById("chatView");
const settingsChatName = document.getElementById("settingsChatName");
const logoutBtn = document.getElementById("logoutBtn");
const chatListEl = document.getElementById("chatList");
const sidebar = document.getElementById("sidebar");
const menuBtn = document.getElementById("menuBtn");
const closeSidebarBtn = document.getElementById("closeSidebarBtn");
const modelSelect = document.getElementById("modelSelect");
const settingsModelSelect = document.getElementById("settingsModelSelect");
const chatUsageEl = document.getElementById("chatUsage");
const permissionModeSelects = document.querySelectorAll("[data-permission-mode]");
const attachmentBtn = document.getElementById("attachmentBtn");
const attachmentPicker = document.getElementById("attachmentPicker");
const attachmentInput = document.getElementById("attachmentInput");
const attachmentDropzone = document.getElementById("attachmentDropzone");
const attachmentPreviews = document.getElementById("attachmentPreviews");
const advancedModeToggle = document.getElementById("advancedModeToggle");
const planToggle = document.getElementById("planToggle");
const chatNotice = document.getElementById("chatNotice");
const toolPermissionsInput = document.getElementById("toolPermissions");
const mcpList = document.getElementById("mcpList");
const mcpConfigList = document.getElementById("mcpConfigList");
const skillsList = document.getElementById("skillsList");
const slashSuggestions = document.getElementById("slashSuggestions");
const dictationStatus = document.getElementById("dictationStatus");

let currentChatId = null;
let pendingChatId = null;
let attachedFiles = [];
let busy = false;
let mcpServers = [];
let selectedMcpServers = [];
let pendingPlan = false;
let activeJob = null;
let jobController = null;
let wakeJob = null;
const chatPermissions = new Map();
const chatUsages = new Map();
const chatPlans = new Map();
const chatModels = new Map();
const chatMcpServers = new Map();
const chatTools = new Map();
const mobileLayout = window.matchMedia("(max-width: 700px)");
document.getElementById("saveToolPermissions").disabled = true;

function syncToolControls() {
  toolPermissionsInput.disabled = !advancedEnabled() || busy;
  document.getElementById("saveToolPermissions").disabled = !currentChatId || busy;
}

function selectedTools() {
  return [...new Set(toolPermissionsInput.value.split("\n").map((tool) => tool.trim()).filter(Boolean))];
}

function showNotice(message) {
  chatNotice.textContent = message;
  chatNotice.hidden = !message;
}

function advancedEnabled() {
  return advancedModeToggle.checked;
}

function syncAdvancedMode() {
  syncToolControls();
  document.querySelectorAll("[data-advanced]").forEach((element) => {
    element.hidden = !advancedEnabled();
  });
  if (!advancedEnabled()) planToggle.checked = false;
  document.querySelectorAll(".plan-actions").forEach((element) => {
    element.hidden = !advancedEnabled();
  });
  if (advancedEnabled() && pendingPlan && currentChatId
    && !messagesEl.querySelector(".plan-actions")) {
    const planMessage = messagesEl.querySelector(".pending-plan-message");
    if (planMessage) attachPlanActions(planMessage);
  }
  if (advancedEnabled()) {
    loadMcpServers();
    loadSkills();
  }
  updateSlashSuggestions();
}
advancedModeToggle.checked = localStorage.getItem("copilot-advanced-mode") === "true";
advancedModeToggle.addEventListener("change", () => {
  localStorage.setItem("copilot-advanced-mode", String(advancedEnabled()));
  syncAdvancedMode();
});

function syncSidebarWithViewport() {
  if (mobileLayout.matches) {
    sidebar.classList.add("hidden");
  } else {
    sidebar.classList.remove("hidden");
  }
}

syncSidebarWithViewport();
mobileLayout.addEventListener("change", syncSidebarWithViewport);

function setModelControls(model, isChat = Boolean(currentChatId)) {
  for (const select of [modelSelect, settingsModelSelect]) {
    if (![...select.options].some((option) => option.value === model)) {
      const option = document.createElement("option");
      option.value = model;
      option.textContent = model;
      select.append(option);
    }
    select.value = model;
  }
  document.querySelectorAll("[data-model-label]").forEach((label) => {
    label.textContent = isChat ? "Modello chat" : "Modello nuova chat";
  });
}

const savedModel = localStorage.getItem("copilot-model") || "auto";
setModelControls(savedModel, false);
localStorage.setItem("copilot-model", modelSelect.value);
async function loadModels() {
  try {
    const data = await jsonRequest("/api/command", "POST", { command: "/model" });
    if (!Array.isArray(data.models) || !data.models.length
      || data.models.some((model) => typeof model !== "string")) {
      throw new Error("Elenco modelli di Copilot non valido");
    }
    const selectedModel = currentChatId
      ? chatModels.get(currentChatId) || modelSelect.value || savedModel
      : modelSelect.value || savedModel;
    for (const select of [modelSelect, settingsModelSelect]) {
      const model = select.value || selectedModel;
      select.replaceChildren();
      for (const id of data.models) {
        const option = document.createElement("option");
        option.value = id;
        option.textContent = id === "auto" ? "Auto" : id;
        select.append(option);
      }
      if (!data.models.includes(model)) {
        const option = document.createElement("option");
        option.value = model;
        option.textContent = model;
        select.append(option);
      }
      select.value = model;
      select.disabled = false;
    }
    setModelControls(selectedModel, Boolean(currentChatId));
    showNotice("");
  } catch (err) {
    for (const select of [modelSelect, settingsModelSelect]) select.disabled = true;
    showNotice(err.message);
  }
}
let modelUpdating = false;
for (const select of [modelSelect, settingsModelSelect]) {
  select.addEventListener("change", async () => {
    if (modelUpdating) return;
    const previousDefault = localStorage.getItem("copilot-model") || "auto";
    const previousSelection = modelSelect.value;
    const model = select.value;
    setModelControls(model);
    localStorage.setItem("copilot-model", model);
    if (!currentChatId) return;

    const chatId = currentChatId;
    modelUpdating = true;
    for (const control of [modelSelect, settingsModelSelect]) control.disabled = true;
    try {
      const data = await jsonRequest("/api/command", "POST", {
        command: `/model ${model}`,
      });
      chatModels.set(chatId, data.model);
      showNotice(data.reply);
      loadChatList();
    } catch (err) {
      const activeModel = currentChatId === chatId
        ? chatModels.get(chatId) || previousSelection
        : currentChatId ? chatModels.get(currentChatId) || modelSelect.value : previousDefault;
      setModelControls(activeModel, Boolean(currentChatId));
      localStorage.setItem("copilot-model", previousDefault);
      showNotice(err.message);
    } finally {
      modelUpdating = false;
      for (const control of [modelSelect, settingsModelSelect]) control.disabled = false;
    }
  });
}

function showSettings(open) {
  settingsView.hidden = !open;
  chatView.hidden = open;
  settingsBtn.classList.toggle("active", open);
  settingsBtn.setAttribute("aria-expanded", String(open));
  if (open) {
    sidebar.classList.add("hidden");
    settingsView.scrollTop = 0;
    document.getElementById("settingsTitle").focus();
  } else {
    input.focus();
  }
}

settingsBtn.addEventListener("click", () => {
  if (busy) return;
  showSettings(true);
});

const restartServiceBtn = document.getElementById("restartServiceBtn");
const restartServiceStatus = document.getElementById("restartServiceStatus");
restartServiceBtn.addEventListener("click", async () => {
  if (busy) {
    showNotice("Attendi che Copilot termini prima di riavviare");
    return;
  }
  if (!window.confirm("Riavviare il servizio? La pagina si ricaricherà automaticamente quando sarà di nuovo disponibile.")) return;
  restartServiceBtn.disabled = true;
  restartServiceStatus.hidden = false;
  restartServiceStatus.textContent = "Richiesta di riavvio...";
  let oldInstance;
  try {
    const response = await fetch("/api/service", { cache: "no-store" });
    if (response.status === 401) { window.location.href = "/login.html"; return; }
    const status = await readApiResponse(response);
    if (!response.ok || !status.instance_id) throw new Error(status.error || "Impossibile verificare il servizio");
    oldInstance = status.instance_id;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch("/api/service/restart", {
        method: "POST", signal: controller.signal,
      });
      if (res.status === 401) { window.location.href = "/login.html"; return; }
      const data = await readApiResponse(res);
      if (!res.ok) throw Object.assign(new Error(data.error || "Riavvio non riuscito"), { rejected: true });
    } catch (err) {
      if (err.rejected) throw err;
      // Una risposta persa non conferma il riavvio: verifica la nuova istanza.
    } finally {
      clearTimeout(timeout);
    }
    restartServiceStatus.textContent = "In attesa del servizio; la pagina si ricaricherà automaticamente...";
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        const res = await fetch("/api/service", { cache: "no-store", signal: controller.signal });
        if (res.status === 401) { window.location.href = "/login.html"; return; }
        const data = await readApiResponse(res);
        if (res.ok && data.instance_id && data.instance_id !== oldInstance) {
          window.location.reload();
          return;
        }
      } catch (_error) {
        // Il servizio puo' non rispondere durante il riavvio.
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error("Riavvio non confermato entro un minuto. Verifica il servizio e ricarica la pagina.");
  } catch (err) {
    restartServiceStatus.textContent = err.message;
  } finally {
    restartServiceBtn.disabled = false;
  }
});

function selectedPermissions() {
  const mode = permissionModeSelects[0]?.value || "ask";
  if (mode === "agent") return ["all"];
  if (mode === "edit") return ["shell", "write"];
  return [];
}

function syncPermissions(permissions) {
  const mode = permissions.includes("all")
    ? "agent"
    : permissions.includes("shell") || permissions.includes("write") ? "edit" : "ask";
  permissionModeSelects.forEach((select) => { select.value = mode; });
}

permissionModeSelects.forEach((select) => {
  select.addEventListener("change", async () => {
    const previous = currentChatId ? (chatPermissions.get(currentChatId) || []) : null;
    const mode = select.value;
    const permissions = mode === "agent" ? ["all"]
      : mode === "edit" ? ["shell", "write"] : [];
    syncPermissions(permissions);
    if (currentChatId) {
      try {
        await jsonRequest(`/api/chats/${currentChatId}/permissions`, "PUT", { permissions });
        chatPermissions.set(currentChatId, permissions);
        showNotice("");
      } catch (err) {
        syncPermissions(previous);
        showNotice(err.message);
      }
    }
  });
});

async function jsonRequest(url, method, body) {
  const payload = (url.startsWith("/api/mcp-servers") || url.endsWith("/mcp-servers")
    || url.endsWith("/tool-permissions"))
    ? { ...body, advanced: true } : body;
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) {
    window.location.href = "/login.html";
    throw new Error("non autenticato");
  }
  const data = await readApiResponse(res);
  if (!res.ok) throw new Error(data.error || `Errore HTTP ${res.status}`);
  return data;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function readApiResponse(response) {
  const body = await response.text();
  try {
    return body ? JSON.parse(body) : {};
  } catch (_error) {
    return {
      error: `risposta non valida dal server (HTTP ${response.status})`,
    };
  }
}

// Formattazione markdown minimale e sicura: escape HTML prima di tutto,
// poi converte il markdown supportato (nessun HTML arbitrario).
function imageUrl(source) {
  const local = source.match(/^\/api\/chats\/[a-f0-9-]+\/images\/[^?#]+$/i);
  if (!/^https?:\/\//i.test(source) && !local) return null;
  try {
    const url = new URL(source, window.location.href);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    if (local && !url.pathname.startsWith(source.slice(0, source.indexOf("/images/") + 8))) return null;
    return url.href;
  } catch (_error) {
    return null;
  }
}

function renderMarkdown(text) {
  let html = escapeHtml(text);
  const fragments = [];
  let prefix = "@@MARKDOWN_FRAGMENT_";
  while (text.includes(prefix)) prefix = `@${prefix}`;
  const protect = (markup) => {
    const token = `${prefix}${fragments.length}@@`;
    fragments.push(markup);
    return token;
  };
  html = html.replace(/```([\s\S]*?)```/g, (_, code) => {
    return protect(`<pre><code>${code}</code></pre>`);
  });
  html = html.replace(/`([^`]+)`/g, (_, code) => protect(`<code>${code}</code>`));
  html = html.replace(/!\[([^\]\n]*)\]\(([^ \n]+)\)/g, (match, alt, source) => {
    const url = imageUrl(source.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
    if (!url) return protect(match);
    const href = escapeHtml(url).replace(/"/g, "&quot;");
    const label = alt.replace(/"/g, "&quot;");
    return protect(`<a class="message-image" href="${href}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"><img src="${href}" alt="${label}" loading="lazy" referrerpolicy="no-referrer"></a>`);
  });
  const lines = html.split("\n");
  const tableLines = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = parseTableRow(lines[index]);
    const separator = index + 1 < lines.length ? parseTableRow(lines[index + 1]) : null;
    if (!header || !separator || !separator.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))) {
      tableLines.push(lines[index]);
      continue;
    }

    const alignments = separator.map((cell) => {
      const value = cell.trim();
      if (value.startsWith(":") && value.endsWith(":")) return "center";
      if (value.startsWith(":")) return "left";
      if (value.endsWith(":")) return "right";
      return null;
    });
    const table = [
      "<table><thead><tr>",
      ...header.map((cell, cellIndex) => `<th${alignments[cellIndex] ? ` style="text-align:${alignments[cellIndex]}"` : ""}>${cell.trim()}</th>`),
      "</tr></thead><tbody>",
    ];
    index += 2;
    while (index < lines.length) {
      const row = parseTableRow(lines[index]);
      if (!row) break;
      table.push("<tr>");
      header.forEach((_, cellIndex) => {
        const cell = row[cellIndex] || "";
        const alignment = alignments[cellIndex];
        table.push(`<td${alignment ? ` style="text-align:${alignment}"` : ""}>${cell.trim()}</td>`);
      });
      table.push("</tr>");
      index += 1;
    }
    table.push("</tbody></table>");
    tableLines.push(table.join(""));
    index -= 1;
  }
  html = tableLines.join("\n");
  html = html.replace(
    /^( {0,3})(#{1,6})[ \t]+(.+?)[ \t]*#?[ \t]*$/gm,
    (_, _indent, hashes, title) => `<h${hashes.length}>${title}</h${hashes.length}>`,
  );
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  html = html.replace(/\n/g, "<br>");
  fragments.forEach((fragment, index) => {
    html = html.replace(`${prefix}${index}@@`, () => fragment);
  });
  return html;
}

function parseTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  const content = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return content.split("|");
}

function formatMessageTime(ts) {
  const date = ts ? new Date(ts) : new Date();
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
}

function addMessage(text, cls, model, ts, usage) {
  const el = document.createElement("div");
  el.className = `msg ${cls}`;
  if (el.classList.contains("pending")) {
    el.classList.add("thinking");
    el.setAttribute("role", "status");
    const label = document.createElement("span");
    label.className = "thinking-label";
    label.textContent = text.replace(/\.{3}$/, "");
    const dots = document.createElement("span");
    dots.className = "thinking-dots";
    dots.setAttribute("aria-hidden", "true");
    for (let index = 0; index < 3; index += 1) {
      dots.appendChild(document.createElement("span"));
    }
    el.append(label, dots);
  } else if (cls.startsWith("bot")) {
    el.innerHTML = renderMarkdown(text);
    el.querySelectorAll(".message-image img").forEach((image) => {
      image.addEventListener("error", () => {
        const error = document.createElement("span");
        error.className = "message-image-error";
        error.textContent = `Immagine non disponibile${image.alt ? `: ${image.alt}` : ""}`;
        image.replaceWith(error);
      }, { once: true });
    });
  } else {
    el.textContent = text;
  }
  if (!cls.includes("pending") && !cls.includes("error")) {
    const metadata = document.createElement("div");
    metadata.className = "msg-metadata";
    if (model) {
      const tag = document.createElement("span");
      tag.className = "model-tag";
      tag.textContent = model;
      tag.title = model;
      metadata.appendChild(tag);
    }
    const credits = formatChatUsage(usage, true);
    if (credits) {
      const cost = document.createElement("span");
      cost.className = "msg-credits";
      cost.textContent = credits;
      cost.title = "Consumo del turno, incluse chiamate ai tool e sottoagenti";
      metadata.appendChild(cost);
    }
    const time = formatMessageTime(ts);
    if (time) {
      const timeEl = document.createElement("span");
      timeEl.className = "msg-time";
      timeEl.textContent = time;
      metadata.appendChild(timeEl);
    }
    if (metadata.childElementCount) el.appendChild(metadata);
  }
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

function formatChatUsage(usage, compact = false) {
  if (!usage) return null;
  const numberFormat = new Intl.NumberFormat("it-IT", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (Number.isFinite(usage.ai_credits)) {
    return compact
      ? `✦ ${numberFormat.format(usage.ai_credits)}`
      : `${numberFormat.format(usage.ai_credits)} crediti AI`;
  }
  if (Number.isFinite(usage.premium_requests)) {
    return `${numberFormat.format(usage.premium_requests)} richieste premium`;
  }
  return null;
}

function formatChatTimestamp(timestamp) {
  const date = timestamp ? new Date(timestamp) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("it-IT", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderChatUsage() {
  if (!currentChatId) {
    chatUsageEl.textContent = "";
    return;
  }
  const usage = formatChatUsage(chatUsages.get(currentChatId));
  chatUsageEl.textContent = usage ? `✦ ${usage}` : "";
}

function autoResize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 140) + "px";
}
input.addEventListener("input", autoResize);

function renderAttachmentPreviews() {
  attachmentPreviews.innerHTML = "";
  attachedFiles.forEach((file, index) => {
    const preview = document.createElement("div");
    preview.className = "attachment-preview";
    if (file.type.startsWith("image/")) {
      const image = document.createElement("img");
      image.src = URL.createObjectURL(file);
      image.alt = file.name;
      image.onload = () => URL.revokeObjectURL(image.src);
      preview.appendChild(image);
    } else {
      const fileName = document.createElement("span");
      fileName.className = "attachment-file-name";
      fileName.textContent = file.name;
      preview.appendChild(fileName);
    }
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.setAttribute("aria-label", `Rimuovi ${file.name}`);
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => {
      attachedFiles.splice(index, 1);
      renderAttachmentPreviews();
    });
    preview.append(removeBtn);
    attachmentPreviews.appendChild(preview);
  });
}

function addAttachments(files) {
  attachedFiles = [...attachedFiles, ...files].slice(0, 5);
  attachmentInput.value = "";
  renderAttachmentPreviews();
}

attachmentBtn.addEventListener("click", () => {
  attachmentPicker.hidden = !attachmentPicker.hidden;
  attachmentBtn.setAttribute("aria-expanded", String(!attachmentPicker.hidden));
});

attachmentDropzone.addEventListener("click", () => attachmentInput.click());
attachmentDropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    attachmentInput.click();
  }
});
attachmentInput.addEventListener("change", () => addAttachments(attachmentInput.files));
attachmentDropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  attachmentDropzone.classList.add("dragging");
});
attachmentDropzone.addEventListener("dragleave", () => {
  attachmentDropzone.classList.remove("dragging");
});
attachmentDropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  attachmentDropzone.classList.remove("dragging");
  addAttachments(event.dataTransfer.files);
});

function updateSlashSuggestions() {
  const value = input.value.trimStart();
  const commands = ["/help", "/usage", "/model "];
  const matches = advancedEnabled() && value.startsWith("/")
    ? commands.filter((command) => command.startsWith(value) || value === "/")
    : [];
  slashSuggestions.replaceChildren();
  matches.forEach((command) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = command.trim();
    button.addEventListener("click", () => {
      input.value = command;
      input.focus();
      autoResize();
      updateSlashSuggestions();
    });
    slashSuggestions.append(button);
  });
  slashSuggestions.hidden = matches.length === 0;
}
input.addEventListener("input", updateSlashSuggestions);

function renderMcpServers() {
  mcpList.replaceChildren();
  mcpConfigList.replaceChildren();
  for (const server of mcpServers) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedMcpServers.includes(server.id);
    checkbox.disabled = !server.enabled || busy;
    checkbox.addEventListener("change", async () => {
      const previous = [...selectedMcpServers];
      const servers = checkbox.checked
        ? [...previous, server.id] : previous.filter((id) => id !== server.id);
      if (!currentChatId) {
        selectedMcpServers = servers;
        showNotice("");
        return;
      }
      try {
        await jsonRequest(`/api/chats/${currentChatId}/mcp-servers`, "PUT", { servers });
        selectedMcpServers = servers;
        chatMcpServers.set(currentChatId, servers);
        showNotice("");
      } catch (err) {
        selectedMcpServers = previous;
        checkbox.checked = !checkbox.checked;
        showNotice(err.message);
      }
    });
    label.append(checkbox, document.createTextNode(` ${server.name}${server.enabled ? "" : " (disabilitato)"}`));
    const selection = document.createElement("div");
    selection.className = "mcp-row";
    selection.append(label);
    mcpList.append(selection);

    const row = document.createElement("div");
    row.className = "mcp-row";
    const name = document.createElement("span");
    name.textContent = server.name;
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "Modifica";
    edit.addEventListener("click", async () => {
      const name = window.prompt("Nome server MCP:", server.name);
      if (name === null) return;
      const configText = window.prompt("Configurazione JSON MCP:", JSON.stringify(server.config));
      if (configText === null) return;
      try {
        const config = parseMcpConfig(configText);
        await jsonRequest(`/api/mcp-servers/${server.id}`, "PUT", { name, config, enabled: server.enabled });
        await loadMcpServers();
        showNotice("");
      } catch (err) {
        showNotice(err.message);
      }
    });
    const enabled = document.createElement("button");
    enabled.type = "button";
    enabled.textContent = server.enabled ? "Disabilita" : "Abilita";
    enabled.addEventListener("click", async () => {
      try {
        await jsonRequest(`/api/mcp-servers/${server.id}`, "PUT", {
          name: server.name, config: server.config, enabled: !server.enabled,
        });
        await loadMcpServers();
        showNotice("");
      } catch (err) {
        showNotice(err.message);
      }
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Elimina";
    remove.addEventListener("click", async () => {
      if (!window.confirm(`Eliminare il server MCP ${server.name}?`)) return;
      try {
        await jsonRequest(`/api/mcp-servers/${server.id}`, "DELETE");
        selectedMcpServers = selectedMcpServers.filter((id) => id !== server.id);
        for (const [chatId, servers] of chatMcpServers) {
          chatMcpServers.set(chatId, servers.filter((id) => id !== server.id));
        }
        await loadMcpServers();
        showNotice("");
      } catch (err) {
        showNotice(err.message);
      }
    });
    row.append(name, edit, enabled, remove);
    mcpConfigList.append(row);
  }
  if (!mcpServers.length) {
    mcpList.textContent = "Nessun server disponibile";
    mcpConfigList.textContent = "Nessun server configurato";
  }
}

function parseMcpConfig(text) {
  let config;
  try {
    config = JSON.parse(text);
  } catch (_error) {
    throw new Error("Configurazione MCP: JSON non valido");
  }
  if (!config || typeof config !== "object" || Array.isArray(config)
    || typeof config.command !== "string" || !config.command.startsWith("/")
    || !Array.isArray(config.args) || !config.args.every((arg) => typeof arg === "string")
    || !config.env || typeof config.env !== "object" || Array.isArray(config.env)
    || !Object.values(config.env).every((value) => typeof value === "string")
    || Object.keys(config).some((key) => !["command", "args", "env"].includes(key))) {
    throw new Error("Config MCP: servono command (percorso assoluto), args (stringhe) ed env (stringhe)");
  }
  return config;
}

async function loadMcpServers() {
  try {
    const res = await fetch("/api/mcp-servers");
    if (res.status === 401) { window.location.href = "/login.html"; return; }
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.error || "Impossibile caricare i server MCP");
    mcpServers = data;
    renderMcpServers();
  } catch (err) {
    mcpList.textContent = err.message;
    mcpConfigList.textContent = err.message;
  }
}

document.getElementById("mcpForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const name = document.getElementById("mcpName").value.trim();
    const config = parseMcpConfig(document.getElementById("mcpConfig").value);
    await jsonRequest("/api/mcp-servers", "POST", { name, config });
    event.target.reset();
    await loadMcpServers();
    showNotice("");
  } catch (err) {
    showNotice(err.message);
  }
});

async function loadSkills() {
  try {
    const res = await fetch("/api/skills");
    if (res.status === 401) { window.location.href = "/login.html"; return; }
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.error || "Skill non disponibili");
    skillsList.replaceChildren();
    for (const [kind, entries] of [["Skill", data.skills || []], ["Plugin", data.plugins || []]]) {
      for (const entry of entries) {
        const item = document.createElement("div");
        item.textContent = `${kind}: ${entry.name}${entry.description ? ` — ${entry.description}` : ""}${entry.source ? ` (${entry.source})` : ""}`;
        skillsList.append(item);
      }
    }
    if (!skillsList.childElementCount) skillsList.textContent = "Nessuna skill o plugin disponibile";
  } catch (err) {
    skillsList.textContent = err.message;
  }
}

document.getElementById("saveToolPermissions").addEventListener("click", async () => {
  if (!currentChatId) { showNotice("I tool selezionati saranno salvati al primo messaggio"); return; }
  const tools = selectedTools();
  try {
    await jsonRequest(`/api/chats/${currentChatId}/tool-permissions`, "PUT", { tools });
    chatTools.set(currentChatId, tools);
    showNotice("Permessi tool salvati");
  } catch (err) {
    showNotice(err.message);
  }
});

document.getElementById("screenshotBtn").addEventListener("click", async () => {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    showNotice("Cattura schermo non supportata dal browser");
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const video = document.createElement("video");
    video.srcObject = stream;
    await video.play();
    if (!video.videoWidth || !video.videoHeight) throw new Error("Impossibile acquisire lo schermo");
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Impossibile creare lo screenshot");
    addAttachments([new File([blob], `screenshot-${Date.now()}.png`, { type: "image/png" })]);
    showNotice("");
  } catch (err) {
    showNotice(`Screenshot: ${err.message}`);
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
});

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const dictationBtn = document.getElementById("dictationBtn");
if (!SpeechRecognition) {
  dictationBtn.disabled = true;
  dictationStatus.textContent = "Dettatura non supportata dal browser";
} else {
  let recognition;
  dictationBtn.addEventListener("click", () => {
    if (recognition) { recognition.stop(); return; }
    recognition = new SpeechRecognition();
    recognition.lang = "it-IT";
    recognition.onresult = (event) => {
      const transcript = [...event.results].map((result) => result[0].transcript).join(" ");
      input.value = `${input.value}${input.value && !input.value.endsWith(" ") ? " " : ""}${transcript}`;
      autoResize();
      updateSlashSuggestions();
    };
    recognition.onerror = (event) => { dictationStatus.textContent = `Dettatura: ${event.error}`; };
    recognition.onend = () => { recognition = null; dictationBtn.textContent = "Dettatura"; };
    try {
      recognition.start();
      dictationBtn.textContent = "Ferma dettatura";
      dictationStatus.textContent = "Ascolto...";
    } catch (err) {
      recognition = null;
      dictationStatus.textContent = `Dettatura: ${err.message}`;
    }
  });
}

async function loadChatList() {
  const res = await fetch("/api/chats");
  if (res.status === 401) { window.location.href = "/login.html"; return; }
  if (!res.ok) return;
  const chats = await res.json();
  for (const chat of chats) chatModels.set(chat.id, chat.model);
  if (currentChatId) {
    setModelControls(chatModels.get(currentChatId) || modelSelect.value, true);
  }
  settingsChatName.textContent = currentChatId
    ? (chats.find((chat) => chat.id === currentChatId)?.title || "selezionata")
    : "nuova";
  for (const chat of chats) chatUsages.set(chat.id, chat.usage);
  renderChatUsage();
  chatListEl.innerHTML = "";
  for (const c of chats) {
    chatPermissions.set(c.id, c.permissions || []);
    chatUsages.set(c.id, c.usage);
    chatPlans.set(c.id, !!c.pending_plan);
    chatMcpServers.set(c.id, c.mcp_servers || []);
    chatTools.set(c.id, c.tool_permissions || []);
    const item = document.createElement("div");
    item.className = "chat-item" + (c.id === currentChatId ? " active" : "");
    const titleWrap = document.createElement("span");
    titleWrap.className = "chat-title-wrap";
    const title = document.createElement("span");
    title.className = "chat-title";
    title.textContent = c.title || "(senza titolo)";
    titleWrap.appendChild(title);
    const timestamp = formatChatTimestamp(c.last_message_at);
    const usage = formatChatUsage(c.usage);
    const metadataText = [timestamp, usage].filter(Boolean).join(" · ");
    if (metadataText) {
      const metadata = document.createElement("span");
      metadata.className = "chat-metadata";
      metadata.textContent = metadataText;
      titleWrap.appendChild(metadata);
    }
    const deleteBtn = document.createElement("button");
    const renameBtn = document.createElement("button");
    renameBtn.className = "rename-chat-btn";
    renameBtn.type = "button";
    renameBtn.title = "Rinomina chat";
    renameBtn.setAttribute("aria-label", `Rinomina chat ${c.title || ""}`);
    renameBtn.textContent = "✎";
    renameBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      renameChat(c.id, c.title || "");
    });
    deleteBtn.className = "delete-chat-btn";
    deleteBtn.type = "button";
    deleteBtn.title = "Elimina chat";
    deleteBtn.setAttribute("aria-label", `Elimina chat ${c.title || ""}`);
    deleteBtn.textContent = "×";
    deleteBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteChat(c.id);
    });
    item.append(titleWrap, renameBtn, deleteBtn);
    item.addEventListener("click", () => openChat(c.id));
    chatListEl.appendChild(item);
  }
}

async function renameChat(chatId, currentTitle) {
  const title = window.prompt("Nuovo titolo della chat:", currentTitle);
  if (title === null) return;

  const res = await fetch(`/api/chats/${chatId}/title`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const data = await readApiResponse(res);
  if (!res.ok) {
    window.alert(data.error || "Impossibile rinominare la chat");
    return;
  }
  loadChatList();
}

async function deleteChat(chatId) {
  if (!window.confirm("Eliminare definitivamente questa sessione Copilot e tutta la sua cronologia?")) return;
  const res = await fetch(`/api/chats/${chatId}`, { method: "DELETE" });
  if (!res.ok) {
    const data = await readApiResponse(res);
    showNotice(data.error || "Impossibile eliminare la sessione");
    return;
  }
  if (currentChatId === chatId) {
    currentChatId = null;
    setModelControls(localStorage.getItem("copilot-model") || "auto", false);
    syncToolControls();
    pendingPlan = false;
    selectedMcpServers = [];
    toolPermissionsInput.value = "";
    renderMcpServers();
    messagesEl.innerHTML = "";
    renderChatUsage();
    settingsChatName.textContent = "nuova";
  }
  chatUsages.delete(chatId);
  chatPlans.delete(chatId);
  chatModels.delete(chatId);
  chatMcpServers.delete(chatId);
  chatTools.delete(chatId);
  loadChatList();
}

async function openChat(chatId, refresh = false) {
  if (busy && !refresh) return false;
  const res = await fetch(`/api/chats/${chatId}`);
  if (res.status === 401) { window.location.href = "/login.html"; return; }
  if (!res.ok) return false;
  const msgs = await res.json();
  pendingChatId = null;
  currentChatId = chatId;
  sessionStorage.setItem("copilot-current-chat", chatId);
  setModelControls(chatModels.get(chatId) || localStorage.getItem("copilot-model") || "auto", true);
  showSettings(false);
  syncToolControls();
  pendingPlan = chatPlans.get(chatId) || false;
  selectedMcpServers = chatMcpServers.get(chatId) || [];
  toolPermissionsInput.value = (chatTools.get(chatId) || []).join("\n");
  renderMcpServers();
  renderChatUsage();
  syncPermissions(chatPermissions.get(chatId) || []);
  messagesEl.innerHTML = "";
  const lastPlanIndex = msgs.findLastIndex((message) => message.role === "plan");
  for (const [index, m] of msgs.entries()) {
    const element = addMessage(m.content, m.role === "user" ? "user" : "bot", m.model, m.ts, m.usage);
    if (index === lastPlanIndex && pendingPlan) {
      element.classList.add("pending-plan-message");
      attachPlanActions(element);
    }
  }
  sidebar.classList.add("hidden");
  loadChatList();
  return true;
}

function attachPlanActions(element) {
  if (!advancedEnabled() || element.querySelector(".plan-actions")) return;
  const actions = document.createElement("div");
  actions.className = "plan-actions";
  for (const [label, path] of [
    ["Approva ed esegui", "/api/chat/plan/approve"],
    ["Annulla", "/api/chat/plan/cancel"],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", async () => {
      if (busy) return;
      if (path.endsWith("approve")) {
        await approvePlanAsync();
        return;
      }
      busy = true;
      actions.querySelectorAll("button").forEach((item) => { item.disabled = true; });
      const placeholder = path.endsWith("approve") ? addMessage("Copilot sta eseguendo il piano...", "bot pending") : null;
      try {
        const data = await jsonRequest(path, "POST", { advanced: true });
        placeholder?.remove();
        actions.remove();
        pendingPlan = false;
        if (currentChatId) chatPlans.set(currentChatId, false);
        if (data.chat_id) currentChatId = data.chat_id;
        if (data.usage && currentChatId) chatUsages.set(currentChatId, data.usage);
        if (data.reply) addMessage(data.reply, "bot", data.model, data.ts, data.message_usage);
        renderChatUsage();
        loadChatList();
        showNotice(path.endsWith("cancel") ? "Piano annullato" : "");
      } catch (err) {
        placeholder?.remove();
        actions.querySelectorAll("button").forEach((item) => { item.disabled = false; });
        showNotice(err.message);
      } finally {
        busy = false;
      }
    });
    actions.append(button);
  }
  element.append(actions);
}

function showActivity(container, event) {
  const data = event.data || {};
  const activity = document.createElement("div");
  activity.className = "tool-activity";
  const name = data.tool_name || data.name || data.tool || data.command || "tool";
  activity.textContent = `Attività: ${String(name)}`;
  container.append(activity);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function streamChat(formData, pending, activity) {
  formData.append("async", "true");
  formData.append("request_id", activeJob.id);
  const url = formData.get("advanced") === "true" ? "/api/chat/stream" : "/api/chat";
  await startJobRequest(url, { method: "POST", body: formData });
  return waitForJob(pending, activity);
}

function newRequestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function rememberJob() {
  sessionStorage.setItem("copilot-pending-job", JSON.stringify(activeJob));
}

function clearJob() {
  activeJob = null;
  sessionStorage.removeItem("copilot-pending-job");
}

function setChatBusy(value) {
  busy = value;
  sendBtn.disabled = value;
  newChatBtn.disabled = value;
  attachmentBtn.disabled = value;
  document.querySelectorAll(".plan-actions button").forEach((button) => { button.disabled = value; });
  syncToolControls();
  renderMcpServers();
}

async function jobFetch(url, options = {}) {
  jobController = new AbortController();
  const controller = jobController;
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const data = await readApiResponse(res);
    return { res, data };
  } finally {
    clearTimeout(timeout);
    if (jobController === controller) jobController = null;
  }
}

function pauseJob() {
  return new Promise((resolve) => {
    const timer = setTimeout(done, document.hidden ? 30000 : 1500);
    function done() {
      clearTimeout(timer);
      wakeJob = null;
      resolve();
    }
    wakeJob = done;
  });
}

function resumeJob() {
  if (document.hidden) return;
  jobController?.abort();
  wakeJob?.();
}
document.addEventListener("visibilitychange", resumeJob);
window.addEventListener("pageshow", resumeJob);
window.addEventListener("online", resumeJob);

async function startJobRequest(url, options) {
  let res;
  let data;
  try {
    ({ res, data } = await jobFetch(url, options));
  } catch (_error) {
    showNotice("Connessione sospesa: recupero automatico della richiesta al ritorno.");
    return;
  }
  if (res.status === 401) {
    window.location.href = "/login.html";
    throw new Error("non autenticato");
  }
  if (!res.ok) {
    clearJob();
    throw Object.assign(new Error(data.error || `Errore HTTP ${res.status}`), data);
  }
  if (data.job_id !== activeJob.id || !data.chat_id) {
    showNotice("Conferma di invio non leggibile: recupero automatico della richiesta.");
    return;
  }
  activeJob.accepted = true;
  activeJob.chat_id = data.chat_id;
  currentChatId = data.chat_id;
  pendingChatId = null;
  sessionStorage.setItem("copilot-current-chat", currentChatId);
  rememberJob();
}

async function waitForJob(pending, activity) {
  let missing = 0;
  while (activeJob) {
    if (document.hidden || !navigator.onLine) {
      await pauseJob();
      continue;
    }
    let res;
    let data;
    try {
      ({ res, data } = await jobFetch(`/api/chat/jobs/${activeJob.id}`));
    } catch (_error) {
      showNotice("Connessione sospesa: la risposta verrà recuperata automaticamente.");
      await pauseJob();
      continue;
    }
    if (res.status === 401) {
      window.location.href = "/login.html";
      throw new Error("non autenticato");
    }
    if (res.status === 404 && !activeJob.accepted) {
      missing += 1;
      if (missing >= 5) {
        clearJob();
        const error = new Error("Invio non confermato dal server. Controlla la cronologia prima di riprovare.");
        error.unconfirmed = true;
        throw error;
      }
      await pauseJob();
      continue;
    }
    if (!res.ok) {
      showNotice(data.error || `Recupero risposta non disponibile (HTTP ${res.status}); nuovo tentativo automatico.`);
      await pauseJob();
      continue;
    }
    if (!data.chat_id || !["running", "done", "error"].includes(data.status)
      || (data.status !== "running" && !data.result)) {
      showNotice("Stato della risposta non leggibile; nuovo tentativo automatico.");
      await pauseJob();
      continue;
    }
    activeJob.accepted = true;
    activeJob.chat_id = data.chat_id;
    currentChatId = data.chat_id;
    pendingChatId = null;
    sessionStorage.setItem("copilot-current-chat", currentChatId);
    rememberJob();
    showNotice("");
    if (data.progress?.content) {
      pending.classList.remove("thinking");
      pending.removeAttribute("role");
      pending.textContent = data.progress.content;
    }
    activity.replaceChildren();
    for (const event of data.progress?.tools || []) showActivity(activity, event);
    if (data.status !== "running") {
      clearJob();
      if (data.status === "error") {
        throw Object.assign(new Error(data.result?.error || "Errore durante l'elaborazione"), data.result);
      }
      return data.result;
    }
    await pauseJob();
  }
}

async function approvePlanAsync() {
  setChatBusy(true);
  activeJob = { id: newRequestId(), chat_id: currentChatId, accepted: false };
  rememberJob();
  const pending = addMessage("Copilot sta eseguendo il piano...", "bot pending");
  const activity = document.createElement("div");
  messagesEl.append(activity);
  try {
    await startJobRequest("/api/chat/plan/approve", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ advanced: true, async: true, request_id: activeJob.id, chat_id: currentChatId }),
    });
    const data = await waitForJob(pending, activity);
    pendingPlan = false;
    chatPlans.set(currentChatId, false);
    await loadChatList();
    if (!await openChat(currentChatId, true)) addMessage(data.reply, "bot", data.model, data.ts, data.message_usage);
  } catch (err) {
    showNotice(err.message);
  } finally {
    pending.remove();
    activity.remove();
    setChatBusy(false);
  }
}

async function sendCommand(text) {
  const command = text.match(/^\/(help|usage)(?:\s*)$/i) || text.match(/^\/model\s+(\S+)\s*$/i);
  if (!command) return false;
  const data = await jsonRequest("/api/command", "POST", { command: text, advanced: true });
  if (data.model) {
    setModelControls(data.model);
    localStorage.setItem("copilot-model", data.model);
    if (currentChatId) chatModels.set(currentChatId, data.model);
  }
  if (data.usage && currentChatId) chatUsages.set(currentChatId, data.usage);
  renderChatUsage();
  addMessage(data.reply || "Comando eseguito", "bot", data.model);
  return true;
}

async function submitChat(e) {
  e.preventDefault();
  if (busy || pendingPlan) {
    if (pendingPlan) showNotice("Approva o annulla il piano prima di continuare");
    return;
  }
  const text = input.value.trim();
  if (!text && attachedFiles.length === 0) return;

  busy = true;
  syncToolControls();
  renderMcpServers();
  sendBtn.disabled = true;
  newChatBtn.disabled = true;
  attachmentBtn.disabled = true;
  const advanced = advancedEnabled();
  const submissionServers = [...selectedMcpServers];
  const submissionTools = selectedTools();
  const isCommand = advanced && attachedFiles.length === 0
    && (/^\/(help|usage)\s*$/i.test(text) || /^\/model\s+\S+\s*$/i.test(text));
  addMessage(text || `[Allegati ${attachedFiles.length} file]`, "user", null, new Date().toISOString());
  // Il testo è già stato acquisito per la richiesta; svuota il campo anche se
  // la risposta fallisce o lo streaming si interrompe.
  input.value = "";
  autoResize();
  const submittedFiles = attachedFiles;
  attachedFiles = [];
  renderAttachmentPreviews();
  const activity = document.createElement("div");
  activity.className = "activity-log";
  if (advanced && !isCommand) messagesEl.append(activity);
  const pending = isCommand ? null : addMessage("Copilot sta pensando...", "bot pending");
  let success = false;

  try {
    if (isCommand) {
      await sendCommand(text);
      success = true;
      return;
    }
    const formData = new FormData();
    formData.append("message", text);
    formData.append("chat_id", currentChatId || pendingChatId || "");
    formData.append("model", modelSelect.value);
    formData.append("permissions", JSON.stringify(selectedPermissions()));
    if (advanced) {
      formData.append("advanced", "true");
      formData.append("mcp_servers", JSON.stringify(submissionServers));
      formData.append("tool_permissions", JSON.stringify(submissionTools));
      if (planToggle.checked) formData.append("plan", "true");
    }
    submittedFiles.forEach((file) => formData.append("files", file));
    activeJob = {
      id: newRequestId(), chat_id: currentChatId || pendingChatId,
      accepted: false, text: text || `[Allegati ${submittedFiles.length} file]`,
    };
    rememberJob();
    const data = await streamChat(formData, pending, activity);
    pending.remove();
    if (data.chat_id) {
      currentChatId = data.chat_id;
      pendingChatId = null;
      chatModels.set(currentChatId, data.model || modelSelect.value);
      setModelControls(data.model || modelSelect.value, true);
      syncToolControls();
      chatUsages.set(currentChatId, data.usage);
      chatPermissions.set(currentChatId, selectedPermissions());
      if (advanced) {
        chatMcpServers.set(currentChatId, submissionServers);
        chatTools.set(currentChatId, submissionTools);
      }
      pendingPlan = !!data.pending_plan;
      chatPlans.set(currentChatId, pendingPlan);
      renderMcpServers();
      renderChatUsage();
      loadChatList();
    }
    const reply = addMessage(data.reply || "", "bot", data.model, data.ts, data.message_usage);
    if (pendingPlan) {
      reply.classList.add("pending-plan-message");
      attachPlanActions(reply);
    }
    success = true;
    showNotice("");
  } catch (err) {
    pending?.remove();
    // Il messaggio dell'utente resta visibile anche in caso di errore: viene
    // salvato lato server prima di invocare Copilot, quindi rimuoverlo dalla UI
    // sarebbe fuorviante (l'invio è comunque avvenuto).
    if (err.chat_id) {
      currentChatId = err.chat_id;
      pendingChatId = null;
      setModelControls(chatModels.get(currentChatId) || modelSelect.value, true);
      syncToolControls();
      if (err.usage) chatUsages.set(currentChatId, err.usage);
      renderChatUsage();
    }
    loadChatList();
    if (err.unconfirmed) {
      showNotice(err.message);
      return;
    }
    const errorMessage = addMessage(`Errore: ${err.message}`, "error");
    if (err.chat_id) {
      const reloadBtn = document.createElement("button");
      reloadBtn.type = "button";
      reloadBtn.className = "reload-chat-btn";
      reloadBtn.textContent = "Ricarica cronologia";
      reloadBtn.addEventListener("click", async () => {
        await loadChatList();
        await openChat(err.chat_id);
      });
      errorMessage.append(reloadBtn);
    }
  } finally {
    activity.remove();
    if (success && pendingPlan) planToggle.checked = false;
    busy = false;
    syncToolControls();
    renderMcpServers();
    sendBtn.disabled = false;
    newChatBtn.disabled = false;
    attachmentBtn.disabled = false;
    updateSlashSuggestions();
    if (!document.hidden) input.focus();
  }
}
form.addEventListener("submit", submitChat);

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

newChatBtn.addEventListener("click", async () => {
  if (busy) return;
  const res = await fetch("/api/new-chat", { method: "POST" });
  if (!res.ok) {
    showNotice((await readApiResponse(res)).error || "Impossibile creare una nuova chat");
    return;
  }
  const data = await readApiResponse(res);
  if (!data.chat_id) {
    showNotice("Il server non ha restituito l'ID della nuova chat");
    return;
  }
  pendingChatId = data.chat_id;
  currentChatId = null;
  sessionStorage.removeItem("copilot-current-chat");
  setModelControls(localStorage.getItem("copilot-model") || "auto", false);
  settingsChatName.textContent = "nuova";
  showSettings(false);
  syncToolControls();
  pendingPlan = false;
  selectedMcpServers = [];
  toolPermissionsInput.value = "";
  planToggle.checked = false;
  renderMcpServers();
  renderChatUsage();
  syncPermissions([]);
  messagesEl.innerHTML = "";
  sidebar.classList.add("hidden");
  loadChatList();
  syncAdvancedMode();
});

logoutBtn.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login.html";
});

menuBtn.addEventListener("click", () => {
  sidebar.classList.toggle("hidden");
});

closeSidebarBtn.addEventListener("click", () => {
  sidebar.classList.add("hidden");
});

async function restoreChat() {
  try {
    const stored = sessionStorage.getItem("copilot-pending-job");
    activeJob = stored ? JSON.parse(stored) : null;
    if (activeJob) setChatBusy(true);
    await loadChatList();
    const chatId = activeJob?.chat_id || sessionStorage.getItem("copilot-current-chat");
    let restored = false;
    if (chatId) restored = await openChat(chatId, true);
    if (!activeJob) return;
    setChatBusy(true);
    if (!restored && activeJob.text) addMessage(activeJob.text, "user");
    const pending = addMessage("Copilot sta pensando...", "bot pending");
    const activity = document.createElement("div");
    messagesEl.append(activity);
    try {
      const data = await waitForJob(pending, activity);
      await loadChatList();
      if (!await openChat(data.chat_id, true)) {
        addMessage(data.reply || "", "bot", data.model, data.ts, data.message_usage);
      }
    } catch (err) {
      showNotice(err.message);
    } finally {
      pending.remove();
      activity.remove();
      setChatBusy(false);
    }
  } catch (err) {
    showNotice(`Impossibile recuperare la chat: ${err.message}`);
    if (activeJob) {
      const pending = addMessage("Recupero della risposta...", "bot pending");
      const activity = document.createElement("div");
      messagesEl.append(activity);
      try {
        const data = await waitForJob(pending, activity);
        if (!await openChat(data.chat_id, true)) addMessage(data.reply || "", "bot", data.model, data.ts, data.message_usage);
      } catch (error) {
        showNotice(error.message);
      } finally {
        pending.remove();
        activity.remove();
        setChatBusy(false);
      }
    }
  }
}

restoreChat();
loadModels();
syncAdvancedMode();
