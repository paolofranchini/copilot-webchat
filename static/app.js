const messagesEl = document.getElementById("messages");
const form = document.getElementById("chatForm");
const input = document.getElementById("input");
const sendBtn = document.getElementById("sendBtn");
const newChatBtn = document.getElementById("newChatBtn");
const settingsBtn = document.getElementById("settingsBtn");
const settingsView = document.getElementById("settingsView");
const chatView = document.getElementById("chatView");
const logoutBtn = document.getElementById("logoutBtn");
const chatListEl = document.getElementById("chatList");
const sidebar = document.getElementById("sidebar");
const menuBtn = document.getElementById("menuBtn");
const closeSidebarBtn = document.getElementById("closeSidebarBtn");
const modelSelect = document.getElementById("modelSelect");
const chatUsageEl = document.getElementById("chatUsage");
const permissionModeSelects = document.querySelectorAll("[data-permission-mode]");
const attachmentBtn = document.getElementById("attachmentBtn");
const attachmentPicker = document.getElementById("attachmentPicker");
const attachmentInput = document.getElementById("attachmentInput");
const attachmentDropzone = document.getElementById("attachmentDropzone");
const attachmentPreviews = document.getElementById("attachmentPreviews");
const chatNotice = document.getElementById("chatNotice");
const mcpConfigList = document.getElementById("mcpConfigList");
const skillsList = document.getElementById("skillsList");
const slashSuggestions = document.getElementById("slashSuggestions");

let currentChatId = null;
let pendingChatId = null;
let attachedFiles = [];
let busy = false;
let mcpServers = [];
let pendingPlan = false;
let activeJob = null;
let jobController = null;
let wakeJob = null;
let lastPermissionMode = "ask";
let chatOpenRequest = 0;
const chatPermissions = new Map();
const chatUsages = new Map();
const chatPlans = new Map();
const chatModels = new Map();
const mobileLayout = window.matchMedia("(max-width: 700px)");
localStorage.removeItem("copilot-auto-model-responses");

function showNotice(message) {
  chatNotice.textContent = message;
  chatNotice.hidden = !message;
}

function syncChatFeatures() {
  if (pendingPlan && currentChatId
    && !messagesEl.querySelector(".plan-actions")) {
    const planMessage = messagesEl.querySelector(".pending-plan-message");
    if (planMessage) attachPlanActions(planMessage);
  }
  loadMcpServers();
  loadSkills();
  updateSlashSuggestions();
}

function syncSidebarWithViewport() {
  if (mobileLayout.matches) {
    sidebar.classList.add("hidden");
  } else {
    sidebar.classList.remove("hidden");
  }
}

function syncAppHeight() {
  const viewport = window.visualViewport;
  if (mobileLayout.matches && viewport && viewport.height > 0) {
    document.documentElement.style.setProperty("--app-height", `${viewport.height}px`);
  } else {
    document.documentElement.style.removeProperty("--app-height");
  }
}

syncSidebarWithViewport();
syncAppHeight();
mobileLayout.addEventListener("change", syncSidebarWithViewport);
mobileLayout.addEventListener("change", syncAppHeight);
window.visualViewport?.addEventListener("resize", syncAppHeight);
window.addEventListener("resize", syncAppHeight);

function setModelControls(model, isChat = Boolean(currentChatId)) {
  if (![...modelSelect.options].some((option) => option.value === model)) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    modelSelect.append(option);
  }
  modelSelect.value = model;
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
    const model = modelSelect.value || selectedModel;
    modelSelect.replaceChildren();
    for (const id of data.models) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = id === "auto" ? "Auto" : id;
      modelSelect.append(option);
    }
    if (!data.models.includes(model)) {
      const option = document.createElement("option");
      option.value = model;
      option.textContent = model;
      modelSelect.append(option);
    }
    modelSelect.value = model;
    modelSelect.disabled = false;
    setModelControls(selectedModel, Boolean(currentChatId));
    showNotice("");
  } catch (err) {
    modelSelect.disabled = true;
    showNotice(err.message);
  }
}
let modelUpdating = false;
modelSelect.addEventListener("change", async () => {
  if (modelUpdating) return;
  const previousDefault = localStorage.getItem("copilot-model") || "auto";
  const previousSelection = modelSelect.value;
  const model = modelSelect.value;
  setModelControls(model);
  localStorage.setItem("copilot-model", model);
  if (!currentChatId) return;

  const chatId = currentChatId;
  modelUpdating = true;
  modelSelect.disabled = true;
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
    modelSelect.disabled = false;
  }
});

