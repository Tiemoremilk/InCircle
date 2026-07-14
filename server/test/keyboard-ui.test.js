const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const miniProgramRoot = path.resolve(__dirname, "../../inCircleClient");

function walk(directory, extension) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(fullPath, extension);
    return entry.name.endsWith(extension) ? [fullPath] : [];
  });
}

function read(relativePath) {
  return fs.readFileSync(path.join(miniProgramRoot, relativePath), "utf8");
}

function keyframes(styles, name) {
  const marker = `@keyframes ${name}`;
  const start = styles.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist`);
  const open = styles.indexOf("{", start + marker.length);
  let depth = 0;
  for (let index = open; index < styles.length; index += 1) {
    if (styles[index] === "{") depth += 1;
    if (styles[index] === "}") depth -= 1;
    if (depth === 0) return styles.slice(open + 1, index);
  }
  throw new Error(`${name} is not balanced`);
}

test("all native text controls declare a keyboard policy and explicit cursor gap", () => {
  const controls = [];
  for (const file of walk(miniProgramRoot, ".wxml")) {
    const template = fs.readFileSync(file, "utf8");
    for (const match of template.matchAll(/<(?:input|textarea)\b[\s\S]*?>/g)) {
      controls.push({ file, tag: match[0] });
    }
  }

  assert.ok(controls.length >= 60);
  for (const control of controls) {
    assert.match(control.tag, /adjust-position="\{\{(?:true|false)\}\}"/, `${control.file} must declare adjustment`);
    assert.match(control.tag, /cursor-spacing="(?:24|96)"/, `${control.file} must declare its keyboard gap`);
  }

  const manualControls = controls.filter((control) => /adjust-position="\{\{false\}\}"/.test(control.tag));
  assert.equal(manualControls.length, 2);
  for (const control of manualControls) {
    assert.match(control.file.replaceAll("\\", "/"), /pages\/ai-chat\/index\.wxml$/);
    assert.match(control.tag, /bindkeyboardheightchange="onKeyboardHeightChange"/);
  }
});

test("shared keyboard controller uses WeChat's reported keyboard height for fixed surfaces", () => {
  const keyboardModule = require(path.join(miniProgramRoot, "utils/keyboard.js"));
  const keyboardSource = read("utils/keyboard.js");
  const appSource = read("app.js");

  assert.match(keyboardSource, /wx\.onKeyboardHeightChange/);
  assert.match(keyboardSource, /inset:\s*height/);
  assert.doesNotMatch(keyboardSource, /wx\.onWindowResize/);
  assert.doesNotMatch(keyboardSource, /getWindowInfo|window\.innerHeight/);
  assert.match(keyboardSource, /--incircle-keyboard-inset/);
  assert.doesNotMatch(keyboardSource, /incircle-keyboard-viewport-height/);
  assert.match(appSource, /keyboard\.attach/);
  assert.match(appSource, /keyboard\.detach/);
});

test("keyboard events immediately update and reset the shared fixed-surface inset", () => {
  const keyboardModule = require(path.join(miniProgramRoot, "utils/keyboard.js"));
  const previousWx = global.wx;
  let keyboardListener;
  global.wx = {
    onKeyboardHeightChange: (listener) => { keyboardListener = listener; },
    offKeyboardHeightChange: () => {},
  };
  const page = {
    data: {},
    updates: 0,
    setData(values, callback) {
      this.updates += 1;
      Object.assign(this.data, values);
      if (callback) callback();
    },
  };

  try {
    keyboardModule.attach(page);
    assert.equal(page.updates, 0, "opening a page without a keyboard must not trigger an extra layout render");
    keyboardListener({ height: 300 });
    assert.equal(page.data.incircleKeyboardInset, 300);
    assert.equal(page.data.incircleKeyboardPageStyle, "--incircle-keyboard-inset:300px;");

    keyboardListener({ height: 0 });
    assert.equal(page.data.incircleKeyboardInset, 0);
  } finally {
    keyboardModule.detach(page);
    if (previousWx === undefined) delete global.wx;
    else global.wx = previousWx;
  }
});

test("AI chat keeps a fixed composer above the shared keyboard inset", () => {
  const template = read("pages/ai-chat/index.wxml");
  const script = read("pages/ai-chat/index.js");
  const styles = read("pages/ai-chat/index.wxss");

  assert.match(template, /^<page-meta page-style="\{\{themeStyle\}\} \{\{incircleKeyboardPageStyle\}\}"><\/page-meta>/);
  assert.doesNotMatch(template, /chatPageStyle|keyboardOverlayStyle/);
  assert.doesNotMatch(script, /currentWindowHeight|baseWindowHeight|keyboardMeasureTimer|requiredInset|composerKeyboardInset|measureSurface|calculateSurfaceInset/);
  assert.match(template, /class="chat-page[^\n]*style="padding-bottom: calc\(164rpx \+ env\(safe-area-inset-bottom\) \+ \{\{incircleKeyboardInset\}\}px\);"/);
  assert.match(template, /class="composer-input"[\s\S]*?fixed="\{\{true\}\}"[\s\S]*?adjust-position="\{\{false\}\}"[\s\S]*?cursor-spacing="24"/);
  assert.match(template, /class="composer-wrap" style="bottom: \{\{incircleKeyboardInset\}\}px;"/);
  assert.match(styles, /\.chat-page\s*\{[^}]*height:\s*100vh/s);
  assert.doesNotMatch(styles, /incircle-keyboard-viewport-height/);
  assert.match(styles, /\.composer-wrap\s*\{[^}]*position:\s*fixed;[^}]*bottom:\s*var\(--incircle-keyboard-inset,\s*0px\)/s);
});

test("fixed create forms preserve natural sheets and use native keyboard alignment", () => {
  const globalStyles = read("app.wxss");
  assert.match(globalStyles, /\.tools-page \.sheet-mask,[\s\S]*?bottom:\s*var\(--incircle-tabbar-height,\s*92rpx\)/);

  for (const page of ["activities", "tools", "docs", "members"]) {
    const template = read(`pages/${page}/index.wxml`);
    const script = read(`pages/${page}/index.js`);
    assert.match(template, /<page-meta page-style="[^"]*incircleKeyboardPageStyle/);
    assert.doesNotMatch(template, /formScrollIntoView|onFixedFormFocus|data-keyboard-target/);
    assert.doesNotMatch(script, /focusFixedSurface|scrollFocusedSurface|formScrollIntoView/);

    const textareas = [...template.matchAll(/<textarea\b[\s\S]*?>/g)].map((match) => match[0]);
    for (const textarea of textareas) {
      assert.match(textarea, /adjust-position="\{\{true\}\}"/);
      assert.match(textarea, /adjust-keyboard-to="bottom"/);
      assert.match(textarea, /cursor-spacing="96"/);
    }
  }

  for (const page of ["activities", "tools", "docs"]) {
    const styles = read(`pages/${page}/index.wxss`);
    assert.match(styles, /\.create-sheet\s*\{[^}]*max-height:\s*88vh;[^}]*overflow-y:\s*auto;/s);
    assert.doesNotMatch(styles, /\.create-sheet-scroll\s*\{/);
    assert.doesNotMatch(styles, /\.sheet-mask\.keyboard-open/);
  }
});

test("containers that can own native inputs never animate their coordinate system", () => {
  const globalStyles = read("app.wxss");
  const dialogStyles = read("components/theme-dialog/index.wxss");

  assert.doesNotMatch(globalStyles, /@keyframes incirclePageReveal/);
  assert.doesNotMatch(globalStyles, /\.page\s*\{[^}]*animation\s*:/s);
  for (const name of ["incircleSheetReveal"]) {
    assert.doesNotMatch(keyframes(globalStyles, name), /transform\s*:/, `${name} must remain keyboard-safe`);
  }
  for (const name of ["dialog-panel-in", "dialog-panel-out"]) {
    assert.doesNotMatch(keyframes(dialogStyles, name), /transform\s*:/, `${name} must remain keyboard-safe`);
  }
});
