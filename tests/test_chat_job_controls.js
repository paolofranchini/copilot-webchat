const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../static/app.js"), "utf8");
const start = source.indexOf("function isCurrentChatBusy()");
const end = source.indexOf("async function jobFetch(", start);
const planButton = { disabled: false };
const context = vm.createContext({
  activeJobs: new Map(),
  currentChatId: "chat-b",
  pendingChatId: null,
  pendingPlan: false,
  busy: false,
  sendBtn: { disabled: false },
  attachmentBtn: { disabled: false },
  document: { querySelectorAll: () => [planButton] },
});
vm.runInContext(source.slice(start, end), context);
context.activeJobs.set("job-a", { id: "job-a", chat_id: "chat-a" });

context.updateChatBusyState();
assert.equal(context.isCurrentChatBusy(), false);
assert.equal(context.sendBtn.disabled, false);
assert.equal(context.attachmentBtn.disabled, false);
assert.equal(planButton.disabled, false);

context.currentChatId = "chat-a";
context.updateChatBusyState();
assert.equal(context.isCurrentChatBusy(), true);
assert.equal(context.sendBtn.disabled, true);
assert.equal(context.attachmentBtn.disabled, true);
assert.equal(planButton.disabled, true);

console.log("Job chat: solo la chat occupata disabilita invio e azioni piano");
