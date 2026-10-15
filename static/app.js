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
const modelSelect = document.getElementById("modelSelect");
const providerSelect = document.getElementById("providerSelect");
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
const notificationToggle = document.getElementById("notificationToggle");
const notificationTest = document.getElementById("notificationTest");
const notificationStatus = document.getElementById("notificationStatus");

let currentChatId = null;
let currentChatProvider = null;
let pendingChatId = null;
let pendingChatProvider = "cli";
let attachedFiles = [];
let busy = false;
let mcpServers = [];
let pendingPlan = false;
const activeJobs = new Map();
const jobControllers = new Map();
const wakeJobs = new Map();
let lastPermissionMode = "ask";
let chatOpenRequest = 0;
const chatPermissions = new Map();
const chatUsages = new Map();
const chatPlans = new Map();
const chatModels = new Map();
const chatProviders = new Map();
const mobileLayout = window.matchMedia("(max-width: 700px)");
const NOTIFICATIONS_STORAGE_KEY = "copilot-response-notifications";
const notificationChatId = new URLSearchParams(window.location.search).get("chat");
if (notificationChatId && /^[a-zA-Z0-9_-]{1,128}$/.test(notificationChatId)) {
  sessionStorage.setItem("copilot-notification-chat", notificationChatId);
}
localStorage.removeItem("copilot-auto-model-responses");

function updateNotificationSettings() {
  const supported = "Notification" in window && "serviceWorker" in navigator
    && window.isSecureContext;
  const enabled = localStorage.getItem(NOTIFICATIONS_STORAGE_KEY) === "enabled";
  notificationToggle.disabled = !supported;
  notificationTest.disabled = !supported || !enabled || Notification.permission !== "granted";
  notificationToggle.textContent = enabled ? "Disattiva notifiche" : "Attiva notifiche";
  if (!supported) {
    notificationStatus.textContent = "Notifiche non supportate in questo browser o contesto.";
  } else if (Notification.permission === "denied") {
    notificationStatus.textContent = "Permesso negato: abilita le notifiche nelle impostazioni del browser.";
  } else if (enabled && Notification.permission === "granted") {
    notificationStatus.textContent = "Notifiche attive per le chat non visibili.";
  } else if (Notification.permission === "granted") {
    notificationStatus.textContent = "Permesso concesso: attiva le notifiche per riceverle.";
  } else {
    notificationStatus.textContent = "Le notifiche richiedono il permesso del browser.";
  }
}

async function setNotificationsEnabled(enabled) {
  if (enabled) {
    if (!("Notification" in window) || !("serviceWorker" in navigator)
      || !window.isSecureContext) {
      updateNotificationSettings();
      return;
    }
    const permission = Notification.permission === "default"
      ? await Notification.requestPermission()
      : Notification.permission;
    if (permission !== "granted") {
      localStorage.removeItem(NOTIFICATIONS_STORAGE_KEY);
      updateNotificationSettings();
      return;
    }
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, "enabled");
  } else {
    localStorage.removeItem(NOTIFICATIONS_STORAGE_KEY);
  }
  updateNotificationSettings();
}

notificationToggle.addEventListener("click", async () => {
  notificationToggle.disabled = true;
  try {
    await setNotificationsEnabled(
      localStorage.getItem(NOTIFICATIONS_STORAGE_KEY) !== "enabled",
    );
  } catch (error) {
    notificationStatus.textContent = `Impossibile aggiornare le notifiche: ${error.message}`;
  } finally {
    updateNotificationSettings();
  }
});
updateNotificationSettings();

async function sendTestNotification() {
  const registration = await navigator.serviceWorker.ready;
  await registration.showNotification("Notifica di prova", {
    body: "Le notifiche di Copilot CLI Webchat funzionano.",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: `notification-test-${Date.now()}`,
    requireInteraction: false,
  });
}

notificationTest.addEventListener("click", async () => {
  notificationTest.disabled = true;
  try {
    await sendTestNotification();
    notificationStatus.textContent = "Notifica di prova inviata.";
  } catch (error) {
    notificationStatus.textContent = `Impossibile inviare la notifica di prova: ${error.message}`;
  } finally {
    updateNotificationSettings();
  }
});

async function notifyResponseReady(chatId, isPlan = false) {
  const selectedChatId = currentChatId || pendingChatId;
  const responseIsVisible = !document.hidden && settingsView.hidden
    && selectedChatId === chatId;
  if (responseIsVisible || !chatId
    || localStorage.getItem(NOTIFICATIONS_STORAGE_KEY) !== "enabled"
    || !("Notification" in window) || Notification.permission !== "granted"
    || !("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification(isPlan ? "Piano pronto" : "Risposta pronta", {
      body: "Tocca per aprire la chat.",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: `chat-response-${chatId}-${Date.now()}`,
      renotify: false,
      requireInteraction: false,
      data: { chatId },
    });
  } catch (error) {
    console.error("Invio notifica risposta non riuscito:", error);
  }
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "open-chat" && typeof event.data.chatId === "string") {
      openChat(event.data.chatId, true);
    }
  });
}

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

function isSidebarCloseSwipe(startX, startY, endX, endY) {
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  return deltaX <= -72 && Math.abs(deltaX) > Math.abs(deltaY) * 1.25;
}

function isSidebarOutsideTap(target, isMobile, sidebarIsOpen, sidebarElement, menuButton) {
  return isMobile && sidebarIsOpen
    && !sidebarElement.contains(target) && !menuButton.contains(target);
}

document.addEventListener("pointerdown", (event) => {
  if (isSidebarOutsideTap(
    event.target,
    mobileLayout.matches,
    !sidebar.classList.contains("hidden"),
    sidebar,
    menuBtn,
  )) {
    sidebar.classList.add("hidden");
  }
});

