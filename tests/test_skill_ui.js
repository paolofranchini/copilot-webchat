const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.checked = false;
    this.disabled = false;
    this.childElementCount = 0;
    this.textContent = "";
    this.value = "";
  }
  append(...children) {
    this.children.push(...children);
    this.childElementCount = this.children.length;
  }
  replaceChildren(...children) {
    this.children = children;
    this.childElementCount = children.length;
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
}

const skillsList = new Element("div");
const skillAddForm = new Element("form");
const skillSource = new Element("input");
const skillAddButton = new Element("button");
let request;
let requestError = null;
let confirmResult = true;
let confirmMessage = "";
const notices = [];
const context = vm.createContext({
  document: {
    createElement: (tag) => new Element(tag),
    getElementById: (id) => ({
      skillAddForm,
      skillSource,
      skillAddButton,
    })[id],
  },
  skillsList,
  jsonRequest: async (...args) => {
    request = args;
    if (requestError) throw requestError;
    return { enabled: args[2].enabled };
  },
  showNotice: (notice) => notices.push(notice),
  fetch: async () => ({ status: 200, ok: true }),
  readApiResponse: async () => ({
    skills: [{
      name: "web-tests",
      description: "A very long description ".repeat(20),
      enabled: true,
      removable: true,
    }, {
      name: "builtin-example",
      description: "Built in skill",
      enabled: false,
      removable: false,
    }],
    plugins: [],
  }),
  window: {
    location: {},
    confirm: (message) => {
      confirmMessage = message;
      return confirmResult;
    },
  },
});
const source = fs.readFileSync(path.join(__dirname, "../static/app.js"), "utf8");
const start = source.indexOf("function shortSkillDescription(");
const end = source.indexOf("async function loadChatList(", start);
assert.notEqual(start, -1);
assert.notEqual(end, -1);
vm.runInContext(source.slice(start, end), context);

async function main() {
  const shortDescription = context.shortSkillDescription("Copilot helps. ".repeat(20));
  assert.ok(shortDescription.length <= 110);

  await context.loadSkills();
  assert.equal(skillsList.children.length, 1);
  const group = skillsList.children[0];
  assert.equal(group.children[0].textContent, "Skill");
  const row = group.children[1];
  const checkbox = row.children[0].children[0];
  assert.equal(checkbox.checked, true);
  assert.match(checkbox.attributes["aria-label"], /Disattiva/);
  assert.ok(row.children[0].children[1].children[1].textContent.length <= 110);
  assert.equal(row.children[1].textContent, "🗑");
  assert.match(row.children[1].attributes["aria-label"], /web-tests/);
  assert.equal(group.children[2].children.length, 1);

  checkbox.checked = false;
  await checkbox.listeners.change();
  assert.equal(JSON.stringify(request), JSON.stringify(["/api/skills/state", "PUT", {
    kind: "skills", name: "web-tests", enabled: false,
  }]));
  assert.equal(checkbox.checked, false);
  assert.match(checkbox.attributes["aria-label"], /Attiva/);
  assert.equal(checkbox.disabled, false);
  assert.match(notices[0], /disattivata/);

  requestError = new Error("errore CLI");
  checkbox.checked = true;
  await checkbox.listeners.change();
  assert.equal(checkbox.checked, false);
  assert.match(checkbox.attributes["aria-label"], /Attiva/);
  assert.equal(checkbox.disabled, false);
  assert.equal(notices[1], "errore CLI");

  requestError = null;
  skillSource.value = "https://example.org/skills/SKILL.md";
  await skillAddForm.listeners.submit({ preventDefault() {} });
  assert.equal(JSON.stringify(request), JSON.stringify([
    "/api/skills/add", "POST", { source: "https://example.org/skills/SKILL.md" },
  ]));
  assert.equal(skillSource.value, "");
  assert.equal(skillAddButton.disabled, false);
  assert.match(notices[2], /aggiunta/);

  requestError = new Error("skill rifiutata");
  skillSource.value = "/tmp/SKILL.md";
  await skillAddForm.listeners.submit({ preventDefault() {} });
  assert.equal(skillSource.value, "/tmp/SKILL.md");
  assert.equal(skillAddButton.disabled, false);
  assert.equal(notices[3], "skill rifiutata");

  const removeButton = row.children[1];
  confirmResult = false;
  await removeButton.listeners.click();
  assert.match(confirmMessage, /Eliminare definitivamente/);
  assert.equal(request[0], "/api/skills/add");

  confirmResult = true;
  requestError = null;
  await removeButton.listeners.click();
  assert.equal(JSON.stringify(request), JSON.stringify([
    "/api/skills/remove", "POST", { name: "web-tests" },
  ]));
  assert.equal(removeButton.disabled, false);
  assert.match(notices[4], /eliminata/);

  requestError = new Error("rimozione negata");
  await removeButton.listeners.click();
  assert.equal(removeButton.disabled, false);
  assert.equal(notices[5], "rimozione negata");

  console.log("Skill UI: aggiunta, checkbox, descrizioni brevi ed errori verificati");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