function showSettings(open) {
  if (open) chatOpenRequest += 1;
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
  const selectedMode = permissionModeSelects[0]?.value || "ask";
  const mode = selectedMode === "plan" ? lastPermissionMode : selectedMode;
  if (mode === "agent") return ["all"];
  if (mode === "edit") return ["shell", "write"];
  return [];
}

function syncPermissions(permissions) {
  lastPermissionMode = permissions.includes("all")
    ? "agent"
    : permissions.includes("shell") || permissions.includes("write") ? "edit" : "ask";
  permissionModeSelects.forEach((select) => { select.value = lastPermissionMode; });
}

permissionModeSelects.forEach((select) => {
  select.addEventListener("change", async () => {
    const mode = select.value;
    if (mode === "plan") {
      showNotice("");
      return;
    }
    lastPermissionMode = mode;
    const previous = currentChatId ? (chatPermissions.get(currentChatId) || []) : null;
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
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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

function displayUserMessage(text) {
  return text === "Analizza i file allegati.\n🖼️" ? "🖼️" : text;
}

function addMessage(text, cls, model, ts, usage, attachments = [], autoModel = false) {
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
    const imageFiles = attachments.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length) {
      const previews = document.createElement("div");
      previews.className = "message-attachment-previews";
      imageFiles.forEach((file) => {
        const image = document.createElement("img");
        const imageUrl = URL.createObjectURL(file);
        image.src = imageUrl;
        image.alt = file.name;
        image.addEventListener("load", () => URL.revokeObjectURL(imageUrl), { once: true });
        image.addEventListener("error", () => URL.revokeObjectURL(imageUrl), { once: true });
        previews.appendChild(image);
      });
      el.appendChild(previews);
    }
  }
  if (!cls.includes("pending") && !cls.includes("error")) {
    const metadata = document.createElement("div");
    metadata.className = "msg-metadata";
    if (model) {
      const tag = document.createElement("span");
      tag.className = "model-tag";
      tag.textContent = `${model}${autoModel ? " (Auto)" : ""}`;
      tag.title = tag.textContent;
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
input.addEventListener("paste", (event) => {
  const supportedExtensions = {
    "image/avif": "avif",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };
  const imageFiles = Array.from(event.clipboardData?.items || [])
    .filter((item) => item.kind === "file" && supportedExtensions[item.type])
    .map((item, index) => {
      const file = item.getAsFile();
      if (!file) return null;
      return new File([file], `immagine-incollata-${Date.now()}-${index + 1}.${supportedExtensions[item.type]}`, {
        type: item.type,
        lastModified: Date.now(),
      });
    })
    .filter(Boolean);
  if (!imageFiles.length) return;

  event.preventDefault();
  const pastedText = event.clipboardData.getData("text/plain");
  if (pastedText) {
    input.setRangeText(pastedText, input.selectionStart, input.selectionEnd, "end");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  addAttachments(imageFiles);
  attachmentPicker.hidden = false;
  attachmentBtn.setAttribute("aria-expanded", "true");
});
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
  const commands = [
    "/help", "/usage", "/model ",
    "/chronicle standup", "/chronicle tips", "/chronicle cost-tips",
    "/chronicle search ", "/chronicle improve",
  ];
  const matches = value.startsWith("/")
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

function chroniclePrompt(text) {
  const match = text.trim().match(/^\/chronicle\s+(\S+)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const [, subcommand, context = ""] = match;
  const detail = context.trim();
  switch (subcommand.toLowerCase()) {
    case "standup":
      return `Using my GitHub Copilot CLI session history, generate a concise standup report${detail ? ` focused on ${detail}` : " for the last 24 hours"}. Group completed and in-progress work, and identify the relevant repository, branch, and sessions where available.`;
    case "tips":
      return `Analyze my recent GitHub Copilot CLI sessions and give me 3–5 personalized recommendations based on my usage patterns${detail ? `, focusing on ${detail}` : ""}. Ground each recommendation in observed behavior.`;
    case "cost-tips":
      return `Analyze token and AI-credit usage across my recent GitHub Copilot CLI sessions and suggest practical ways to reduce cost${detail ? `, focusing on ${detail}` : ""}. Base the advice on observed usage patterns.`;
    case "search":
      return detail
        ? `Search my GitHub Copilot CLI session history for these terms or topics: ${detail}. Summarize relevant sessions and include dates, repository, or session names when available.`
        : null;
    case "improve":
      return `Analyze my GitHub Copilot CLI session history${detail ? `, focusing on ${detail}` : ""}, for recurring friction that could be addressed by improving this repository's Copilot instructions. Suggest 3–5 specific additions, but do not modify any files.`;
    default:
      return null;
  }
}

function renderMcpServers() {
  mcpConfigList.replaceChildren();
  for (const server of mcpServers) {
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

async function loadChatList() {
  const res = await fetch("/api/chats");
  if (res.status === 401) { window.location.href = "/login.html"; return; }
  if (!res.ok) return;
  const chats = await res.json();
  for (const chat of chats) chatModels.set(chat.id, chat.model);
  if (currentChatId) {
    setModelControls(chatModels.get(currentChatId) || modelSelect.value, true);
  }
  for (const chat of chats) chatUsages.set(chat.id, chat.usage);
  renderChatUsage();
  chatListEl.innerHTML = "";
  for (const c of chats) {
    chatPermissions.set(c.id, c.permissions || []);
    chatUsages.set(c.id, c.usage);
    chatPlans.set(c.id, !!c.pending_plan);
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
    pendingPlan = false;
    renderMcpServers();
    messagesEl.innerHTML = "";
    renderChatUsage();
  }
  chatUsages.delete(chatId);
  chatPlans.delete(chatId);
  chatModels.delete(chatId);
  loadChatList();
}

async function openChat(chatId, refresh = false) {
  const request = ++chatOpenRequest;
  const res = await fetch(`/api/chats/${chatId}`);
  if (res.status === 401) { window.location.href = "/login.html"; return; }
  if (!res.ok) return false;
  const msgs = await res.json();
  if (request !== chatOpenRequest) return false;
  pendingChatId = null;
  currentChatId = chatId;
  sessionStorage.setItem("copilot-current-chat", chatId);
  setModelControls(chatModels.get(chatId) || localStorage.getItem("copilot-model") || "auto", true);
  showSettings(false);
  pendingPlan = chatPlans.get(chatId) || false;
  renderMcpServers();
  renderChatUsage();
  syncPermissions(chatPermissions.get(chatId) || []);
  messagesEl.innerHTML = "";
  const lastPlanIndex = msgs.findLastIndex((message) => message.role === "plan");
  for (const [index, m] of msgs.entries()) {
    const content = m.role === "user" ? displayUserMessage(m.content) : m.content;
    const element = addMessage(
      content, m.role === "user" ? "user" : "bot", m.model, m.ts, m.usage, [],
      m.auto_model === true,
    );
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
  if (element.querySelector(".plan-actions")) return;
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
        const actionChatId = currentChatId;
        const data = await jsonRequest(path, "POST", {});
        placeholder?.remove();
        actions.remove();
        if (actionChatId) chatPlans.set(actionChatId, false);
        if (data.usage && actionChatId) chatUsages.set(actionChatId, data.usage);
        if (currentChatId === actionChatId) {
          pendingPlan = false;
          if (data.reply) addMessage(data.reply, "bot", data.model, data.ts, data.message_usage);
          renderChatUsage();
        }
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
  if (container.isConnected) messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function streamChat(formData, pending, activity) {
  formData.append("async", "true");
  formData.append("request_id", activeJob.id);
  await startJobRequest("/api/chat/stream", { method: "POST", body: formData });
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
  attachmentBtn.disabled = value;
  document.querySelectorAll(".plan-actions button").forEach((button) => { button.disabled = value; });
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
    rememberJob();
    if (currentChatId === activeJob.chat_id
      || (!currentChatId && pendingChatId === activeJob.chat_id)) {
      showNotice("");
    }
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
  const chatId = currentChatId;
  setChatBusy(true);
  activeJob = {
    id: newRequestId(), chat_id: chatId, accepted: false,
    autoModel: modelSelect.value === "auto",
  };
  rememberJob();
  const pending = addMessage("Copilot sta eseguendo il piano...", "bot pending");
  const activity = document.createElement("div");
  messagesEl.append(activity);
  try {
    await startJobRequest("/api/chat/plan/approve", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ async: true, request_id: activeJob.id, chat_id: chatId }),
    });
    const data = await waitForJob(pending, activity);
    chatPlans.set(chatId, false);
    if (currentChatId === chatId) pendingPlan = false;
    await loadChatList();
    if (currentChatId === chatId && settingsView.hidden) {
      await openChat(chatId, true);
    }
  } catch (err) {
    showNotice(err.message);
  } finally {
    pending.remove();
    activity.remove();
    setChatBusy(false);
  }
}

async function sendCommand(text) {
  if (/^\/chronicle(?:\s*)$/i.test(text)) {
    addMessage("Sottocomandi disponibili: /chronicle standup, /chronicle tips, /chronicle cost-tips, /chronicle search <termine>, /chronicle improve. /chronicle reindex richiede la CLI interattiva.", "bot");
    return true;
  }
  if (/^\/chronicle\s+reindex(?:\s|$)/i.test(text)) {
    addMessage("/chronicle reindex richiede la CLI interattiva e non è disponibile nella webchat.", "bot");
    return true;
  }
  if (/^\/chronicle\b/i.test(text) && !chroniclePrompt(text)) {
    addMessage("Sottocomando /chronicle non valido. Usa /chronicle per vedere quelli disponibili; /chronicle search richiede un termine.", "error");
    return true;
  }
  const command = text.match(/^\/(help|usage)(?:\s*)$/i) || text.match(/^\/model\s+(\S+)\s*$/i);
  if (!command) return false;
  const data = await jsonRequest("/api/command", "POST", { command: text });
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
  const submittedChatId = currentChatId || pendingChatId;
  const submittedWithoutChat = !submittedChatId;
  let responseChatId = submittedChatId;
  const submittedModel = modelSelect.value;
  const submittedPermissions = selectedPermissions();
  const isSubmittedChatSelected = (chatId) => currentChatId === chatId
    || (!currentChatId && pendingChatId === chatId)
    || (submittedWithoutChat && !currentChatId && !pendingChatId);
  const submittedFiles = attachedFiles;
  const imageFiles = submittedFiles.filter((file) => file.type.startsWith("image/"));
  const prompt = imageFiles.length
    ? `${text || "Analizza i file allegati."}\n🖼️`
    : chroniclePrompt(text) || text;

  busy = true;
  renderMcpServers();
  sendBtn.disabled = true;
  attachmentBtn.disabled = true;
  const requestedPlan = permissionModeSelects[0]?.value === "plan";
  const isCommand = attachedFiles.length === 0
    && (/^\/(help|usage)\s*$/i.test(text) || /^\/model\s+\S+\s*$/i.test(text)
      || /^\/chronicle(?:\s*)$/i.test(text) || /^\/chronicle\s+reindex(?:\s|$)/i.test(text)
      || /^\/chronicle\s+search\s*$/i.test(text)
      || (/^\/chronicle\b/i.test(text) && !chroniclePrompt(text)));
  const displayText = text || (imageFiles.length ? "" : `[Allegati ${submittedFiles.length} file]`);
  addMessage(displayText, "user", null, new Date().toISOString(), null, submittedFiles);
  // Il testo è già stato acquisito per la richiesta; svuota il campo anche se
  // la risposta fallisce o lo streaming si interrompe.
  input.value = "";
  autoResize();
  attachedFiles = [];
  renderAttachmentPreviews();
  attachmentPicker.hidden = true;
  attachmentBtn.setAttribute("aria-expanded", "false");
  const activity = document.createElement("div");
  activity.className = "activity-log";
  if (!isCommand) messagesEl.append(activity);
  const pending = isCommand ? null : addMessage("Copilot sta pensando...", "bot pending");

  try {
    if (isCommand) {
      await sendCommand(text);
      return;
    }
    const formData = new FormData();
    formData.append("message", prompt);
    formData.append("chat_id", submittedChatId || "");
    formData.append("model", submittedModel);
    formData.append("permissions", JSON.stringify(submittedPermissions));
    formData.append("mcp_servers", "[]");
    formData.append("tool_permissions", "[]");
    if (requestedPlan) formData.append("plan", "true");
    submittedFiles.forEach((file) => formData.append("files", file));
    activeJob = {
      id: newRequestId(), chat_id: submittedChatId, accepted: false,
      text: prompt || `[Allegati ${submittedFiles.length} file]`,
    };
    rememberJob();
    const data = await streamChat(formData, pending, activity);
    pending.remove();
    responseChatId = data.chat_id || responseChatId;
    if (data.chat_id) {
      const responseChatId = data.chat_id;
      const chatSelected = isSubmittedChatSelected(responseChatId);
      chatModels.set(responseChatId, data.model || submittedModel);
      chatUsages.set(responseChatId, data.usage);
      chatPermissions.set(responseChatId, submittedPermissions);
      chatPlans.set(responseChatId, !!data.pending_plan);
      if (chatSelected) {
        currentChatId = responseChatId;
        pendingChatId = null;
        sessionStorage.setItem("copilot-current-chat", responseChatId);
        setModelControls(data.model || submittedModel, true);
        pendingPlan = !!data.pending_plan;
        renderMcpServers();
        renderChatUsage();
      }
      loadChatList();
    }
    if (isSubmittedChatSelected(data.chat_id)) {
      if (requestedPlan) permissionModeSelects[0].value = lastPermissionMode;
      const reply = addMessage(
        data.reply || "", "bot", data.model, data.ts, data.message_usage, [],
        data.auto_model === true,
      );
      if (pendingPlan) {
        reply.classList.add("pending-plan-message");
        attachPlanActions(reply);
      }
    }
    if (isSubmittedChatSelected(data.chat_id)) {
      showNotice("");
    }
  } catch (err) {
    pending?.remove();
    // Il messaggio dell'utente resta visibile anche in caso di errore: viene
    // salvato lato server prima di invocare Copilot, quindi rimuoverlo dalla UI
    // sarebbe fuorviante (l'invio è comunque avvenuto).
    const errorChatId = err.chat_id || submittedChatId;
    responseChatId = errorChatId;
    const chatSelected = isSubmittedChatSelected(errorChatId);
    if (err.chat_id && err.usage) chatUsages.set(err.chat_id, err.usage);
    if (chatSelected && err.chat_id) {
      currentChatId = err.chat_id;
      pendingChatId = null;
      setModelControls(chatModels.get(err.chat_id) || submittedModel, true);
      renderChatUsage();
    }
    loadChatList();
    if (err.unconfirmed) {
      showNotice(err.message);
      return;
    }
    if (!chatSelected) {
      showNotice(`Errore nella chat in background: ${err.message}`);
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
    busy = false;
    renderMcpServers();
    sendBtn.disabled = false;
    attachmentBtn.disabled = false;
    updateSlashSuggestions();
    if (!document.hidden && settingsView.hidden && isSubmittedChatSelected(responseChatId)) {
      input.focus();
    }
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
  chatOpenRequest += 1;
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
  showSettings(false);
  pendingPlan = false;
  renderMcpServers();
  renderChatUsage();
  syncPermissions([]);
  messagesEl.innerHTML = "";
  sidebar.classList.add("hidden");
  loadChatList();
  syncChatFeatures();
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
    if (!restored && activeJob.text) addMessage(displayUserMessage(activeJob.text), "user");
    const pending = addMessage("Copilot sta pensando...", "bot pending");
    const activity = document.createElement("div");
    messagesEl.append(activity);
    try {
      const data = await waitForJob(pending, activity);
      await loadChatList();
      const chatIsSelected = currentChatId === data.chat_id
        || (!restored && !currentChatId && !pendingChatId);
      if (chatIsSelected && settingsView.hidden) {
        await openChat(data.chat_id, true);
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
        await loadChatList();
        if (currentChatId === data.chat_id && settingsView.hidden) {
          await openChat(data.chat_id, true);
        }
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
syncChatFeatures();