let sidebarTouchStart = null;
sidebar.addEventListener("touchstart", (event) => {
  if (!mobileLayout.matches || sidebar.classList.contains("hidden")
    || event.touches.length !== 1) {
    sidebarTouchStart = null;
    return;
  }
  const touch = event.touches[0];
  sidebarTouchStart = { x: touch.clientX, y: touch.clientY };
}, { passive: true });
sidebar.addEventListener("touchend", (event) => {
  if (!sidebarTouchStart || !mobileLayout.matches || event.changedTouches.length !== 1) {
    sidebarTouchStart = null;
    return;
  }
  const start = sidebarTouchStart;
  sidebarTouchStart = null;
  const touch = event.changedTouches[0];
  if (isSidebarCloseSwipe(start.x, start.y, touch.clientX, touch.clientY)) {
    sidebar.classList.add("hidden");
  }
}, { passive: true });
sidebar.addEventListener("touchcancel", () => {
  sidebarTouchStart = null;
}, { passive: true });

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

const directlineForm = document.getElementById("directlineForm");
const directlineSecret = document.getElementById("directlineSecret");
const directlineStatus = document.getElementById("directlineStatus");
const saveDirectlineSecret = document.getElementById("saveDirectlineSecret");
const removeDirectlineSecret = document.getElementById("removeDirectlineSecret");

async function loadDirectlineSettings() {
  try {
    const response = await fetch("/api/directline/settings", { cache: "no-store" });
    if (response.status === 401) {
      window.location.href = "/login.html";
      return;
    }
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || `Errore HTTP ${response.status}`);
    directlineStatus.textContent = data.configured
      ? "Secret Direct Line salvato sul server."
      : "Nessun secret Direct Line configurato.";
    removeDirectlineSecret.hidden = !data.configured;
  } catch (error) {
    directlineStatus.textContent = error.message;
  }
}

directlineForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (window.location.protocol !== "https:") {
    directlineStatus.textContent = "Apri la webchat in HTTPS (porta 7891) prima di inserire il secret.";
    return;
  }
  saveDirectlineSecret.disabled = true;
  directlineStatus.textContent = "Salvataggio...";
  try {
    const response = await fetch("/api/directline/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: directlineSecret.value }),
    });
    if (response.status === 401) {
      window.location.href = "/login.html";
      return;
    }
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || `Errore HTTP ${response.status}`);
    directlineSecret.value = "";
    await loadDirectlineSettings();
  } catch (error) {
    directlineStatus.textContent = error.message;
  } finally {
    saveDirectlineSecret.disabled = false;
  }
});

removeDirectlineSecret.addEventListener("click", async () => {
  if (!window.confirm("Rimuovere il secret Direct Line salvato sul server?")) return;
  if (window.location.protocol !== "https:") {
    directlineStatus.textContent = "Apri la webchat in HTTPS (porta 7891) per rimuovere il secret.";
    return;
  }
  removeDirectlineSecret.disabled = true;
  try {
    const response = await fetch("/api/directline/settings", { method: "DELETE" });
    if (response.status === 401) {
      window.location.href = "/login.html";
      return;
    }
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || `Errore HTTP ${response.status}`);
    await loadDirectlineSettings();
  } catch (error) {
    directlineStatus.textContent = error.message;
  } finally {
    removeDirectlineSecret.disabled = false;
  }
});

loadDirectlineSettings();

