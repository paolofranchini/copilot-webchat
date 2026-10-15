const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../static/app.js"), "utf8");
const constantStart = source.indexOf('const NOTIFICATIONS_STORAGE_KEY = "copilot-response-notifications";');
const start = source.indexOf("async function notifyResponseReady(");
const end = source.indexOf('if ("serviceWorker" in navigator)', start);
const testStart = source.indexOf("async function sendTestNotification()");
const testEnd = source.indexOf('notificationTest.addEventListener("click"', testStart);
assert.notEqual(start, -1);
assert.notEqual(end, -1);
assert.notEqual(testStart, -1);
assert.notEqual(testEnd, -1);

const notifications = [];
const context = vm.createContext({
  document: { hidden: true },
  settingsView: { hidden: true },
  currentChatId: null,
  pendingChatId: null,
  localStorage: {
    getItem: () => "enabled",
  },
  Notification: { permission: "granted" },
  window: { Notification: true },
  navigator: {
    serviceWorker: {
      ready: Promise.resolve({
        showNotification: async (...args) => notifications.push(args),
      }),
    },
  },
  console,
});
vm.runInContext(
  `${source.slice(constantStart, source.indexOf("\n", constantStart))}\n${source.slice(testStart, testEnd)}\n${source.slice(start, end)}`,
  context,
);

async function main() {
  await context.sendTestNotification();
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0][0], "Notifica di prova");
  assert.equal(notifications[0][1].body, "Le notifiche di Copilot CLI Webchat funzionano.");

  await context.notifyResponseReady("chat-123", false);
  assert.equal(notifications.length, 2);
  assert.equal(notifications[1][0], "Risposta pronta");
  assert.equal(notifications[1][1].data.chatId, "chat-123");
  assert.equal(notifications[1][1].body, "Tocca per aprire la chat.");
  assert.match(notifications[1][1].tag, /^chat-response-chat-123-/);
  assert.equal(notifications[1][1].requireInteraction, false);

  context.document.hidden = false;
  context.currentChatId = "chat-visible";
  await context.notifyResponseReady("chat-visible");
  assert.equal(notifications.length, 2);
  context.currentChatId = "another-chat";
  await context.notifyResponseReady("chat-in-background");
  assert.equal(notifications.length, 3);

  context.document.hidden = true;
  context.Notification.permission = "denied";
  await context.notifyResponseReady("chat-denied");
  assert.equal(notifications.length, 3);
  console.log("Notifiche: risposta solo in background con permesso, senza testo chat");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
