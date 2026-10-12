const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../static/app.js"), "utf8");
const start = source.indexOf("function selectedPermissions()");
const end = source.indexOf(
  '\npermissionModeSelects.forEach((select) => {\n  select.addEventListener',
  start,
);
const modes = [{ value: "agent" }, { value: "agent" }];
const context = vm.createContext({ permissionModeSelects: modes });
vm.runInContext(source.slice(start, end), context);

context.prepareNewChatPermissions();
assert.equal(JSON.stringify(context.selectedPermissions()), '["all"]');
assert.deepEqual(modes.map((select) => select.value), ["agent", "agent"]);

const handlerStart = source.indexOf('newChatBtn.addEventListener("click", async () => {');
const handlerEnd = source.indexOf('logoutBtn.addEventListener("click"', handlerStart);
const newChatHandler = source.slice(handlerStart, handlerEnd);
assert.match(newChatHandler, /createNewChat\(mode === "studio" \? "studio" : "cli", mode\)/);
assert.doesNotMatch(newChatHandler, /syncPermissions\(\[\]\)/);
const newChatHelperStart = source.indexOf("async function createNewChat(");
const newChatHelperEnd = source.indexOf("\npermissionModeSelects.forEach", newChatHelperStart);
const newChatHelper = source.slice(newChatHelperStart, newChatHelperEnd);
assert.match(newChatHelper, /if \(provider === "cli"\) prepareNewChatPermissions\(\)/);
assert.match(newChatHelper, /chatProviders\.set\(data\.chat_id, provider\)/);
assert.match(newChatHelper, /setProviderControls\(provider\)/);
assert.match(source, /provider !== activeProvider/);
assert.match(source, /provider === "studio"/);
const html = fs.readFileSync(path.join(__dirname, "../static/index.html"), "utf8");
assert.match(html, /<option value="studio">Copilot Studio<\/option>/);

console.log("Nuova chat: permessi CLI conservati e provider Copilot Studio separato");
