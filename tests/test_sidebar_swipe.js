const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../static/app.js"), "utf8");
const start = source.indexOf("function isSidebarCloseSwipe(");
const end = source.indexOf('\ndocument.addEventListener("pointerdown"', start);
const context = vm.createContext({});
vm.runInContext(source.slice(start, end), context);

assert.equal(context.isSidebarCloseSwipe(180, 100, 90, 108), true);
assert.equal(context.isSidebarCloseSwipe(180, 100, 110, 180), false);
assert.equal(context.isSidebarCloseSwipe(180, 100, 130, 102), false);
assert.equal(context.isSidebarCloseSwipe(180, 100, 260, 104), false);

const sidebar = { contains: (target) => target === "sidebar" };
const menuButton = { contains: (target) => target === "menu" };
assert.equal(context.isSidebarOutsideTap("chat", true, true, sidebar, menuButton), true);
assert.equal(context.isSidebarOutsideTap("sidebar", true, true, sidebar, menuButton), false);
assert.equal(context.isSidebarOutsideTap("menu", true, true, sidebar, menuButton), false);
assert.equal(context.isSidebarOutsideTap("chat", false, true, sidebar, menuButton), false);
assert.equal(context.isSidebarOutsideTap("chat", true, false, sidebar, menuButton), false);

console.log("Sidebar: swipe e tap esterno chiudono solo su mobile quando aperta");