const restartServiceBtn = document.getElementById("restartServiceBtn");
const restartServiceStatus = document.getElementById("restartServiceStatus");
restartServiceBtn.addEventListener("click", async () => {
  if (busy || activeJobs.size > 0) {
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

function prepareNewChatPermissions() {
  syncPermissions(selectedPermissions());
}

function setProviderControls(provider) {
  const studio = provider === "studio";
  providerSelect.value = provider;
  permissionModeSelects.forEach((select) => { select.disabled = studio; });
  document.getElementById("modelSettings").hidden = studio;
  attachmentBtn.hidden = studio;
  if (studio) {
    attachedFiles = [];
    attachmentPicker.hidden = true;
    attachmentBtn.setAttribute("aria-expanded", "false");
    renderAttachmentPreviews();
  }
}

function setModeSelection(provider, mode = "ask") {
  permissionModeSelects.forEach((select) => {
    select.value = provider === "studio" ? "ask" : mode;
  });
}

async function createNewChat(provider, mode) {
  chatOpenRequest += 1;
  storeVisibleJobState();
  try {
    const res = await fetch("/api/new-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider }),
    });
    const data = await readApiResponse(res);
    if (!res.ok) {
      showNotice(data.error || "Impossibile creare una nuova chat");
      const activeProvider = currentChatId
        ? chatProviders.get(currentChatId) || "cli"
        : pendingChatId ? pendingChatProvider : "cli";
      setModeSelection(activeProvider, lastPermissionMode);
      setProviderControls(activeProvider);
      return false;
    }
    if (!data.chat_id) {
      showNotice("Il server non ha restituito l'ID della nuova chat");
      return false;
    }
    pendingChatId = data.chat_id;
    pendingChatProvider = provider;
    currentChatProvider = provider;
    chatProviders.set(data.chat_id, provider);
    currentChatId = null;
    sessionStorage.removeItem("copilot-current-chat");
    setProviderControls(provider);
    setModeSelection(provider, mode || lastPermissionMode);
    setModelControls(localStorage.getItem("copilot-model") || "auto", false);
    showSettings(false);
    pendingPlan = false;
    renderMcpServers();
    renderChatUsage();
    if (provider === "cli") prepareNewChatPermissions();
    updateChatBusyState();
    messagesEl.replaceChildren();
    sidebar.classList.add("hidden");
    await loadChatList();
    syncChatFeatures();
    showNotice("");
    return true;
  } catch (error) {
    showNotice(error.message);
    const activeProvider = currentChatId
      ? chatProviders.get(currentChatId) || "cli"
      : pendingChatId ? pendingChatProvider : "cli";
    setModeSelection(activeProvider, lastPermissionMode);
    setProviderControls(activeProvider);
    return false;
  }
}

permissionModeSelects.forEach((select) => {
  select.addEventListener("change", async () => {
    const mode = select.value;
    const activeProvider = currentChatId
      ? chatProviders.get(currentChatId) || "cli"
      : pendingChatId ? pendingChatProvider : providerSelect.value;
    if (activeProvider === "studio") return;
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

providerSelect.addEventListener("change", async () => {
  const provider = providerSelect.value;
  const activeProvider = currentChatId
    ? chatProviders.get(currentChatId) || "cli"
    : pendingChatId ? pendingChatProvider : "cli";
  if (provider === activeProvider) return;
  const mode = activeProvider === "studio"
    ? lastPermissionMode
    : permissionModeSelects[0]?.value || lastPermissionMode;
  await createNewChat(provider, provider === "studio" ? "ask" : mode);
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

function markdownLinkUrl(source) {
  try {
    const url = new URL(
      source.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
    );
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return escapeHtml(url.href).replace(/"/g, "&quot;");
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
  const references = new Map();
  html = html.replace(
    /^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*<?(https?:\/\/[^>\s]+)>?(?:[ \t]+(?:"([^"\n]*)"|'([^'\n]*)'))?[ \t]*$/gim,
    (match, label, source, doubleQuotedTitle, singleQuotedTitle) => {
      const href = markdownLinkUrl(source);
      if (!href) return match;
      references.set(label.trim().toLowerCase().replace(/\s+/g, " "), {
        href,
        title: doubleQuotedTitle ?? singleQuotedTitle,
      });
      const title = doubleQuotedTitle ?? singleQuotedTitle;
      const titleText = title === undefined ? "" : ` "${title}"`;
      return protect(
        `[${label}]: <a class="markdown-link" href="${href}"${title === undefined ? "" : ` title="${title.replace(/"/g, "&quot;")}"`} target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${source}</a>${titleText}`,
      );
    },
  );
  const createLink = (label, reference) => {
    const title = reference.title === undefined
      ? ""
      : ` title="${reference.title.replace(/"/g, "&quot;")}"`;
    return protect(
      `<a class="markdown-link" href="${reference.href}"${title} target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${label}</a>`,
    );
  };
  html = html.replace(/\[([^\]\n]+)\]\[([^\]\n]*)\]/g, (match, label, referenceLabel) => {
    const key = (referenceLabel || label).trim().toLowerCase().replace(/\s+/g, " ");
    const reference = references.get(key);
    return reference ? createLink(label, reference) : match;
  });
  html = html.replace(/\[([^\]\n]+)\]\(\s*(<?https?:\/\/[^\s)>]+>?)(?:\s+["']([^"']*)["'])?\s*\)/g,
    (match, label, source, title) => {
      const href = markdownLinkUrl(source.replace(/^<|>$/g, ""));
      if (!href) return match;
      return createLink(label, { href, title });
    });
  html = html.replace(/\[([^\]\n]+)\]/g, (match, label) => {
    const key = label.trim().toLowerCase().replace(/\s+/g, " ");
    const reference = references.get(key);
    return reference ? createLink(label, reference) : match;
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

const thinkingPhrases = [
  "Metto insieme i pezzi",
  "Do un'occhiata in giro",
  "Raccolgo gli indizi",
  "Un attimo, sto verificando",
  "Ci sono quasi, rifinisco",
  "La risposta sta prendendo forma",
  "Consulto il mio criceto interiore",
  "Spolvero i circuiti",
  "Chiedo un parere al puntatore del mouse",
  "Faccio ordine nel cassetto delle idee",
  "Rimetto in riga qualche parentesi",
  "Cerco il bandolo del gomitolo",
  "La logica ha chiesto un caffè",
  "Sto contando fino a un numero ragionevole",
  "Faccio una riunione lampo con i bit",
  "Il criceto ha appena cambiato marcia",
  "Allineo i pianeti del codice",
  "Ripesco un pensiero caduto dietro la scrivania",
  "Metto il cappellino da detective",
  "Chiedo alla cache se si ricorda",
  "Controllo che le parentesi vadano d'accordo",
  "Sto negoziando con una virgola",
  "Le idee stanno facendo la fila",
  "Faccio amicizia con il problema",
  "Cerco di non svegliare i bug",
  "Un bit alla volta, senza spingere",
  "Sto lucidando la risposta",
  "Ho mandato un piccione ai neuroni",
  "Verifico che il piano non abbia i calzini spaiati",
  "Raccolgo le briciole di pane logiche",
  "La risposta sta cercando parcheggio",
  "Faccio un giro panoramico tra le possibilità",
  "Sto convincendo un punto e virgola a collaborare",
  "Metto in carica l'intuizione",
  "Unisco i puntini senza uscire dai bordi",
  "La pazienza è una feature, dicono",
  "Sto cercando il cacciavite delle idee",
  "Controllo il retro della lavagna",
  "Riordino i pensieri per altezza",
  "Faccio un piccolo tagliando alla logica",
  "I neuroni hanno aperto una pull request",
  "Raccolgo i pezzi prima che scappino",
  "Sto chiedendo indicazioni alla bussola",
  "La risposta si sta allacciando le scarpe",
  "Avvio la modalità detective con lente d'ingrandimento",
  "La logica sta parcheggiando in doppia fila",
  "Faccio un controllo qualità alle idee",
  "Sto cercando una scorciatoia che non sia una trappola",
  "Mescolo con cura pensieri e parentesi",
  "Un attimo: il mio alter ego sta leggendo le istruzioni",
  "La risposta è quasi pronta per uscire di casa",
  "Faccio un cenno d'intesa ai pixel",
  "Sto mettendo i puntini sulle i, letteralmente",
  "Verifico che nessun pensiero sia rimasto in bozza",
  "Il piano sta facendo stretching",
  "Raccolgo le idee dal pavimento",
  "Sto dando una spazzolata ai ragionamenti",
  "Le rotelline girano, ma con eleganza",
  "Faccio spazio a un'idea con le valigie",
  "La risposta sta arrivando: ha trovato traffico",
  "Sto facendo pace con un caso limite",
  "Un ultimo giro di giostra per la logica",
];

const THINKING_PHRASE_INTERVAL_MS = 5000;

function setThinkingMessage(pending, advance = false, now = Date.now()) {
  if (!pending.classList.contains("thinking")) return;
  const label = pending.querySelector(".thinking-label");
  if (!label) return;
  const previous = Number(pending.dataset.thinkingIndex);
  const lastUpdated = Number(pending.dataset.thinkingUpdatedAt);
  if (advance && Number.isFinite(lastUpdated)
    && now - lastUpdated < THINKING_PHRASE_INTERVAL_MS) return;
  const index = Number.isInteger(previous)
    ? advance ? (previous + 1) % thinkingPhrases.length : previous
    : Math.floor(Math.random() * thinkingPhrases.length);
  pending.dataset.thinkingIndex = String(index);
  pending.dataset.thinkingUpdatedAt = String(now);
  label.textContent = thinkingPhrases[index];
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
    setThinkingMessage(el);
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
  const cursor = input.selectionStart;
  const beforeCursor = input.value.slice(0, cursor);
  const hashMatch = beforeCursor.match(/(?:^|\s)#([a-zA-Z][a-zA-Z0-9_-]{0,60})?$/);
  if (hashMatch && canUseMcpMentions()) {
    const query = hashMatch[1] || "";
    const matches = mcpServers.filter((server) => server.enabled
      && server.name.toLowerCase().startsWith(query.toLowerCase()));
    slashSuggestions.replaceChildren();
    matches.forEach((server) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `#${server.name}`;
      button.addEventListener("click", () => {
        const tokenStart = beforeCursor.lastIndexOf("#");
        const afterCursor = input.value.slice(cursor);
        const separator = afterCursor.startsWith(" ") ? "" : " ";
        input.value = `${input.value.slice(0, tokenStart)}#${server.name}${separator}${afterCursor}`;
        const nextCursor = tokenStart + server.name.length + separator.length + 1;
        input.setSelectionRange(nextCursor, nextCursor);
        input.focus();
        autoResize();
        updateSlashSuggestions();
      });
      slashSuggestions.append(button);
    });
    slashSuggestions.hidden = matches.length === 0;
    return;
  }
  const value = input.value.trimStart();
  const commands = [
    "/help", "/usage", "/cwd ", "/model ",
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

function canUseMcpMentions() {
  const provider = currentChatId
    ? chatProviders.get(currentChatId) || "cli"
    : pendingChatProvider;
  return provider === "cli"
    && ["edit", "agent"].includes(permissionModeSelects[0]?.value);
}

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
  if (config?.type === "http") {
    const allowedKeys = ["type", "url", "headers", "tools"];
    let url;
    try {
      url = new URL(config.url);
    } catch (_error) {
      throw new Error("Config MCP HTTP: inserisci un URL valido");
    }
    const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (Object.keys(config).some((key) => !allowedKeys.includes(key))
      || (url.protocol !== "https:" && !(url.protocol === "http:" && localHost))
      || url.username || url.password || url.hash
      || (config.headers !== undefined
        && (!config.headers || typeof config.headers !== "object" || Array.isArray(config.headers)
          || !Object.entries(config.headers).every(([key, value]) =>
            /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/.test(key)
            && typeof value === "string" && value.length <= 2048 && !/[\r\n\0]/.test(value))))
      || (config.tools !== undefined
        && (!Array.isArray(config.tools) || config.tools.length > 100
          || !config.tools.every((tool) => typeof tool === "string"
            && tool.length > 0 && tool.length <= 256 && !/[\x00-\x1f]/.test(tool))))) {
      throw new Error("Config MCP HTTP non valida: servono URL HTTPS, headers e tools validi");
    }
    return {
      type: "http",
      url: config.url,
      headers: config.headers || {},
      tools: config.tools || ["*"],
    };
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

function selectedMcpServerIds() {
  return mcpServers.filter((server) => server.enabled).map((server) => server.id);
}

function extractMcpMentions(text) {
  const enabledServers = new Map(
    mcpServers.filter((server) => server.enabled)
      .map((server) => [server.name.toLowerCase(), server.id]),
  );
  const selected = new Set();
  const message = text.replace(/(^|\s)#([a-zA-Z][a-zA-Z0-9_-]{0,60})(?=$|\s)/g,
    (mention, prefix, name) => {
      const serverId = enabledServers.get(name.toLowerCase());
      if (!serverId) return mention;
      selected.add(serverId);
      return prefix;
    }).replace(/[ \t]{2,}/g, " ").trim();
  return {
    message,
    servers: selected.size ? [...selected] : selectedMcpServerIds(),
    explicit: selected.size > 0,
  };
}

async function loadMcpServers() {
  try {
    const res = await fetch("/api/mcp-servers");
    if (res.status === 401) { window.location.href = "/login.html"; return; }
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.error || "Impossibile caricare i server MCP");
    mcpServers = data;
    renderMcpServers();
    updateSlashSuggestions();
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

function shortSkillDescription(description) {
  const text = typeof description === "string" ? description.trim() : "";
  if (text.length <= 110) return text;
  const sentenceEnd = text.indexOf(". ");
  if (sentenceEnd > 0 && sentenceEnd < 110) return text.slice(0, sentenceEnd + 1);
  return `${text.slice(0, 107).trimEnd()}…`;
}

async function updateSkillState(kind, entry, checkbox) {
  const requestedState = checkbox.checked;
  checkbox.disabled = true;
  try {
    const result = await jsonRequest("/api/skills/state", "PUT", {
      kind,
      name: entry.name,
      enabled: requestedState,
    });
    checkbox.checked = result.enabled;
    checkbox.setAttribute("aria-label", `${checkbox.checked ? "Disattiva" : "Attiva"} ${entry.name}`);
    showNotice(`${entry.name}: ${result.enabled ? "attivata" : "disattivata"} per le prossime sessioni Copilot`);
  } catch (err) {
    checkbox.checked = !requestedState;
    checkbox.setAttribute("aria-label", `${checkbox.checked ? "Disattiva" : "Attiva"} ${entry.name}`);
    showNotice(err.message);
  } finally {
    checkbox.disabled = false;
  }
}

function createSkillRow(kind, entry) {
  const row = document.createElement("div");
  row.className = "skill-toggle";

  const label = document.createElement("label");
  label.className = "skill-label";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = entry.enabled !== false;
  checkbox.setAttribute("aria-label", `${checkbox.checked ? "Disattiva" : "Attiva"} ${entry.name}`);
  checkbox.addEventListener("change", () => updateSkillState(kind, entry, checkbox));

  const details = document.createElement("span");
  details.className = "skill-details";
  const name = document.createElement("strong");
  name.textContent = entry.name;
  details.append(name);
  const description = shortSkillDescription(entry.description);
  if (description) {
    const summary = document.createElement("small");
    summary.textContent = description;
    details.append(summary);
  }
  label.append(checkbox, details);
  row.append(label);
  if (kind === "skills" && entry.removable) {
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "skill-remove";
    removeButton.setAttribute("aria-label", `Elimina la skill ${entry.name}`);
    removeButton.title = "Elimina skill";
    removeButton.textContent = "🗑";
    removeButton.addEventListener("click", async () => {
      if (!window.confirm(`Eliminare definitivamente la skill "${entry.name}" dal profilo personale Copilot?`)) {
        return;
      }
      removeButton.disabled = true;
      try {
        await jsonRequest("/api/skills/remove", "POST", { name: entry.name });
        await loadSkills();
        showNotice(`Skill ${entry.name} eliminata`);
      } catch (err) {
        showNotice(err.message);
      } finally {
        removeButton.disabled = false;
      }
    });
    row.append(removeButton);
  }
  return row;
}

async function loadSkills() {
  try {
    const res = await fetch("/api/skills");
    if (res.status === 401) { window.location.href = "/login.html"; return; }
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.error || "Skill non disponibili");
    skillsList.replaceChildren();
    for (const [kind, title, entries] of [
      ["skills", "Skill", data.skills || []],
      ["plugins", "Plugin", data.plugins || []],
    ]) {
      if (!entries.length) continue;
      const group = document.createElement("section");
      group.className = "skill-group";
      const heading = document.createElement("h4");
      heading.textContent = title;
      group.append(heading);
      for (const entry of entries) {
        group.append(createSkillRow(kind, entry));
      }
      skillsList.append(group);
    }
    if (!skillsList.childElementCount) skillsList.textContent = "Nessuna skill o plugin disponibile";
  } catch (err) {
    skillsList.textContent = err.message;
  }
}

const skillAddForm = document.getElementById("skillAddForm");
const skillSource = document.getElementById("skillSource");
const skillAddButton = document.getElementById("skillAddButton");
skillAddForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  skillAddButton.disabled = true;
  try {
    await jsonRequest("/api/skills/add", "POST", { source: skillSource.value.trim() });
    skillSource.value = "";
    await loadSkills();
    showNotice("Skill aggiunta al profilo personale Copilot");
  } catch (err) {
    showNotice(err.message);
  } finally {
    skillAddButton.disabled = false;
  }
});

async function loadChatList() {
  const res = await fetch("/api/chats");
  if (res.status === 401) { window.location.href = "/login.html"; return; }
  if (!res.ok) return;
  const chats = await res.json();
  for (const chat of chats) {
    chatModels.set(chat.id, chat.model);
    chatProviders.set(chat.id, chat.provider || "cli");
  }
  if (currentChatId && chatProviders.get(currentChatId) !== "studio") {
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
    item.className = "chat-item" + (c.id === currentChatId ? " active" : "")
      + (c.running ? " running" : "");
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
  if (!window.confirm("Eliminare definitivamente questa chat e tutta la sua cronologia?")) return;
  const res = await fetch(`/api/chats/${chatId}`, { method: "DELETE" });
  if (!res.ok) {
    const data = await readApiResponse(res);
    showNotice(data.error || "Impossibile eliminare la sessione");
    return;
  }
  if (currentChatId === chatId) {
    currentChatId = null;
    currentChatProvider = null;
    setModelControls(localStorage.getItem("copilot-model") || "auto", false);
    setProviderControls("cli");
    setModeSelection("cli", "ask");
    pendingPlan = false;
    renderMcpServers();
    messagesEl.innerHTML = "";
    renderChatUsage();
  }
  chatUsages.delete(chatId);
  chatPlans.delete(chatId);
  chatModels.delete(chatId);
  chatProviders.delete(chatId);
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
  if (sessionStorage.getItem("copilot-notification-chat") === chatId) {
    sessionStorage.removeItem("copilot-notification-chat");
  }
  currentChatProvider = chatProviders.get(chatId) || "cli";
  sessionStorage.setItem("copilot-current-chat", chatId);
  setProviderControls(currentChatProvider);
  if (currentChatProvider === "studio") {
    setModeSelection("studio");
  } else {
    setModelControls(chatModels.get(chatId) || localStorage.getItem("copilot-model") || "auto", true);
    syncPermissions(chatPermissions.get(chatId) || []);
  }
  showSettings(false);
  pendingPlan = chatPlans.get(chatId) || false;
  renderMcpServers();
  updateChatBusyState();
  renderChatUsage();
  storeVisibleJobState();
  renderChatMessages(msgs, pendingPlan);
  renderActiveJobProgress(chatId);
  sidebar.classList.add("hidden");
  loadChatList();
  return true;
}

function renderChatMessages(messages, hasPendingPlan) {
  messagesEl.replaceChildren();
  const lastPlanIndex = messages.findLastIndex((message) => message.role === "plan");
  for (const [index, message] of messages.entries()) {
    const content = message.role === "user" ? displayUserMessage(message.content) : message.content;
    const element = addMessage(
      content, message.role === "user" ? "user" : "bot", message.model,
      message.ts, message.usage, [], message.auto_model === true,
    );
    if (index === lastPlanIndex && hasPendingPlan) {
      element.classList.add("pending-plan-message");
      attachPlanActions(element);
    }
  }
}

async function refreshChatMessages(chatId) {
  const response = await fetch(`/api/chats/${chatId}`);
  if (response.status === 401) {
    window.location.href = "/login.html";
    throw new Error("non autenticato");
  }
  const data = await readApiResponse(response);
  if (!response.ok) throw new Error(data.error || "Impossibile aggiornare la cronologia");
  if (!Array.isArray(data)) throw new Error("Formato cronologia non valido");
  if (currentChatId !== chatId) return false;
  renderChatMessages(data, chatPlans.get(chatId) || false);
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
      if (busy || isCurrentChatBusy()) return;
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
        updateChatBusyState();
      }
    });
    actions.append(button);
  }
  element.append(actions);
  updateChatBusyState();
}

function showActivity(container, event) {
  showActivityName(container, toolActivityName(event));
}

function toolActivityName(event) {
  const data = event?.data || {};
  const name = data.toolName || data.tool_name || data.name || data.tool || data.command || "tool";
  return String(name);
}

function showActivityName(container, name) {
  const activity = document.createElement("div");
  activity.className = "tool-activity";
  activity.textContent = `Uso ${name}`;
  container.append(activity);
  if (container.isConnected) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function rememberJobProgressElement(job, pending, activity) {
  job.progress ||= { content: "", tools: [] };
  pending.dataset.jobPending = job.id;
  activity.dataset.jobActivity = job.id;
  if (pending.classList.contains("thinking")) {
    job.thinkingIndex = Number(pending.dataset.thinkingIndex);
    job.thinkingUpdatedAt = Number(pending.dataset.thinkingUpdatedAt);
  }
  rememberJob(job);
}

function restoreThinkingState(pending, job) {
  if (Number.isInteger(job.thinkingIndex)
    && job.thinkingIndex >= 0 && job.thinkingIndex < thinkingPhrases.length) {
    pending.dataset.thinkingIndex = String(job.thinkingIndex);
    pending.dataset.thinkingUpdatedAt = String(job.thinkingUpdatedAt || Date.now());
    pending.querySelector(".thinking-label").textContent = thinkingPhrases[job.thinkingIndex];
  } else {
    setThinkingMessage(pending);
    job.thinkingIndex = Number(pending.dataset.thinkingIndex);
    job.thinkingUpdatedAt = Number(pending.dataset.thinkingUpdatedAt);
  }
}

function findJobProgressElement(job, kind) {
  const key = `job${kind[0].toUpperCase()}${kind.slice(1)}`;
  return Array.from(messagesEl.children).find((element) => element.dataset[key] === job.id) || null;
}

function renderJobProgress(job) {
  if (!job.chat_id || (currentChatId !== job.chat_id
    && !(currentChatId === null && pendingChatId === job.chat_id))) return;
  job.progress ||= { content: "", tools: [] };
  let pending = findJobProgressElement(job, "pending");
  let activity = findJobProgressElement(job, "activity");
  if (!pending) {
    pending = addMessage("Copilot sta pensando...", "bot pending");
    pending.dataset.jobPending = job.id;
    restoreThinkingState(pending, job);
  }
  if (!activity) {
    activity = document.createElement("div");
    activity.className = "activity-log";
    activity.dataset.jobActivity = job.id;
    messagesEl.append(activity);
  }
  if (job.progress.content) {
    pending.classList.remove("thinking");
    pending.removeAttribute("role");
    pending.textContent = job.progress.content;
  }
  activity.replaceChildren();
  for (const name of job.progress.tools) showActivityName(activity, name);
}

function renderActiveJobProgress(chatId) {
  for (const job of activeJobs.values()) {
    if (job.chat_id === chatId) renderJobProgress(job);
  }
}

function storeVisibleJobState() {
  for (const job of activeJobs.values()) {
    const pending = findJobProgressElement(job, "pending");
    if (pending?.classList.contains("thinking")) {
      job.thinkingIndex = Number(pending.dataset.thinkingIndex);
      job.thinkingUpdatedAt = Number(pending.dataset.thinkingUpdatedAt);
      rememberJob(job);
    }
  }
}

async function streamChat(formData, pending, activity, job) {
  formData.append("async", "true");
  formData.append("request_id", job.id);
  rememberJobProgressElement(job, pending, activity);
  await startJobRequest("/api/chat/stream", { method: "POST", body: formData }, job);
  return waitForJob(job);
}

function newRequestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function persistActiveJobs() {
  const storedJobs = [...activeJobs.values()].map((activeJob) => {
    const { progress, ...storedJob } = activeJob;
    if (progress) storedJob.progress = { tools: progress.tools || [] };
    return storedJob;
  });
  sessionStorage.setItem("copilot-pending-jobs", JSON.stringify(storedJobs));
}

function rememberJob(job) {
  activeJobs.set(job.id, job);
  persistActiveJobs();
  sessionStorage.removeItem("copilot-pending-job");
  updateChatBusyState();
}

function clearJob(job) {
  activeJobs.delete(job.id);
  removeJobProgress(job);
  persistActiveJobs();
  updateChatBusyState();
}

function removeJobProgress(job) {
  findJobProgressElement(job, "pending")?.remove();
  findJobProgressElement(job, "activity")?.remove();
}

function isCurrentChatBusy() {
  const chatId = currentChatId || pendingChatId;
  return [...activeJobs.values()].some((job) => job.chat_id === chatId);
}

function updateChatBusyState() {
  const chatBusy = isCurrentChatBusy();
  sendBtn.disabled = busy || chatBusy || pendingPlan;
  attachmentBtn.disabled = busy || chatBusy || pendingPlan;
  document.querySelectorAll(".plan-actions button").forEach((button) => {
    button.disabled = busy || chatBusy;
  });
}

async function jobFetch(job, url, options = {}) {
  const controller = new AbortController();
  jobControllers.set(job.id, controller);
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const data = await readApiResponse(res);
    return { res, data };
  } finally {
    clearTimeout(timeout);
    if (jobControllers.get(job.id) === controller) jobControllers.delete(job.id);
  }
}

function pauseJob(job) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, document.hidden ? 30000 : 1500);
    function done() {
      clearTimeout(timer);
      wakeJobs.delete(job.id);
      resolve();
    }
    wakeJobs.set(job.id, done);
  });
}

