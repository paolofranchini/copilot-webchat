const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const handlers = {};
let skipWaitingCalls = 0;
let claimCalls = 0;
const fetched = [];
const openedWindows = [];
const focusedClients = [];
const response = { status: 200 };
const serviceWorkerClient = {
  url: "https://raspberrypi:7891/",
  focus: async () => { focusedClients.push(true); },
  postMessage: (message) => { focusedClients.push(message); },
};
let matchedClients = [serviceWorkerClient];
const context = vm.createContext({
  URL,
  self: {
    addEventListener: (type, handler) => { handlers[type] = handler; },
    skipWaiting: async () => { skipWaitingCalls += 1; },
    clients: { claim: async () => { claimCalls += 1; } },
    registration: { scope: "https://raspberrypi:7891/" },
  },
  fetch: async (request) => {
    fetched.push(request);
    return response;
  },
});
context.self.clients.matchAll = async () => matchedClients;
context.self.clients.openWindow = async (url) => { openedWindows.push(url); };
const source = fs.readFileSync(
  path.join(__dirname, "../static/service-worker.js"),
  "utf8",
);
vm.runInContext(source, context);

async function main() {
  assert.deepEqual(
    Object.keys(handlers).sort(),
    ["activate", "fetch", "install", "notificationclick"],
  );
  let lifecyclePromise;
  handlers.install({ waitUntil: (promise) => { lifecyclePromise = promise; } });
  await lifecyclePromise;
  assert.equal(skipWaitingCalls, 1);

  handlers.activate({ waitUntil: (promise) => { lifecyclePromise = promise; } });
  await lifecyclePromise;
  assert.equal(claimCalls, 1);

  const request = { url: "https://raspberrypi:7891/api/chats" };
  let fetchPromise;
  handlers.fetch({
    request,
    respondWith: (promise) => { fetchPromise = promise; },
  });
  assert.equal(await fetchPromise, response);
  assert.deepEqual(fetched, [request]);
  assert.doesNotMatch(source, /\bcaches\./);

  let clickPromise;
  handlers.notificationclick({
    notification: {
      data: { chatId: "chat-123" },
      close() {},
    },
    waitUntil: (promise) => { clickPromise = promise; },
  });
  await clickPromise;
  assert.equal(focusedClients[0], true);
  assert.deepEqual(JSON.parse(JSON.stringify(focusedClients[1])), {
    type: "open-chat",
    chatId: "chat-123",
  });
  assert.deepEqual(openedWindows, []);

  matchedClients = [];
  handlers.notificationclick({
    notification: {
      data: { chatId: "chat-456" },
      close() {},
    },
    waitUntil: (promise) => { clickPromise = promise; },
  });
  await clickPromise;
  assert.deepEqual(openedWindows, ["https://raspberrypi:7891/?chat=chat-456"]);

  console.log("Service worker: pass-through network-only e apertura chat da notifiche");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
