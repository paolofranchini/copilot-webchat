const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../static/app.js"), "utf8");
const handler = source.slice(source.indexOf("const restartServiceBtn ="),
  source.indexOf("function selectedPermissions("));

async function scenario(responses, busy = false, confirm = true, runningJob = false) {
  let click;
  let reloads = 0;
  let calls = 0;
  const button = { disabled: false, addEventListener: (_event, callback) => { click = callback; } };
  const status = { hidden: true, textContent: "" };
  const context = vm.createContext({
    busy,
    activeJobs: new Map(runningJob ? [["job", {}]] : []),
    document: { getElementById: (id) => id === "restartServiceBtn" ? button : status },
    window: { confirm: () => confirm, location: { reload: () => { reloads += 1; } } },
    showNotice: (message) => { status.textContent = message; },
    AbortController,
    setTimeout: (callback, delay) => delay === 1500 ? setTimeout(callback, 0) : setTimeout(callback, delay),
    clearTimeout,
    readApiResponse: async (response) => response.data,
    fetch: async () => {
      const next = responses[calls++];
      if (next instanceof Error) throw next;
      assert(next, "Richiesta inattesa");
      return next;
    },
  });
  vm.runInContext(handler, context);
  await click();
  return { reloads, calls, button, status };
}

(async () => {
  const old = { ok: true, status: 200, data: { instance_id: "old" } };
  const accepted = { ok: true, status: 202, data: { ok: true, instance_id: "old" } };
  const ready = { ok: true, status: 200, data: { instance_id: "new" } };
  const success = await scenario([old, accepted, new TypeError("Offline"), old, ready]);
  assert.equal(success.reloads, 1);
  assert.equal(success.calls, 5);
  const lostResponse = await scenario([old, new TypeError("Connection closed"), ready]);
  assert.equal(lostResponse.reloads, 1);
  const rejected = await scenario([old, { ok: false, status: 409,
    data: { error: "Copilot in esecuzione" } }]);
  assert.equal(rejected.reloads, 0);
  assert.equal(rejected.status.textContent, "Copilot in esecuzione");
  assert.equal(rejected.button.disabled, false);
  assert.equal((await scenario([], true)).calls, 0);
  assert.equal((await scenario([], false, true, true)).calls, 0);
  assert.equal((await scenario([], false, false)).calls, 0);
  console.log("Riavvio frontend: attesa nuova istanza, disconnessione e rifiuto verificati");
})().catch((error) => { console.error(error); process.exitCode = 1; });
