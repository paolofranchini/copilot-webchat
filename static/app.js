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
const permissionInputs = document.querySelectorAll("[data-permission]");
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
const rebuildChatsBtn = document.getElementById("rebuildChatsBtn");

let currentChatId = null;
let attachedFiles = [];
let busy = false;
let mcpServers = [];
let selectedMcpServers = [];
let pendingPlan = false;
const chatPermissions = new Map();
const chatUsages = new Map();
const chatPlans = new Map();
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

const savedModel = localStorage.getItem("copilot-model");
modelSelect.value = savedModel || "auto";
settingsModelSelect.value = modelSelect.value;
localStorage.setItem("copilot-model", modelSelect.value);
for (const select of [modelSelect, settingsModelSelect]) {
  select.addEventListener("change", () => {
    modelSelect.value = select.value;
    settingsModelSelect.value = select.value;
    localStorage.setItem("copilot-model", select.value);
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

function selectedPermissions() {
  return [...new Set([...permissionInputs]
    .filter((input) => input.checked && ["shell", "write", "all"].includes(input.dataset.permission))
    .map((input) => input.dataset.permission))];
}

function syncPermissions(permissions) {
  permissionInputs.forEach((input) => {
    input.checked = permissions.includes(input.dataset.permission);
  });
}

permissionInputs.forEach((input) => {
  input.addEventListener("change", async () => {
    const previous = currentChatId ? (chatPermissions.get(currentChatId) || []) : null;
    const group = [...input.closest("fieldset").querySelectorAll("[data-permission]")];
    const permissions = input.dataset.permission === "all" && input.checked
      ? ["all"]
      : [...new Set(group
        .filter((other) => other.dataset.permission !== "all" && other.checked)
        .map((other) => other.dataset.permission))];
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
// poi converte solo titoli, grassetto/corsivo/code/newline (nessun HTML arbitrario).
function renderMarkdown(text) {
  let html = escapeHtml(text);
  const codeBlocks = [];
  html = html.replace(/```([\s\S]*?)```/g, (_, code) => {
    const token = `@@CODE_BLOCK_${codeBlocks.length}@@`;
    codeBlocks.push(`<pre><code>${code}</code></pre>`);
    return token;
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
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  html = html.replace(/\n/g, "<br>");
  codeBlocks.forEach((block, index) => {
    html = html.replace(`@@CODE_BLOCK_${index}@@`, block);
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

function addMessage(text, cls, model, ts) {
  const el = document.createElement("div");
  el.className = `msg ${cls}`;
  if (cls.startsWith("bot")) {
    el.innerHTML = renderMarkdown(text);
  } else {
    el.textContent = text;
  }
  if (model) {
    const tag = document.createElement("div");
    tag.className = "model-tag";
    tag.textContent = model;
    el.appendChild(tag);
  }
  if (!cls.includes("pending") && !cls.includes("error")) {
    const time = formatMessageTime(ts);
    if (time) {
      const timeEl = document.createElement("div");
      timeEl.className = "msg-time";
      timeEl.textContent = time;
      el.appendChild(timeEl);
    }
  }
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

function formatChatUsage(usage) {
  if (!usage) return null;
  const numberFormat = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 9 });
  if (Number.isFinite(usage.ai_credits)) {
    return `${numberFormat.format(usage.ai_credits)} crediti AI`;
  }
  if (Number.isFinite(usage.premium_requests)) {
    return `${numberFormat.format(usage.premium_requests)} richieste premium`;
  }
  return null;
}

function renderChatUsage() {
  if (!currentChatId) {
    chatUsageEl.textContent = "";
    return;
  }
  const usage = formatChatUsage(chatUsages.get(currentChatId));
  chatUsageEl.textContent = usage
    ? `Utilizzo chat: ${usage}`
    : "Utilizzo crediti non disponibile";
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

rebuildChatsBtn.addEventListener("click", async () => {
  if (!window.confirm("Ricostruire il database usando le sessioni della webchat?")) return;
  rebuildChatsBtn.disabled = true;
  showNotice("Aggiornamento del database chat in corso...");
  try {
    const data = await jsonRequest("/api/chats/rebuild", "POST", {});
    currentChatId = null;
    pendingPlan = false;
    messagesEl.innerHTML = "";
    renderChatUsage();
    settingsChatName.textContent = "nuova";
    await loadChatList();
    showNotice(`Database chat aggiornato: ${data.count} chat ricostruite`);
  } catch (err) {
    showNotice(err.message);
  } finally {
    rebuildChatsBtn.disabled = false;
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
  settingsChatName.textContent = currentChatId
    ? (chats.find((chat) => chat.id === currentChatId)?.title || "selezionata")
    : "nuova";
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
    const usage = formatChatUsage(c.usage);
    if (usage) {
      const usageLabel = document.createElement("span");
      usageLabel.className = "chat-usage";
      usageLabel.textContent = usage;
      titleWrap.appendChild(usageLabel);
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
  if (!window.confirm("Eliminare questa chat?")) return;
  const res = await fetch(`/api/chats/${chatId}`, { method: "DELETE" });
  if (!res.ok) return;
  if (currentChatId === chatId) {
    currentChatId = null;
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
  chatMcpServers.delete(chatId);
  chatTools.delete(chatId);
  loadChatList();
}

async function openChat(chatId) {
  if (busy) return;
  const res = await fetch(`/api/chats/${chatId}`);
  if (res.status === 401) { window.location.href = "/login.html"; return; }
  if (!res.ok) return;
  const msgs = await res.json();
  currentChatId = chatId;
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
    const element = addMessage(m.content, m.role === "user" ? "user" : "bot", m.model, m.ts);
    if (index === lastPlanIndex && pendingPlan) {
      element.classList.add("pending-plan-message");
      attachPlanActions(element);
    }
  }
  sidebar.classList.add("hidden");
  loadChatList();
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
        if (data.reply) addMessage(data.reply, "bot", data.model, data.ts);
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
  const res = await fetch("/api/chat/stream", { method: "POST", body: formData });
  if (res.status === 401) { window.location.href = "/login.html"; throw new Error("non autenticato"); }
  if (res.status === 404 || res.status === 501) return null;
  if (!res.ok) {
    const data = await readApiResponse(res);
    throw new Error(data.error || `Errore HTTP ${res.status}`);
  }
  if (!res.body?.getReader) throw new Error("Streaming non supportato dal browser");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let complete = null;
  let partial = "";
  const handleBlock = (block) => {
    const payload = block.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!payload) return;
    const event = JSON.parse(payload);
    if (event.type === "chat_created") {
      currentChatId = event.chat_id;
      syncToolControls();
      chatPermissions.set(currentChatId, selectedPermissions());
      chatPlans.set(currentChatId, false);
      if (advancedEnabled()) {
        chatMcpServers.set(currentChatId, [...selectedMcpServers]);
        chatTools.set(currentChatId, selectedTools());
      }
      renderChatUsage();
      loadChatList();
    } else if (event.type === "done") {
      complete = event;
    } else if (event.type === "error") {
      const error = new Error(event.error || "Errore durante lo streaming");
      error.chat_id = event.chat_id;
      error.usage = event.usage;
      throw error;
    } else if (event.type === "tool.execution_start") {
      showActivity(activity, event);
    } else if (event.type === "assistant.message.delta") {
      partial += event.content || "";
      pending.textContent = partial;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        handleBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
      if (done) {
        if (buffer.trim()) handleBlock(buffer);
        break;
      }
    }
  } catch (err) {
    if (err.chat_id || err.usage || err.message === "Errore durante lo streaming") throw err;
    throw new Error(`${err.message}. La richiesta potrebbe essere già stata elaborata: controlla la cronologia prima di riprovare`);
  } finally {
    reader.releaseLock();
  }
  if (!complete) throw new Error("Stream interrotto prima della risposta finale; controlla la cronologia prima di riprovare");
  return complete;
}

async function sendCommand(text) {
  const command = text.match(/^\/(help|usage)(?:\s*)$/i) || text.match(/^\/model\s+(\S+)\s*$/i);
  if (!command) return false;
  const data = await jsonRequest("/api/command", "POST", { command: text, advanced: true });
  if (text.toLowerCase().startsWith("/model ")) {
    const model = text.split(/\s+/)[1];
    if (model && [...modelSelect.options].some((option) => option.value === model)) {
      modelSelect.value = model;
      localStorage.setItem("copilot-model", model);
    }
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
  // Il messaggio viene svuotato subito: a questo punto il testo è già stato
  // "consumato" per la richiesta e, lato server, viene salvato nella cronologia
  // prima ancora di invocare Copilot, quindi non deve restare bloccato nella
  // textbox anche se la richiesta fallisce o lo streaming si interrompe
  // (es. tab in background/schermo bloccato su mobile).
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
    formData.append("model", modelSelect.value);
    formData.append("permissions", JSON.stringify(selectedPermissions()));
    if (advanced) {
      formData.append("advanced", "true");
      formData.append("mcp_servers", JSON.stringify(submissionServers));
      formData.append("tool_permissions", JSON.stringify(submissionTools));
      if (planToggle.checked) formData.append("plan", "true");
    }
    submittedFiles.forEach((file) => formData.append("files", file));
    let data;
    if (advanced) data = await streamChat(formData, pending, activity);
    if (!data) {
      if (advanced && (planToggle.checked || submissionServers.length || submissionTools.length)) {
        throw new Error("Piano, MCP e tool specifici richiedono lo streaming; richiesta non inviata");
      }
      const res = await fetch("/api/chat", { method: "POST", body: formData });
      data = await readApiResponse(res);
      if (res.status === 401) { window.location.href = "/login.html"; return; }
      if (!res.ok) throw Object.assign(new Error(data.error || "Errore sconosciuto"), { chat_id: data.chat_id, usage: data.usage });
    }
    pending.remove();
    if (data.chat_id) {
      currentChatId = data.chat_id;
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
    const reply = addMessage(data.reply || "", "bot", data.model, data.ts);
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
      syncToolControls();
      if (err.usage) chatUsages.set(currentChatId, err.usage);
      renderChatUsage();
    }
    loadChatList();
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
    input.focus();
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
  currentChatId = null;
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

loadChatList();
syncAdvancedMode();
