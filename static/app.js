const messagesEl = document.getElementById("messages");
const form = document.getElementById("chatForm");
const input = document.getElementById("input");
const sendBtn = document.getElementById("sendBtn");
const newChatBtn = document.getElementById("newChatBtn");
const logoutBtn = document.getElementById("logoutBtn");
const chatListEl = document.getElementById("chatList");
const sidebar = document.getElementById("sidebar");
const menuBtn = document.getElementById("menuBtn");

let currentChatId = null;

function addMessage(text, cls, model) {
  const el = document.createElement("div");
  el.className = `msg ${cls}`;
  el.textContent = text;
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
    const item = document.createElement("div");
    item.className = "chat-item" + (c.id === currentChatId ? " active" : "");
    item.textContent = c.title || "(senza titolo)";
    item.addEventListener("click", () => openChat(c.id));
    chatListEl.appendChild(item);
  }
}

async function openChat(chatId) {
  const res = await fetch(`/api/chats/${chatId}`);
  if (!res.ok) return;
  const msgs = await res.json();
  currentChatId = chatId;
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
      body: JSON.stringify({ message: text }),
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

loadChatList();
