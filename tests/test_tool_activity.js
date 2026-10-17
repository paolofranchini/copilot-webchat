const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

class Element {
  constructor() {
    this.className = "";
    this.textContent = "";
  }
}

const appended = [];
const source = fs.readFileSync(path.join(__dirname, "../static/app.js"), "utf8");
const context = vm.createContext({
  document: { createElement: () => new Element() },
  messagesEl: { scrollTop: 0, scrollHeight: 10 },
});
vm.runInContext(
  source.slice(source.indexOf("function showActivity("), source.indexOf("async function streamChat(")),
  context,
);

context.showActivity({ append: (activity) => appended.push(activity) }, {
  data: {
    toolName: "view",
    toolTitle: "Read file",
    arguments: { path: "/private/project/file.txt" },
  },
});
assert.equal(appended[0].textContent, "Uso view — Read file");
assert.equal(appended[0].className, "tool-activity");

context.showActivity({ append: (activity) => appended.push(activity) }, {
  data: { name: "legacy-tool" },
});
assert.equal(appended[1].textContent, "Uso legacy-tool");

const label = context.toolActivityName({
  data: { toolName: "shell", arguments: { description: "a".repeat(51) } },
});
assert.equal(label, `shell — ${"a".repeat(49)}…`);
assert.equal(Array.from(label.split(" — ")[1]).length, 50);
assert.equal(context.toolActivityName({
  data: { toolName: "view", arguments: { path: "/progetto/app.py" } },
}), "view — /progetto/app.py");
assert.equal(context.toolActivityName({
  data: {
    toolName: "shell",
    arguments: { description: "Controllo\n  sintassi", command: "node --check app.js" },
  },
}), "shell — Controllo sintassi");
assert.equal(context.toolActivityName({
  data: { toolName: "shell", arguments: { token: "non mostrare" } },
}), "shell");
assert.equal(context.toolActivityName({
  data: { toolName: "view", arguments: { description: "😀".repeat(51) } },
}), `view — ${"😀".repeat(49)}…`);

console.log("Uso tool: dettaglio di massimo 50 caratteri, senza serializzare tutti gli argomenti");
