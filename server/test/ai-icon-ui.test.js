const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const miniRoot = path.resolve(__dirname, "../../inCircleClient");

function read(relativePath) {
  return fs.readFileSync(path.join(miniRoot, relativePath), "utf8");
}

test("AI selection and send actions use stable image icons instead of CSS line fragments", () => {
  const providerTemplate = read("pages/ai-provider/index.wxml");
  const providerStyles = read("pages/ai-provider/index.wxss");
  const chatTemplate = read("pages/ai-chat/index.wxml");
  const chatStyles = read("pages/ai-chat/index.wxss");
  const checkIcon = read("images/icons/check.svg");
  const sendIcon = read("images/icons/send.svg");

  assert.match(providerTemplate, /class="provider-option-check-icon" src="\/images\/icons\/check\.svg"/);
  assert.doesNotMatch(providerStyles, /\.provider-option-check::before/);
  assert.match(chatTemplate, /class="send-icon" src="\/images\/icons\/send\.svg"/);
  assert.doesNotMatch(chatStyles, /\.send-arrow(?::|\s|\{)/);
  [checkIcon, sendIcon].forEach((icon) => {
    assert.match(icon, /viewBox="0 0 24 24"/);
    assert.match(icon, /stroke="#ffffff"/);
    assert.match(icon, /stroke-linecap="round"/);
  });
});
