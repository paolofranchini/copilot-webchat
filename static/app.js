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
const permissionInputs = document.querySelectorAll("[data-permission]");

let currentChatId = null;
const chatPermissions = new Map();
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

modelSelect.value = localStorage.getItem("copilot-model") || "auto";
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

function autoResize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 140) + "px";
}
input.addEventListener("input", autoResize);

async function loadChatList() {
  const res = await fetch("/api/chats");
  if (!res.ok) return;
  const chats = await res.json();
  chatListEl.innerHTML = "";
  for (const c of chats) {
    chatPermissions.set(c.id, c.permissions || []);
    const item = document.createElement("div");
    item.className = "chat-item" + (c.id === currentChatId ? " active" : "");
    const title = document.createElement("span");
    title.className = "chat-title";
    title.textContent = c.title || "(senza titolo)";
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "delete-chat-btn";
    deleteBtn.type = "button";
    deleteBtn.title = "Elimina chat";
    deleteBtn.setAttribute("aria-label", `Elimina chat ${c.title || ""}`);
    deleteBtn.textContent = "🗑";
    deleteBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteChat(c.id);
    });
    item.append(title, deleteBtn);
    item.addEventListener("click", () => openChat(c.id));
    chatListEl.appendChild(item);
  }
}

async function deleteChat(chatId) {
  if (!window.confirm("Eliminare questa chat?")) return;
  const res = await fetch(`/api/chats/${chatId}`, { method: "DELETE" });
  if (!res.ok) return;
  if (currentChatId === chatId) {
    currentChatId = null;
    messagesEl.innerHTML = "";
  }
  loadChatList();
}

async function openChat(chatId) {
  const res = await fetch(`/api/chats/${chatId}`);
  if (!res.ok) return;
  const msgs = await res.json();
  currentChatId = chatId;
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
  if (!text) return;

  addMessage(text, "user");
  input.value = "";
  autoResize();
  sendBtn.disabled = true;

  const pending = addMessage("Copilot sta pensando...", "bot pending");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        model: modelSelect.value,
        permissions: selectedPermissions(),
      }),
    });
    const data = await res.json();
    pending.remove();
    if (res.status === 401) {
      window.location.href = "/login.html";
      return;
    }
    if (!res.ok) {
      addMessage(data.error || "Errore sconosciuto", "error");
    } else {
      addMessage(data.reply, "bot", data.model);
      currentChatId = data.chat_id;
      chatPermissions.set(currentChatId, selectedPermissions());
      loadChatList();
    }
  } catch (err) {
    pending.remove();
    addMessage("Errore di rete: " + err.message, "error");
  } finally {
    sendBtn.disabled = false;
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
