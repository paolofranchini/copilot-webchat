const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../static/app.js"), "utf8");
const context = vm.createContext({
  URL,
  window: { location: { href: "http://webchat.test/" } },
});
vm.runInContext(
  source.slice(source.indexOf("function escapeHtml("), source.indexOf("async function readApiResponse("))
    + source.slice(source.indexOf("function imageUrl("), source.indexOf("function formatMessageTime(")),
  context,
);
const render = (text) => context.renderMarkdown(text);

const remote = render('![Una "foto" <bella>](https://example.com/a.png?x=1&y=2)');
assert.ok(remote.includes('<img src="https://example.com/a.png?x=1&amp;y=2"'));
assert.ok(remote.includes('alt="Una &quot;foto&quot; &lt;bella&gt;"'));
assert.ok(remote.includes('target="_blank" rel="noopener noreferrer"'));
assert.ok(remote.includes('referrerpolicy="no-referrer"'));
assert.ok(remote.includes('loading="lazy"'));

const local = "/api/chats/12345678-1234-1234-1234-123456789abc/images/uno%20due.png";
assert.ok(render(`![Diagramma](${local})`).includes(`src="http://webchat.test${local}"`));
assert.ok(!render(`![X](${local.replace("uno%20due.png", "../privata.png")})`).includes("<img "));
assert.equal((render("![A](https://e.test/a.png)\n![B](https://e.test/b.png)").match(/<img /g) || []).length, 2);
for (const url of ["javascript:alert%281%29", "data:image/png;base64,abc", "file:///tmp/x.png",
  "//example.com/x.png", "/etc/passwd", "https://user:secret@example.com/x.png"]) {
  assert.ok(!render(`![X](${url})`).includes("<img "), url);
}
assert.ok(!render("`![X](https://e.test/x.png)`").includes("<img "));
assert.ok(!render("```\n![X](https://e.test/x.png)\n```").includes("<img "));
assert.equal(render("`**letterale**`"), "<code>**letterale**</code>");
assert.equal(render("# Titolo\n**forte** e *corsivo*"), "<h1>Titolo</h1><br><strong>forte</strong> e <em>corsivo</em>");
assert.ok(render("| A | B |\n| --- | --- |\n| 1 | 2 |").includes("<table>"));
const references = render(
  'Consulta [1] e [documentazione][2].\n\n'
  + '[1]: https://example.com/uno "Titolo uno"\n'
  + '[2]: https://example.com/due',
);
assert.ok(references.includes('href="https://example.com/uno" title="Titolo uno"'));
assert.ok(references.includes('href="https://example.com/due"'));
assert.ok(references.includes(">1</a>") && references.includes(">documentazione</a>"));
assert.ok(references.includes('[1]: <a class="markdown-link"'));
assert.ok(references.includes(">https://example.com/uno</a> \"Titolo uno\""));
assert.ok(references.includes("[2]: <a"));
const inlineLink = render('[Leggi qui](https://example.com/docs?a=1&b=2 "Guida")');
assert.ok(inlineLink.includes('href="https://example.com/docs?a=1&amp;b=2"'));
assert.ok(inlineLink.includes('title="Guida"'));
assert.ok(inlineLink.includes(">Leggi qui</a>"));
assert.ok(!render("[link](javascript:alert%281%29)").includes("<a "));
assert.ok(!render("`[1](https://example.com)`").includes("<a "));
assert.ok(!render("```\n[1](https://example.com)\n```").includes("<a "));
assert.ok(!render('<img src=x onerror="alert(1)">').includes("<img "));
assert.ok(render('![x" onerror="alert(1)](https://e.test/x.png)').includes('alt="x&quot; onerror=&quot;alert(1)"'));
assert.ok(render("@@MARKDOWN_FRAGMENT_0@@ ![X](https://e.test/x.png)").startsWith("@@MARKDOWN_FRAGMENT_0@@ "));
assert.ok(render('![X](https://e.test/$&.png)').includes('src="https://e.test/$&amp;.png"'));
console.log("Markdown: immagini e link sicuri verificati");
