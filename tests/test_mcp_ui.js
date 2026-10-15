const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

class Element {
  constructor() {
    this.children = [];
    this.listeners = {};
    this.hidden = false;
    this.textContent = "";
  }
  replaceChildren(...children) { this.children = children; }
  append(child) { this.children.push(child); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  focus() {}
  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
}

const input = new Element();
input.value = "";
input.selectionStart = 0;
const slashSuggestions = new Element();
const context = vm.createContext({
  URL,
  input,
  slashSuggestions,
  autoResize() {},
  currentChatId: null,
  chatProviders: new Map(),
  pendingChatProvider: "cli",
  permissionModeSelects: [{ value: "edit" }],
  document: { createElement: () => new Element() },
});
const source = fs.readFileSync(path.join(__dirname, "../static/app.js"), "utf8");
const start = source.indexOf("function parseMcpConfig(");
const end = source.indexOf("async function loadMcpServers(", start);
assert.notEqual(start, -1);
assert.notEqual(end, -1);
vm.runInContext(source.slice(start, end), context);
const suggestionsStart = source.indexOf("function updateSlashSuggestions(");
const suggestionsEnd = source.indexOf("function canUseMcpMentions()", suggestionsStart);
assert.notEqual(suggestionsStart, -1);
assert.notEqual(suggestionsEnd, -1);
vm.runInContext(source.slice(suggestionsStart, suggestionsEnd), context);
const canUseMcpStart = source.indexOf("function canUseMcpMentions()");
const canUseMcpEnd = source.indexOf("function chroniclePrompt(", canUseMcpStart);
vm.runInContext(source.slice(canUseMcpStart, canUseMcpEnd), context);
assert.equal(context.canUseMcpMentions(), true);
context.permissionModeSelects[0].value = "ask";
assert.equal(context.canUseMcpMentions(), false);
context.permissionModeSelects[0].value = "agent";
assert.equal(context.canUseMcpMentions(), true);
context.pendingChatProvider = "studio";
assert.equal(context.canUseMcpMentions(), false);
context.pendingChatProvider = "cli";
context.permissionModeSelects[0].value = "edit";

const httpConfig = context.parseMcpConfig(JSON.stringify({
  type: "http",
  url: "https://learn.microsoft.com/api/mcp",
}));
assert.equal(httpConfig.type, "http");
assert.equal(httpConfig.url, "https://learn.microsoft.com/api/mcp");
assert.deepEqual(JSON.parse(JSON.stringify(httpConfig.headers)), {});
assert.deepEqual(JSON.parse(JSON.stringify(httpConfig.tools)), ["*"]);

const stdioConfig = context.parseMcpConfig(JSON.stringify({
  command: "/usr/bin/node",
  args: ["server.js"],
  env: {},
}));
assert.equal(stdioConfig.command, "/usr/bin/node");

for (const config of [
  { type: "http", url: "http://example.com/mcp" },
  { type: "http", url: "https://user:pass@example.com/mcp" },
  { type: "http", url: "https://example.com/mcp", headers: { Authorization: "bad\r\nvalue" } },
]) {
  assert.throws(() => context.parseMcpConfig(JSON.stringify(config)));
}

vm.runInContext("mcpServers = [{id: 'enabled', enabled: true}, {id: 'disabled', enabled: false}]", context);
assert.deepEqual(JSON.parse(JSON.stringify(context.selectedMcpServerIds())), ["enabled"]);

vm.runInContext(`mcpServers = [
  {id: 'docs-id', name: 'microsoft-docs-mcp', enabled: true},
  {id: 'stdio-id', name: 'local-tools', enabled: true},
  {id: 'disabled-id', name: 'disabled-server', enabled: false},
]`, context);
input.value = "Cerca #microsoft";
input.selectionStart = input.value.length;
context.updateSlashSuggestions();
assert.deepEqual(
  slashSuggestions.children.map((button) => button.textContent),
  ["#microsoft-docs-mcp"],
);
slashSuggestions.children[0].listeners.click();
assert.equal(input.value, "Cerca #microsoft-docs-mcp ");
assert.deepEqual(
  JSON.parse(JSON.stringify(context.extractMcpMentions(
    "Cerca #microsoft-docs-mcp e poi usa #local-tools",
  ))),
  { message: "Cerca e poi usa", servers: ["docs-id", "stdio-id"], explicit: true },
);
assert.deepEqual(
  JSON.parse(JSON.stringify(context.extractMcpMentions("Testo #disabled-server #unknown"))),
  {
    message: "Testo #disabled-server #unknown",
    servers: ["docs-id", "stdio-id"],
    explicit: false,
  },
);
assert.deepEqual(
  JSON.parse(JSON.stringify(context.extractMcpMentions("#microsoft-docs-mcp"))),
  {
    message: "",
    servers: ["docs-id"],
    explicit: true,
  },
);
