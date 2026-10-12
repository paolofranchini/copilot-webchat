const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const handlers = {};
let skipWaitingCalls = 0;
let claimCalls = 0;
const fetched = [];
const response = { status: 200 };
const context = vm.createContext({
  self: {
    addEventListener: (type, handler) => { handlers[type] = handler; },
    skipWaiting: async () => { skipWaitingCalls += 1; },
    clients: { claim: async () => { claimCalls += 1; } },
  },
  fetch: async (request) => {
    fetched.push(request);
    return response;
  },
});
const source = fs.readFileSync(
  path.join(__dirname, "../static/service-worker.js"),
  "utf8",
);
vm.runInContext(source, context);

async function main() {
  assert.deepEqual(Object.keys(handlers).sort(), ["activate", "fetch", "install"]);
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

  console.log("Service worker: attivazione e pass-through network-only, nessuna cache");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
