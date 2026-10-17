const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

class Element {
  constructor(className = "") {
    this.className = className;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.textContent = "";
    this.classList = {
      contains: (name) => this.className.split(" ").includes(name),
      add: (name) => {
        if (!this.classList.contains(name)) this.className += ` ${name}`;
      },
      remove: (name) => {
        this.className = this.className.split(" ").filter((item) => item !== name).join(" ");
      },
    };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  querySelector(selector) {
    const match = selector.match(/^\[data-job-(pending|activity)="(.+)"\]$/);
    if (match) {
      const key = `job${match[1][0].toUpperCase()}${match[1].slice(1)}`;
      return this.children.find((child) => child.dataset[key] === match[2]) || null;
    }
    if (selector === ".thinking-label") {
      return this.children.find((child) => child.className === "thinking-label") || null;
    }
    if (selector === ".thinking-dots") {
      return this.children.find((child) => child.className === "thinking-dots") || null;
    }
    return null;
  }
  remove() {
    const parentIndex = messagesEl.children.indexOf(this);
    if (parentIndex >= 0) messagesEl.children.splice(parentIndex, 1);
  }
}

const messagesEl = new Element();
const context = vm.createContext({
  activeJobs: new Map(),
  currentChatId: "chat-a",
  pendingChatId: null,
  thinkingPhrases: ["phrase zéro", "phrase un", "phrase deux", "phrase trois"],
  document: { createElement: () => new Element() },
  messagesEl,
  sessionStorage: {
    values: new Map(),
    setItem(key, value) { this.values.set(key, value); },
    removeItem(key) { this.values.delete(key); },
  },
  updateChatBusyState() {},
  addMessage: (_text, className) => {
    const pending = new Element(`msg ${className} thinking`);
    const dots = new Element("thinking-dots");
    dots.append(new Element("dot"), new Element("dot"), new Element("dot"));
    pending.append(new Element("thinking-label"), dots);
    messagesEl.append(pending);
    return pending;
  },
});
const source = fs.readFileSync(path.join(__dirname, "../static/app.js"), "utf8");
const thinkingStart = source.indexOf("function setThinkingMessage(");
const thinkingEnd = source.indexOf("\nfunction addMessage(", thinkingStart);
vm.runInContext(source.slice(thinkingStart, thinkingEnd), context);
const start = source.indexOf("function toolActivityName(");
const end = source.indexOf("async function streamChat(", start);
vm.runInContext(source.slice(start, end), context);
const rememberStart = source.indexOf("function persistActiveJobs(");
const rememberEnd = source.indexOf("\nfunction clearJob(", rememberStart);
vm.runInContext(source.slice(rememberStart, rememberEnd), context);
const restoreStart = source.indexOf("async function restorePendingJob(");
const restoreEnd = source.indexOf("\nrestoreChat();", restoreStart);
vm.runInContext(source.slice(restoreStart, restoreEnd), context);
const adoptStart = source.indexOf("function adoptRunningJob(");
const adoptEnd = source.indexOf("\nasync function loadChatList(", adoptStart);
vm.runInContext(source.slice(adoptStart, adoptEnd), context);

const job = {
  id: "job-a",
  chat_id: "chat-a",
  progress: { content: "", tools: ["read", "grep"] },
  thinkingIndex: 3,
  thinkingUpdatedAt: 1234,
};
context.activeJobs.set(job.id, job);
context.renderJobProgress(job);
let pending = messagesEl.querySelector('[data-job-pending="job-a"]');
let activity = messagesEl.querySelector('[data-job-activity="job-a"]');
assert.equal(pending.querySelector(".thinking-label").textContent, "phrase trois");
assert.equal(pending.classList.contains("thinking"), true);
assert.equal(pending.querySelector(".thinking-dots").children.length, 3);
assert.deepEqual(activity.children.map((entry) => entry.textContent), ["Uso read", "Uso grep"]);

job.progress.content = "testo parziale riservato";
context.rememberJob(job);
const storedJobs = JSON.parse(context.sessionStorage.values.get("copilot-pending-jobs"));
assert.equal(storedJobs[0].progress.content, undefined);
assert.deepEqual(storedJobs[0].progress.tools, ["read", "grep"]);
job.progress.content = "";

pending.dataset.thinkingIndex = "2";
pending.dataset.thinkingUpdatedAt = "5678";
context.storeVisibleJobState();
assert.equal(job.thinkingIndex, 2);
assert.equal(job.thinkingUpdatedAt, 5678);

messagesEl.replaceChildren();
context.currentChatId = "chat-b";
context.renderJobProgress(job);
assert.equal(messagesEl.children.length, 0);
context.currentChatId = "chat-a";
context.renderActiveJobProgress("chat-a");
pending = messagesEl.querySelector('[data-job-pending="job-a"]');
activity = messagesEl.querySelector('[data-job-activity="job-a"]');
assert.equal(pending.querySelector(".thinking-label").textContent, "phrase deux");
assert.equal(pending.classList.contains("thinking"), true);
assert.equal(pending.querySelector(".thinking-dots").children.length, 3);
assert.deepEqual(activity.children.map((entry) => entry.textContent), ["Uso read", "Uso grep"]);

messagesEl.replaceChildren();
context.currentChatId = "chat-c";
context.waitForJob = () => new Promise(() => {});
context.adoptRunningJob({ id: "chat-c", job_id: "job-c" });
const adoptedJob = context.activeJobs.get("job-c");
assert.equal(adoptedJob.chat_id, "chat-c");
assert.equal(adoptedJob.accepted, true);
pending = messagesEl.querySelector('[data-job-pending="job-c"]');
activity = messagesEl.querySelector('[data-job-activity="job-c"]');
assert.equal(pending.classList.contains("thinking"), true);
assert.equal(pending.querySelector(".thinking-dots").children.length, 3);
assert.deepEqual(activity.children, []);

adoptedJob.progress.tools = ["shell — npm test"];
context.renderJobProgress(adoptedJob);
assert.deepEqual(activity.children.map((entry) => entry.textContent), ["Uso shell — npm test"]);
context.adoptRunningJob({ id: "chat-c", job_id: "job-c" });
assert.equal([...context.activeJobs.values()].filter((job) => job.chat_id === "chat-c").length, 1);

console.log("Progressi chat: cambio chat e adozione di job attivi ripristinano spinner e tool");