function resumeJob() {
  if (document.hidden) return;
  for (const controller of jobControllers.values()) controller.abort();
  for (const wake of wakeJobs.values()) wake();
}
document.addEventListener("visibilitychange", resumeJob);
window.addEventListener("pageshow", resumeJob);
window.addEventListener("online", resumeJob);

async function startJobRequest(url, options, job) {
  let res;
  let data;
  try {
    ({ res, data } = await jobFetch(job, url, options));
  } catch (_error) {
    showNotice("Connessione sospesa: recupero automatico della richiesta al ritorno.");
    return;
  }
  if (res.status === 401) {
    window.location.href = "/login.html";
    throw new Error("non autenticato");
  }
  if (!res.ok) {
    clearJob(job);
    throw Object.assign(new Error(data.error || `Errore HTTP ${res.status}`), data);
  }
  if (data.job_id !== job.id || !data.chat_id) {
    showNotice("Conferma di invio non leggibile: recupero automatico della richiesta.");
    return;
  }
  job.accepted = true;
  job.chat_id = data.chat_id;
  if (job.new_chat_pending && !currentChatId && !pendingChatId) {
    pendingChatId = job.chat_id;
  }
  rememberJob(job);
  loadChatList();
}

async function waitForJob(job) {
  let missing = 0;
  while (activeJobs.has(job.id)) {
    if (document.hidden || !navigator.onLine) {
      await pauseJob(job);
      continue;
    }
    let res;
    let data;
    try {
      ({ res, data } = await jobFetch(job, `/api/chat/jobs/${job.id}`));
    } catch (_error) {
      showNotice("Connessione sospesa: la risposta verrà recuperata automaticamente.");
      await pauseJob(job);
      continue;
    }
    if (res.status === 401) {
      window.location.href = "/login.html";
      throw new Error("non autenticato");
    }
    if (res.status === 404 && !job.accepted) {
      missing += 1;
      if (missing >= 5) {
        clearJob(job);
        const error = new Error("Invio non confermato dal server. Controlla la cronologia prima di riprovare.");
        error.unconfirmed = true;
        throw error;
      }
      await pauseJob(job);
      continue;
    }
    if (!res.ok) {
      showNotice(data.error || `Recupero risposta non disponibile (HTTP ${res.status}); nuovo tentativo automatico.`);
      await pauseJob(job);
      continue;
    }
    if (!data.chat_id || !["running", "done", "error"].includes(data.status)
      || (data.status !== "running" && !data.result)) {
      showNotice("Stato della risposta non leggibile; nuovo tentativo automatico.");
      await pauseJob(job);
      continue;
    }
    job.accepted = true;
    job.chat_id = data.chat_id;
    rememberJob(job);
    if (currentChatId === job.chat_id
      || (!currentChatId && pendingChatId === job.chat_id)) {
      showNotice("");
    }
    job.progress = {
      content: data.progress?.content || "",
      tools: (data.progress?.tools || []).map(toolActivityName),
    };
    const pending = findJobProgressElement(job, "pending");
    if (pending?.classList.contains("thinking") && !job.progress.content) {
      setThinkingMessage(pending, true);
      job.thinkingIndex = Number(pending.dataset.thinkingIndex);
      job.thinkingUpdatedAt = Number(pending.dataset.thinkingUpdatedAt);
    }
    rememberJob(job);
    renderJobProgress(job);
    if (data.status === "running" && !job.sidebarUpdated
      && (data.progress?.content || data.progress?.tools?.length)) {
      job.sidebarUpdated = true;
      rememberJob(job);
      loadChatList();
    }
    if (data.status !== "running") {
      clearJob(job);
      if (data.status === "error") {
        throw Object.assign(new Error(data.result?.error || "Errore durante l'elaborazione"), data.result);
      }
      return data.result;
    }
    await pauseJob(job);
  }
}

