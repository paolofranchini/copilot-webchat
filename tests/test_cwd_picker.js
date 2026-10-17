const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../static/app.js"), "utf8");
const start = source.indexOf("function isDirectoryPickerCommand(");
const end = source.indexOf("\nfunction canUseMcpMentions", start);
assert.notEqual(start, -1);
assert.notEqual(end, -1);

const context = vm.createContext({});
vm.runInContext(source.slice(start, end), context);
assert.equal(context.isDirectoryPickerCommand("/cwd"), true);
assert.equal(context.isDirectoryPickerCommand("/CWD   "), true);
assert.equal(context.isDirectoryPickerCommand("/cwd /home/user/project"), false);
assert.equal(context.isDirectoryPickerCommand("/cwdx"), false);

const submitStart = source.indexOf("async function submitChat(");
const submitEnd = source.indexOf("\nform.addEventListener(\"submit\"", submitStart);
const submitHandler = source.slice(submitStart, submitEnd);
assert.match(submitHandler, /isDirectoryPickerCommand\(text\)/);
assert.match(submitHandler, /await openDirectoryPicker\(\)/);
assert.ok(
  submitHandler.indexOf("isDirectoryPickerCommand(text)")
    < submitHandler.indexOf("const submittedChatId"),
  "Il selettore deve aprirsi prima di trattare /cwd come messaggio.",
);

const html = fs.readFileSync(path.join(__dirname, "../static/index.html"), "utf8");
const sidebar = html.match(/<aside id="sidebar"[\s\S]*?<\/aside>/)?.[0] || "";
assert.doesNotMatch(sidebar, /projectPickerBtn|Scegli progetto/);
assert.match(html, /<dialog id="directoryPicker"/);

console.log("Comando /cwd: apre il selettore senza aggiungere un messaggio alla chat");
