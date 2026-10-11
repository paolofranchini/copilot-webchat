const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const rendered = [];
const messagesEl = {
  replaceChildren() { rendered.length = 0; },
};
const context = vm.createContext({
  messagesEl,
  displayUserMessage: (text) => text,
  addMessage: (text, role, model, timestamp, usage, attachments, autoModel) => {
    const element = {
      classList: { add() {} },
      message: { text, role, model, timestamp, usage, attachments, autoModel },
    };
    rendered.push(element);
    return element;
  },
  attachPlanActions() {},
});
const source = fs.readFileSync(path.join(__dirname, "../static/app.js"), "utf8");
const start = source.indexOf("function renderChatMessages(");
const end = source.indexOf("async function refreshChatMessages(", start);
vm.runInContext(source.slice(start, end), context);

context.renderChatMessages([
  { role: "user", content: "Richiesta" },
  { role: "bot", content: "Primo messaggio" },
  { role: "bot", content: "Risposta finale" },
], false);
assert.deepEqual(rendered.map((entry) => entry.message.text),
  ["Richiesta", "Primo messaggio", "Risposta finale"]);

console.log("Cronologia chat: tutti i messaggi nativi vengono renderizzati");
