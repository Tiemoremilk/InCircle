const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const componentRoot = path.resolve(__dirname, "../../inCircleClient/components/ai-fab");

function read(file) {
  return fs.readFileSync(path.join(componentRoot, file), "utf8");
}

test("AI FAB restores its position before rendering and only then enables motion", () => {
  const script = read("index.js");
  const template = read("index.wxml");

  assert.match(template, /wx:if="\{\{visible && positionReady\}\}"/);
  assert.match(template, /motionReady \? 'motion-ready' : ''/);
  assert.match(script, /positionReady: false/);
  assert.match(script, /motionReady: false/);
  assert.match(script, /if \(this\.refreshRequest && this\.refreshCircleId === circleId\) return this\.refreshRequest/);
  assert.match(script, /const restoredDock = this\.restorePosition\(circleId\);\s*if \(!restoredDock\) this\.scheduleSnap\(\)/);
  assert.match(script, /if \(!this\.data\.docked\) this\.scheduleSnap\(\)/);
});

test("AI FAB keeps the full circle onscreen and breathes from translucent to solid while docked", () => {
  const script = read("index.js");
  const template = read("index.wxml");
  const styles = read("index.wxss");

  assert.match(script, /minX: edgeInset/);
  assert.match(script, /maxX: Math\.max\(edgeInset, width - fab - edgeInset\)/);
  assert.match(template, /class="ai-bubble-cluster"/);
  assert.match(styles, /\.ai-fab-shell\.docked-right \.ai-bubble-one/);
  assert.match(styles, /\.ai-fab-shell\.docked-left \.ai-bubble-one/);
  assert.match(styles, /@keyframes ai-bubble-float-left/);
  assert.match(styles, /@keyframes ai-bubble-float-right/);
  assert.match(styles, /\.ai-fab-shell\.docked\s*\{[^}]*animation:\s*ai-fab-docked-presence 3\.4s ease-in-out infinite/s);
  assert.match(styles, /@keyframes ai-fab-docked-presence\s*\{[^}]*opacity:\s*0\.56/s);
  assert.match(styles, /45%, 55%\s*\{\s*opacity:\s*1/s);
  assert.match(styles, /\.ai-fab-shell\.pressed\s*\{[^}]*animation:\s*none;[^}]*opacity:\s*1/s);
  assert.match(styles, /\.ai-fab-shell\.reduce-motion\.docked\s*\{[^}]*animation:\s*none/s);
  assert.doesNotMatch(styles, /\.ai-fab-shell\.docked-(?:left|right) \.ai-fab-face/);
  assert.doesNotMatch(template, /ai-fab-grip/);
});
