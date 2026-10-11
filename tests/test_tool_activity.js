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
assert.equal(appended[0].textContent, "Uso view");
assert.equal(appended[0].className, "tool-activity");

context.showActivity({ append: (activity) => appended.push(activity) }, {
  data: { name: "legacy-tool" },
});
assert.equal(appended[1].textContent, "Uso legacy-tool");

console.log("Uso tool: nome CLI visualizzato senza esporre gli argomenti");
