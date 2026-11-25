"use strict";
// Run: node --test ui/layout.test.js
// Lint for the page. The page once grew as lists filled up (buttons moved under the pointer, everything needed scrolling), and a
// reload lost the form. These checks keep the layout compact and every control the script needs present.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const read = (f) => fs.readFileSync(path.join(__dirname, f), "utf8");
const html = read("index.html");
const css = read("styles.css").replace(/\/\*[\s\S]*?\*\//g, ""); // comments removed, so they cannot be mistaken for selectors
const app = read("app.js");

// Rules inside @media apply only to some windows, so the base layout is judged without them.
const baseCss = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");

/** The last declaration of a property for a selector, the way the cascade will use it (later rules win). */
function lastDeclaration(selector, prop) {
  let found = null;
  const blocks = baseCss.matchAll(/([^{}]+)\{([^{}]*)\}/g);
  for (const [, sel, body] of blocks) {
    if (!sel.split(",").map((s) => s.trim()).includes(selector)) continue;
    const m = body.match(new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`));
    if (m) found = m[1].trim();
  }
  return found;
}

test("every element the script looks up exists in the page", () => {
  const used = new Set([...app.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]));
  const have = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  assert.deepStrictEqual([...used].filter((id) => !have.has(id)), [], "ids the script needs but the page lacks");
});

test("every list that can grow has a height limit and scrolls inside itself", () => {
  for (const sel of [".volumes", ".drive-actions", ".picker-list", ".dests", ".activity", ".errors", ".summary", ".history", "#check-body"]) {
    assert.ok(lastDeclaration(sel, "max-height"), `${sel} needs a max-height`);
    const overflow = lastDeclaration(sel, "overflow-y") || lastDeclaration(sel, "overflow");
    assert.ok(overflow && /auto|scroll/.test(overflow), `${sel} must scroll inside itself`);
  }
});

test("the app is the size of the window, and each panel scrolls on its own", () => {
  for (const sel of ["html", "body"]) {
    assert.match(lastDeclaration(sel, "height") || "", /100%/, `${sel} is as tall as the window`);
    assert.match(lastDeclaration(sel, "overflow") || "", /hidden/, `${sel} itself never scrolls`);
  }
  assert.match(lastDeclaration(".panel", "overflow-y") || "", /auto/, "panels scroll");
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*overflow: auto/, "a narrow window falls back to a scrolling page");
});

test("the buttons that run a copy sit outside the scrolling form, so they never move", () => {
  const scrollEnd = html.indexOf("</div>", html.indexOf('id="drive-actions"'));
  const footer = html.indexOf('class="actions footer"');
  assert.ok(footer > scrollEnd, "the action buttons come after the scrolling area");
  assert.match(lastDeclaration(".panel.setup > .footer", "flex") || "", /0 0 auto/, "and do not shrink");
});

test("the controls people asked for are in the page and wired in the script", () => {
  for (const id of ["picker-newname", "picker-newfolder", "skip-system-files", "history", "errors-count"]) {
    assert.ok(html.includes(`id="${id}"`), `${id} is in the page`);
    assert.ok(app.includes(`getElementById("${id}")`), `${id} is used by the script`);
  }
  assert.match(app, /\/api\/folders", \{\s*method: "POST"/, "New folder calls the server");
  assert.match(app, /skipSystemFiles: el\.skipSystemFiles\.checked/, "the option is sent with the job");
  assert.match(app, /DitDraft\.write/, "the form is remembered");
  assert.match(app, /\/api\/reveal/, "a destination can be shown in the file manager");
});

test("sizes use the decimal units drives and Finder use", () => {
  assert.match(app, /v >= 1000/, "the page counts in thousands");
  assert.doesNotMatch(app, /v >= 1024/, "not in 1024s labelled GB");
});