async function approvePlanAsync() {
  const chatId = currentChatId;
  const job = {
    id: newRequestId(), chat_id: chatId, accepted: false,
    autoModel: modelSelect.value === "auto",
  };
  rememberJob(job);
  const pending = addMessage("Copilot sta eseguendo il piano...", "bot pending");
  const activity = document.createElement("div");
  messagesEl.append(activity);
  rememberJobProgressElement(job, pending, activity);
  try {
    await startJobRequest("/api/chat/plan/approve", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ async: true, request_id: job.id, chat_id: chatId }),
    }, job);
    const data = await waitForJob(job);
    chatPlans.set(chatId, false);
    if (currentChatId === chatId) pendingPlan = false;
    await loadChatList();
    if (currentChatId === chatId && settingsView.hidden) {
      await openChat(chatId, true);
    }
  } catch (err) {
    showNotice(err.message);
  } finally {
    removeJobProgress(job);
    updateChatBusyState();
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
  const command = text.match(/^\/(help|usage)(?:\s*)$/i)
    || text.match(/^\/cwd(?:\s+.+)?\s*$/i)
    || text.match(/^\/model\s+(\S+)\s*$/i);
  if (!command) return false;
  const data = await jsonRequest("/api/command", "POST", {
    command: text, chat_id: currentChatId || pendingChatId,
  });
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
  if (busy || isCurrentChatBusy() || pendingPlan) {
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
  const activeProvider = currentChatId
    ? chatProviders.get(currentChatId) || "cli"
    : pendingChatProvider;
  const isSubmittedChatSelected = (chatId) => currentChatId === chatId
    || (!currentChatId && pendingChatId === chatId)
    || (submittedWithoutChat && !currentChatId && !pendingChatId);
  const submittedFiles = attachedFiles;
  const mcpSelection = canUseMcpMentions()
    ? extractMcpMentions(text)
    : {
      message: text,
      servers: activeProvider === "studio" ? [] : selectedMcpServerIds(),
      explicit: false,
    };
  const promptText = mcpSelection.message
    || (mcpSelection.explicit
      ? "Usa i server MCP selezionati per aiutarmi."
      : "");
  const imageFiles = submittedFiles.filter((file) => file.type.startsWith("image/"));
  const prompt = imageFiles.length
    ? `${promptText
      ? `${promptText.replace(/\.$/, "")} e analizza i file allegati.`
      : "Analizza i file allegati."}\n🖼️`
    : chroniclePrompt(promptText) || promptText;

  busy = true;
  renderMcpServers();
  updateChatBusyState();
  const requestedPlan = permissionModeSelects[0]?.value === "plan";
  const isCommand = activeProvider !== "studio" && attachedFiles.length === 0
    && (/^\/(help|usage)\s*$/i.test(text) || /^\/cwd(?:\s+.+)?\s*$/i.test(text)
      || /^\/model\s+\S+\s*$/i.test(text)
      || /^\/chronicle(?:\s*)$/i.test(text) || /^\/chronicle\s+reindex(?:\s|$)/i.test(text)
      || /^\/chronicle\s+search\s*$/i.test(text)
      || (/^\/chronicle\b/i.test(text) && !chroniclePrompt(text)));
  const displayText = promptText || (imageFiles.length ? "" : `[Allegati ${submittedFiles.length} file]`);
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
    formData.append("mcp_servers", JSON.stringify(mcpSelection.servers));
    formData.append("tool_permissions", "[]");
    if (requestedPlan) formData.append("plan", "true");
    submittedFiles.forEach((file) => formData.append("files", file));
    const job = {
      id: newRequestId(), chat_id: submittedChatId, accepted: false,
      text: prompt || `[Allegati ${submittedFiles.length} file]`,
      new_chat_pending: submittedWithoutChat,
    };
    rememberJob(job);
    busy = false;
    updateChatBusyState();
    const data = await streamChat(formData, pending, activity, job);
    pending.remove();
    responseChatId = data.chat_id || responseChatId;
    if (data.chat_id) {
      const responseChatId = data.chat_id;
      const chatSelected = isSubmittedChatSelected(responseChatId);
      chatModels.set(responseChatId, data.model || submittedModel);
      chatUsages.set(responseChatId, data.usage);
      chatPermissions.set(responseChatId, submittedPermissions);
      chatPlans.set(responseChatId, !!data.pending_plan);
      chatProviders.set(responseChatId, data.provider || activeProvider);
      if (chatSelected) {
        currentChatId = responseChatId;
        currentChatProvider = data.provider || activeProvider;
        pendingChatId = null;
        sessionStorage.setItem("copilot-current-chat", responseChatId);
        setProviderControls(currentChatProvider);
        if (currentChatProvider !== "studio") {
          setModelControls(data.model || submittedModel, true);
        }
        pendingPlan = !!data.pending_plan;
        renderMcpServers();
        renderChatUsage();
      }
      loadChatList();
    }
    let historyRefreshFailed = false;
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
      try {
        await refreshChatMessages(data.chat_id);
      } catch (err) {
        historyRefreshFailed = true;
        showNotice(`Risposta ricevuta, ma cronologia non aggiornata: ${err.message}`);
      }
    }
    notifyResponseReady(data.chat_id, !!data.pending_plan);
    if (isSubmittedChatSelected(data.chat_id) && !historyRefreshFailed) {
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
      currentChatProvider = chatProviders.get(err.chat_id) || activeProvider;
      pendingChatId = null;
      setProviderControls(currentChatProvider);
      if (currentChatProvider !== "studio") {
        setModelControls(chatModels.get(err.chat_id) || submittedModel, true);
      }
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
    updateChatBusyState();
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
  const mode = permissionModeSelects[0]?.value || "ask";
  await createNewChat(providerSelect.value, mode);
});

