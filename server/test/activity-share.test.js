const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const clientRoot = path.resolve(__dirname, "../../inCircleClient");
const pagePath = path.join(clientRoot, "pages/activity-detail/index.js");
const dependencyPaths = [
  "utils/api.js",
  "utils/media.js",
  "utils/editIntent.js",
  "utils/dialog.js",
].map((file) => path.join(clientRoot, file));

function cssRule(styles, selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule: ${selector}`);
  return match[1];
}

function loadPage(wxMock, currentCircleId) {
  const previousModules = dependencyPaths.map((modulePath) => require.cache[modulePath]);
  dependencyPaths.forEach((modulePath) => {
    require.cache[modulePath] = {
      id: modulePath,
      filename: modulePath,
      loaded: true,
      exports: {},
    };
  });

  let definition;
  global.Page = (value) => { definition = value; };
  global.getApp = () => ({ globalData: { currentCircleId: currentCircleId || "" } });
  global.wx = wxMock;
  delete require.cache[pagePath];
  try {
    require(pagePath);
  } finally {
    dependencyPaths.forEach((modulePath, index) => {
      if (previousModules[index]) require.cache[modulePath] = previousModules[index];
      else delete require.cache[modulePath];
    });
  }

  assert.ok(definition, "activity detail Page definition was not registered");
  const page = Object.assign({}, definition);
  page.data = JSON.parse(JSON.stringify(definition.data));
  page.setData = function setData(values) {
    Object.assign(this.data, values || {});
  };
  return page;
}

test.afterEach(() => {
  delete require.cache[pagePath];
  delete global.Page;
  delete global.getApp;
  delete global.wx;
});

test("activity detail returns native WeChat share cards with one encoded detail path", () => {
  const shareMenus = [];
  const clipboardWrites = [];
  const page = loadPage({
    showShareMenu(options) { shareMenus.push(options); },
    setClipboardData(options) { clipboardWrites.push(options.data); },
    showToast() {},
  });

  page.onLoad({ id: "activity/1", circleId: "circle 1" });
  page.data.activity = { id: "activity/1", circleId: "circle 1", title: "周末羽毛球" };

  assert.deepEqual(shareMenus, [{
    withShareTicket: true,
    menus: ["shareAppMessage", "shareTimeline"],
  }]);
  assert.deepEqual(page.onShareAppMessage(), {
    title: "周末羽毛球：来表态",
    path: "/pages/activity-detail/index?id=activity%2F1&circleId=circle%201",
  });
  assert.deepEqual(page.shareToGroup(), page.onShareAppMessage());
  assert.deepEqual(page.onShareTimeline(), {
    title: "周末羽毛球：来表态",
    query: "id=activity%2F1&circleId=circle%201",
  });
  assert.deepEqual(clipboardWrites, []);
});

test("copying activity share text remains an explicit fallback using the same share path", () => {
  const clipboardWrites = [];
  const page = loadPage({
    showShareMenu() {},
    setClipboardData(options) {
      clipboardWrites.push(options.data);
      if (options.success) options.success();
    },
    showToast() {},
  }, "circle-current");

  page.onLoad({ id: "activity-2" });
  page.data.activity = {
    id: "activity-2",
    title: "桌游局",
    status: "报名中",
    time: "周六 19:00",
    location: "活动室",
    fee: "免费",
    coming: 3,
    capacity: 6,
    needCount: 3,
    silent: [],
  };
  page.copyShareText();

  assert.equal(clipboardWrites.length, 1);
  assert.match(
    clipboardWrites[0],
    /小程序路径：\/pages\/activity-detail\/index\?id=activity-2&circleId=circle-current/
  );
});

test("activity detail native share button has no duplicated inline icon", () => {
  const template = fs.readFileSync(
    path.join(clientRoot, "pages/activity-detail/index.wxml"),
    "utf8"
  );
  const shareButton = template.match(
    /<button\b(?=[^>]*\bclass="[^"]*\bshare-action\b[^"]*")(?=[^>]*\bopen-type="share")[^>]*>[\s\S]*?<\/button>/
  );

  assert.ok(shareButton, "activity detail should render one native share button");
  assert.doesNotMatch(shareButton[0], /<image\b/);
  assert.doesNotMatch(template, /bindtap="shareToGroup"/);
});

test("activity quick actions use complete columns without overflowing grid cells", () => {
  const template = fs.readFileSync(
    path.join(clientRoot, "pages/activity-detail/index.wxml"),
    "utf8"
  );
  const styles = fs.readFileSync(
    path.join(clientRoot, "pages/activity-detail/index.wxss"),
    "utf8"
  );
  const baseGridRule = cssRule(styles, ".quick-actions");
  const deleteGridRule = cssRule(styles, ".quick-actions.has-delete");
  const slotRule = cssRule(styles, ".quick-action-slot");
  const actionRule = cssRule(styles, ".quick-action");

  assert.match(
    template,
    /class="quick-actions[^"{]*\{\{activity\.canDelete \? 'has-delete' : ''\}\}"/
  );
  assert.match(template, /wx:if="\{\{activity\.canDelete\}\}" class="quick-action-slot"/);
  assert.match(template, /class="quick-action danger/);
  assert.match(
    baseGridRule,
    /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/
  );
  assert.match(
    deleteGridRule,
    /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/
  );
  assert.match(slotRule, /width:\s*100%;/);
  assert.match(slotRule, /overflow:\s*hidden;/);
  assert.match(actionRule, /min-width:\s*0;/);
  assert.match(actionRule, /width:\s*100%;/);
  assert.match(actionRule, /box-sizing:\s*border-box;/);
});

test("activity detail keeps a real empty recap surface and themed map action", () => {
  const template = fs.readFileSync(
    path.join(clientRoot, "pages/activity-detail/index.wxml"),
    "utf8"
  );
  const styles = fs.readFileSync(
    path.join(clientRoot, "pages/activity-detail/index.wxss"),
    "utf8"
  );

  assert.match(template, /activity\.hasRecap/);
  assert.match(template, /class="recap-empty card"/);
  assert.match(styles, /\.recap-cta\s*\{/);
  assert.match(styles, /\.location-action\s*\{[\s\S]*var\(--theme-primary-dark/s);
});
