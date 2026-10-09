const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

class Element {
  constructor() {
    this.children = [];
    this.attributes = {};
    this.className = "";
    this.classList = {
      contains: (name) => this.className.split(" ").includes(name),
      add: (name) => { this.className += ` ${name}`; },
    };
  }
  get childElementCount() { return this.children.length; }
  setAttribute(name, value) { this.attributes[name] = value; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); }
  querySelectorAll() { return []; }
}

const source = fs.readFileSync(path.join(__dirname, "../static/app.js"), "utf8");
const context = vm.createContext({
  document: { createElement: () => new Element() },
  messagesEl: new Element(),
  renderMarkdown: (text) => text,
  Intl,
});
vm.runInContext(
  source.slice(source.indexOf("function formatMessageTime("),
    source.indexOf("function formatChatTimestamp(")),
  context,
);

const reply = context.addMessage("Risposta", "bot", "gpt-test",
  "2026-10-07T10:00:00Z", { ai_credits: 1.25 });
assert.equal(reply.children.length, 1);
const metadata = reply.children[0];
assert.equal(metadata.className, "msg-metadata");
assert.deepEqual(metadata.children.map((child) => child.className),
  ["model-tag", "msg-credits", "msg-time"]);
const automatic = context.addMessage("Risposta", "bot", "gpt-6-luna",
  "2026-10-07T10:00:00Z", null, [], true);
assert.equal(automatic.children[0].children[0].textContent, "gpt-6-luna (Auto)");
assert.equal(metadata.children[1].textContent, "✦ 1,25");
assert.equal(context.formatChatUsage({ ai_credits: 19.01 }, true), "✦ 19,01");
assert.equal(context.formatChatUsage({ ai_credits: 19.01 }), "19,01 crediti AI");
const user = context.addMessage("Ciao", "user", null, "2026-10-07T10:00:00Z");
assert.deepEqual(user.children[0].children.map((child) => child.className), ["msg-time"]);
const unknown = context.addMessage("Risposta", "bot", "gpt-test");
assert.equal(unknown.children[0].children.length, 2);
const free = context.addMessage("Risposta", "bot", "gpt-test", null, { ai_credits: 0 });
assert.equal(free.children[0].children[1].textContent, "✦ 0,00");
const pending = context.addMessage("Copilot sta pensando...", "bot pending");
assert(pending.classList.contains("thinking"));
assert.equal(pending.children[1].children.length, 3);
assert.equal(pending.children.filter((child) => child.className === "msg-metadata").length, 0);
console.log("Metadati messaggi: verifiche superate");
