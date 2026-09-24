const messagesEl = document.getElementById("messages");
const form = document.getElementById("chatForm");
const input = document.getElementById("input");
const sendBtn = document.getElementById("sendBtn");
const newChatBtn = document.getElementById("newChatBtn");
const logoutBtn = document.getElementById("logoutBtn");
const chatListEl = document.getElementById("chatList");
const sidebar = document.getElementById("sidebar");
const menuBtn = document.getElementById("menuBtn");
const closeSidebarBtn = document.getElementById("closeSidebarBtn");
const modelSelect = document.getElementById("modelSelect");
const chatUsageEl = document.getElementById("chatUsage");
const permissionInputs = document.querySelectorAll("[data-permission]");
const attachmentBtn = document.getElementById("attachmentBtn");
const attachmentPicker = document.getElementById("attachmentPicker");
const attachmentInput = document.getElementById("attachmentInput");
const attachmentDropzone = document.getElementById("attachmentDropzone");
const attachmentPreviews = document.getElementById("attachmentPreviews");

let currentChatId = null;
let attachedImages = [];
const chatPermissions = new Map();
const chatUsages = new Map();
const mobileLayout = window.matchMedia("(max-width: 700px)");

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
localStorage.setItem("copilot-model", modelSelect.value);
modelSelect.addEventListener("change", () => {
  localStorage.setItem("copilot-model", modelSelect.value);
});

function selectedPermissions() {
  return [...new Set([...permissionInputs]
    .filter((input) => input.checked)
    .map((input) => input.dataset.permission))];
}

permissionInputs.forEach((input) => {
  input.addEventListener("change", async () => {
    permissionInputs.forEach((otherInput) => {
      if (input.dataset.permission === "all") {
        if (otherInput !== input) otherInput.checked = false;
      } else if (otherInput.dataset.permission === "all") {
        otherInput.checked = false;
      }
    });
    const permissions = selectedPermissions();
    if (currentChatId) {
      chatPermissions.set(currentChatId, permissions);
      await fetch(`/api/chats/${currentChatId}/permissions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissions }),
      });
    }
  });
});

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

function addMessage(text, cls, model) {
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
  attachedImages.forEach((file, index) => {
    const preview = document.createElement("div");
    preview.className = "attachment-preview";
    const image = document.createElement("img");
    image.src = URL.createObjectURL(file);
    image.alt = file.name;
    image.onload = () => URL.revokeObjectURL(image.src);
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.setAttribute("aria-label", `Rimuovi ${file.name}`);
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => {
      attachedImages.splice(index, 1);
      renderAttachmentPreviews();
    });
    preview.append(image, removeBtn);
    attachmentPreviews.appendChild(preview);
  });
}

function addAttachments(files) {
  const images = [...files].filter((file) => file.type.startsWith("image/"));
  attachedImages = [...attachedImages, ...images].slice(0, 5);
  attachmentInput.value = "";
  renderAttachmentPreviews();
}

attachmentBtn.addEventListener("click", () => {
  attachmentPicker.hidden = !attachmentPicker.hidden;
  attachmentBtn.setAttribute("aria-expanded", String(!attachmentPicker.hidden));
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

async function loadChatList() {
  const res = await fetch("/api/chats");
  if (!res.ok) return;
  const chats = await res.json();
  chatListEl.innerHTML = "";
  for (const c of chats) {
    chatPermissions.set(c.id, c.permissions || []);
    chatUsages.set(c.id, c.usage);
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
  const data = await res.json();
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
    messagesEl.innerHTML = "";
    renderChatUsage();
  }
  chatUsages.delete(chatId);
  loadChatList();
}

async function openChat(chatId) {
  const res = await fetch(`/api/chats/${chatId}`);
  if (!res.ok) return;
  const msgs = await res.json();
  currentChatId = chatId;
  renderChatUsage();
  permissionInputs.forEach((input) => {
    input.checked = (chatPermissions.get(chatId) || []).includes(input.dataset.permission);
  });
  messagesEl.innerHTML = "";
  for (const m of msgs) {
    addMessage(m.content, m.role === "user" ? "user" : "bot", m.model);
  }
  sidebar.classList.add("hidden");
  loadChatList();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text && attachedImages.length === 0) return;

  addMessage(text || `[Allegate ${attachedImages.length} immagini]`, "user");
  input.value = "";
  autoResize();
  sendBtn.disabled = true;
  attachmentBtn.disabled = true;

  const pending = addMessage("Copilot sta pensando...", "bot pending");

  try {
    const formData = new FormData();
    formData.append("message", text);
    formData.append("model", modelSelect.value);
    formData.append("permissions", JSON.stringify(selectedPermissions()));
    attachedImages.forEach((file) => formData.append("images", file));
    const res = await fetch("/api/chat", {
      method: "POST",
      body: formData,
    });
    const data = await res.json();
    pending.remove();
    if (res.status === 401) {
      window.location.href = "/login.html";
      return;
    }
    if (data.chat_id) {
      currentChatId = data.chat_id;
      chatUsages.set(currentChatId, data.usage);
      renderChatUsage();
      loadChatList();
    }
    if (!res.ok) {
      addMessage(data.error || "Errore sconosciuto", "error");
    } else {
      addMessage(data.reply, "bot", data.model);
      chatPermissions.set(currentChatId, selectedPermissions());
    }
  } catch (err) {
    pending.remove();
    addMessage("Errore di rete: " + err.message, "error");
  } finally {
    sendBtn.disabled = false;
    attachmentBtn.disabled = false;
    attachedImages = [];
    renderAttachmentPreviews();
    input.focus();
  }
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

newChatBtn.addEventListener("click", async () => {
  await fetch("/api/new-chat", { method: "POST" });
  currentChatId = null;
  renderChatUsage();
  permissionInputs.forEach((input) => {
    input.checked = false;
  });
  messagesEl.innerHTML = "";
  sidebar.classList.add("hidden");
  loadChatList();
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