logoutBtn.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login.html";
});

menuBtn.addEventListener("click", () => {
  sidebar.classList.toggle("hidden");
});

async function restoreChat() {
  try {
    const storedJobs = sessionStorage.getItem("copilot-pending-jobs");
    const storedLegacyJob = sessionStorage.getItem("copilot-pending-job");
    const restoredJobs = storedJobs
      ? JSON.parse(storedJobs)
      : storedLegacyJob ? [JSON.parse(storedLegacyJob)] : [];
    if (!Array.isArray(restoredJobs)) throw new Error("Elenco delle richieste in corso non valido");
    for (const job of restoredJobs) activeJobs.set(job.id, job);
    persistActiveJobs();
    sessionStorage.removeItem("copilot-pending-job");
    await loadChatList();
    const chatId = sessionStorage.getItem("copilot-notification-chat")
      || sessionStorage.getItem("copilot-current-chat")
      || restoredJobs.find((job) => job.chat_id)?.chat_id;
    if (chatId) await openChat(chatId, true);
    else updateChatBusyState();
    await Promise.all(restoredJobs.map((job) => restorePendingJob(job)));
  } catch (err) {
    showNotice(`Impossibile recuperare la chat: ${err.message}`);
  }
}

async function restorePendingJob(job) {
  job.progress ||= { content: "", tools: [] };
  renderJobProgress(job);
  try {
    const data = await waitForJob(job);
    notifyResponseReady(data.chat_id, !!data.pending_plan);
    await loadChatList();
    if (currentChatId === data.chat_id && settingsView.hidden) {
      await openChat(data.chat_id, true);
    }
  } catch (err) {
    if (currentChatId === job.chat_id || pendingChatId === job.chat_id) {
      showNotice(err.message);
    }
  } finally {
    removeJobProgress(job);
    updateChatBusyState();
  }
}

restoreChat();
loadModels();
syncChatFeatures();
