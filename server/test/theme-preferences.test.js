const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { InCircleService } = require("../src/services/incircle");
const {
  DEFAULT_CUSTOM_THEME_RGBA,
  DEFAULT_THEME_KEY,
  PRESET_THEME_KEYS,
  THEME_KEYS,
  legacyThemeKey,
  normalizeCustomThemeRgba,
  normalizeThemeKey,
} = require("../src/theme");
const miniTheme = require("../../inCircleClient/utils/theme");

const root = path.resolve(__dirname, "../..");

function relativeLuminance(hex) {
  const channels = [1, 3, 5]
    .map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function whiteContrast(hex) {
  return 1.05 / (relativeLuminance(hex) + 0.05);
}

function rgbDistance(first, second) {
  const rgb = (hex) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
  const left = rgb(first);
  const right = rgb(second);
  return Math.hypot(...left.map((value, index) => value - right[index]));
}

test("eleven presets plus one custom theme stay distinct and accessible", () => {
  const themes = miniTheme.THEMES;
  assert.deepEqual(
    themes.map((theme) => theme.key),
    PRESET_THEME_KEYS
  );
  assert.equal(themes.length, 11);
  assert.deepEqual(THEME_KEYS, PRESET_THEME_KEYS.concat(["custom"]));
  const pickerOptions = miniTheme.getThemeOptions("custom", { includeCustom: true });
  assert.equal(pickerOptions.length, 12);
  assert.equal(pickerOptions[pickerOptions.length - 1].key, "custom");
  assert.equal(pickerOptions.some((theme) => theme.key === "iris"), false);
  assert.equal(new Set(themes.map((theme) => theme.name)).size, themes.length);
  assert.equal(new Set(themes.map((theme) => theme.primary)).size, themes.length);
  themes.forEach((theme) => {
    assert.match(theme.primary, /^#[0-9a-f]{6}$/i);
    assert.ok(whiteContrast(theme.primary) >= 4.5, `${theme.key} primary must support white button text`);
  });
  for (let left = 0; left < themes.length; left += 1) {
    for (let right = left + 1; right < themes.length; right += 1) {
      assert.ok(
        rgbDistance(themes[left].primary, themes[right].primary) >= 28,
        `${themes[left].key} and ${themes[right].key} are too visually similar`
      );
    }
  }
});

test("Mini Program palette metadata and WXSS variables stay synchronized", () => {
  const styles = fs.readFileSync(path.join(root, "inCircleClient/app.wxss"), "utf8").toLowerCase();
  assert.doesNotMatch(styles, /incircle-theme-sync\s+\*/, "WXSS does not support the universal descendant selector");
  miniTheme.THEMES.forEach((theme) => {
    const match = styles.match(new RegExp(`\\.theme-${theme.key}\\s*\\{([\\s\\S]*?)\\}`));
    assert.ok(match, `missing WXSS block for ${theme.key}`);
    const block = match[1];
    assert.ok(block.includes(`--theme-primary: ${theme.primary.toLowerCase()}`));
    assert.ok(block.includes(`--theme-primary-dark: ${theme.primaryDark.toLowerCase()}`));
    assert.ok(block.includes(`--theme-accent: ${theme.accent.toLowerCase()}`));
    assert.ok(block.includes(theme.pageBg.toLowerCase()));
  });
});

test("custom tabbar selected icons stay synchronized with all preset themes", () => {
  const appStyles = fs.readFileSync(path.join(root, "inCircleClient/app.wxss"), "utf8").toLowerCase();
  const tabbarStyles = fs.readFileSync(path.join(root, "inCircleClient/custom-tab-bar/index.wxss"), "utf8").toLowerCase();
  const compact = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const variable = (block, name) => {
    const match = block.match(new RegExp(`--${name}:\\s*([^;]+);`));
    return match ? compact(match[1]) : "";
  };

  miniTheme.THEMES.forEach((theme) => {
    const appMatch = appStyles.match(new RegExp(`\\.theme-${theme.key}\\s*\\{([\\s\\S]*?)\\}`));
    const tabbarMatch = tabbarStyles.match(
      new RegExp(`\\.custom-tabbar\\.theme-${theme.key}\\s*\\{([\\s\\S]*?)\\}`)
    );
    assert.ok(appMatch, `missing app theme block for ${theme.key}`);
    assert.ok(tabbarMatch, `missing tabbar theme block for ${theme.key}`);
    assert.equal(variable(tabbarMatch[1], "tabbar-active"), theme.primary.toLowerCase());
    assert.equal(
      variable(tabbarMatch[1], "tabbar-active-filter"),
      variable(appMatch[1], "theme-icon-filter"),
      `${theme.key} tabbar icon filter is stale`
    );
    assert.ok(variable(tabbarMatch[1], "tabbar-shadow"), `${theme.key} tabbar shadow is missing`);
  });

  assert.match(tabbarStyles, /\.custom-tabbar \.tabbar-item\.active \.tabbar-icon\s*\{[^}]*var\(--tabbar-active-filter/s);
});

test("legacy and invalid theme preferences normalize safely", () => {
  assert.equal(DEFAULT_THEME_KEY, "forest");
  assert.equal(normalizeThemeKey("theme-sky"), "sky");
  assert.equal(normalizeThemeKey("unknown"), "forest");
  assert.equal(normalizeThemeKey("unknown", ""), "");
  assert.equal(normalizeThemeKey("custom"), "custom");
  assert.equal(normalizeThemeKey("iris"), "forest");
  assert.equal(legacyThemeKey({ themeIndex: 6 }, ""), "cyan");
  assert.equal(legacyThemeKey({ theme_index: 11 }, ""), "lilac");
  assert.deepEqual(normalizeCustomThemeRgba({ r: 12, g: 34, b: 56, a: 0.42 }), { r: 12, g: 34, b: 56, a: 0.42 });
  assert.equal(normalizeCustomThemeRgba({ r: 999, g: 0, b: 0, a: 1 }, null), null);
});

test("theme preference adopts once, then explicit updates persist a validated key", async () => {
  const queries = [];
  const service = Object.create(InCircleService.prototype);
  service.db = {
    async query(sql, params) {
      queries.push({ sql, params });
      return {
        rows: [{
          id: params[0],
          theme_key: params[1],
          custom_theme_rgba: params[2] ? JSON.parse(params[2]) : DEFAULT_CUSTOM_THEME_RGBA,
        }],
      };
    },
  };
  service.requireUser = async () => ({ user: { id: "user-1" } });

  const existing = { id: "user-1", theme_key: "berry" };
  assert.equal(await service.syncClientThemePreference(existing, { clientThemeKey: "sky" }), existing);
  assert.equal(queries.length, 0);

  const adopted = await service.syncClientThemePreference(
    { id: "user-1", theme_key: null },
    { clientThemeKey: "mint" }
  );
  assert.equal(adopted.theme_key, "mint");
  assert.equal(queries.length, 1);

  const explicit = await service.syncClientThemePreference(existing, {
    clientThemeKey: "sky",
    themePreferenceExplicit: true,
  });
  assert.equal(explicit.theme_key, "sky");
  assert.deepEqual(queries[1].params, ["user-1", "sky", true]);

  const updated = await service.updateTheme({ themeKey: "lilac" });
  assert.deepEqual(updated, { themeKey: "lilac", customTheme: DEFAULT_CUSTOM_THEME_RGBA });
  assert.deepEqual(queries[2].params, ["user-1", "lilac", JSON.stringify(DEFAULT_CUSTOM_THEME_RGBA)]);

  const rgba = { r: 18, g: 96, b: 173, a: 0.65 };
  const custom = await service.updateTheme({ themeKey: "custom", customTheme: rgba });
  assert.deepEqual(custom, { themeKey: "custom", customTheme: rgba });
  assert.deepEqual(queries[3].params, ["user-1", "custom", JSON.stringify(rgba)]);

  await assert.rejects(
    () => service.updateTheme({ themeKey: "not-a-theme" }),
    (error) => error && error.errCode === "INVALID_THEME"
  );
  await assert.rejects(
    () => service.updateTheme({ themeKey: "custom", customTheme: { r: -1, g: 2, b: 3, a: 1 } }),
    (error) => error && error.errCode === "INVALID_CUSTOM_THEME"
  );
});

test("theme preference is wired through schema, migration, API and authenticated route", () => {
  const schema = fs.readFileSync(path.join(root, "server/db/schema.sql"), "utf8");
  const migration = fs.readFileSync(
    path.join(root, "server/db/migrations/0019_custom_theme_rgba.sql"),
    "utf8"
  );
  const api = fs.readFileSync(path.join(root, "inCircleClient/utils/api.js"), "utf8");
  const route = fs.readFileSync(path.join(root, "server/src/routes/incircle.js"), "utf8");

  assert.match(schema, /theme_key text DEFAULT 'forest'/);
  assert.match(schema, /custom_theme_rgba jsonb/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS custom_theme_rgba jsonb/);
  assert.match(migration, /UPDATE incircle_users SET theme_key = 'forest' WHERE theme_key = 'iris'/);
  assert.match(api, /requestAction\("incircleUpdateTheme", Object\.assign/);
  assert.match(route, /case "incircleUpdateTheme":\s*return service\.updateTheme\(body\)/);
});

test("custom theme derives global variables and every page receives them", () => {
  const custom = miniTheme.buildCustomTheme({ r: 220, g: 180, b: 35, a: 0.4 });
  assert.equal(custom.key, "custom");
  assert.match(custom.className, /theme-custom/);
  assert.match(custom.pageStyle, /--theme-primary:/);
  assert.match(custom.pageStyle, /--theme-icon-filter:/);
  assert.match(custom.tabBarVariables, /--tabbar-active:/);
  assert.equal(custom.swatch, "rgba(220, 180, 35, 0.4)");

  const app = JSON.parse(fs.readFileSync(path.join(root, "inCircleClient/app.json"), "utf8"));
  app.pages.forEach((page) => {
    const template = fs.readFileSync(path.join(root, "inCircleClient", `${page}.wxml`), "utf8");
    assert.match(template, /<page-meta page-style="\{\{themeStyle\}\}/, page);
  });
});

test("circle switch offers a live RGBA picker and truncates long circle descriptions", () => {
  const script = fs.readFileSync(path.join(root, "inCircleClient/pages/circle-switch/index.js"), "utf8");
  const template = fs.readFileSync(path.join(root, "inCircleClient/pages/circle-switch/index.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(root, "inCircleClient/pages/circle-switch/index.wxss"), "utf8");

  assert.match(template, /custom-theme-mask/);
  ["r", "g", "b", "a"].forEach((channel) => {
    assert.match(template, new RegExp(`data-channel="${channel}"`));
  });
  assert.match(template, /bindchanging="onCustomThemeChannelChange"/);
  assert.match(script, /updateTheme\(theme\.CUSTOM_THEME_KEY, rgba\)/);
  assert.match(script, /themeOptions\[\$\{customIndex\}\]\.swatch/);
  assert.match(styles, /\.recent-circle-row \.circle-copy\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
});

test("custom RGBA selection persists locally and applies to a live page", async () => {
  const previousWx = global.wx;
  const previousGetApp = global.getApp;
  const previousGetCurrentPages = global.getCurrentPages;
  const storage = {};
  const app = { globalData: {} };
  global.wx = {
    getStorageSync(key) { return storage[key]; },
    setStorageSync(key, value) { storage[key] = value; },
    setNavigationBarColor() {},
    setBackgroundColor() {},
    nextTick(callback) { setImmediate(callback); },
  };
  global.getApp = () => app;
  global.getCurrentPages = () => [];

  let page = null;
  try {
    const rgba = { r: 28, g: 104, b: 188, a: 0.72 };
    const selected = miniTheme.setTheme("custom", rgba);
    await miniTheme.whenThemeReady();
    assert.equal(selected.key, "custom");
    assert.deepEqual(app.globalData.customTheme, rgba);

    page = {
      data: { allowCustomThemeOption: true },
      setData(next, callback) {
        Object.assign(this.data, next);
        if (callback) callback();
      },
    };
    miniTheme.applyPageTheme(page);
    assert.equal(page.data.themeKey, "custom");
    assert.match(page.data.themeClass, /theme-custom/);
    assert.match(page.data.themeStyle, /--theme-primary:/);
    assert.equal(page.data.themeOptions.length, 12);
    assert.equal(page.data.themeOptions[11].activeClass, "active");
    assert.match(miniTheme.getTabBarStyle(), /--tabbar-active:/);
  } finally {
    if (page) miniTheme.unregisterPage(page);
    if (previousWx === undefined) delete global.wx;
    else global.wx = previousWx;
    if (previousGetApp === undefined) delete global.getApp;
    else global.getApp = previousGetApp;
    if (previousGetCurrentPages === undefined) delete global.getCurrentPages;
    else global.getCurrentPages = previousGetCurrentPages;
  }
});

test("theme changes prime every cached page and flush the target before its route is restored", async () => {
  const previousWx = global.wx;
  const previousGetApp = global.getApp;
  const previousGetCurrentPages = global.getCurrentPages;
  const storage = {};
  const app = {
    globalData: {
      themeKey: "forest",
      customTheme: DEFAULT_CUSTOM_THEME_RGBA,
    },
  };
  const visibleSettingsPage = { route: "pages/circle-switch/index" };
  let beforeAppRoute = null;
  const makePage = (route) => ({
    route,
    data: {},
    updates: 0,
    renderedClasses: [],
    setData(next, callback) {
      this.updates += 1;
      Object.assign(this.data, next);
      if (next.themeClass) this.renderedClasses.push(next.themeClass);
      setImmediate(() => {
        if (callback) callback();
      });
    },
  });
  const makeTabBar = () => ({
    data: {
      themeClass: miniTheme.getCurrentTheme().className,
      tabBarStyle: miniTheme.getTabBarStyle(),
    },
    updates: 0,
    renderedClasses: [],
    refreshTheme(options) {
      const settings = options || {};
      const current = settings.theme || miniTheme.getCurrentTheme();
      const themeClass = `${current.className}${settings.suppressMotion ? " incircle-theme-sync" : ""}`;
      this.updates += 1;
      this.data.themeClass = themeClass;
      this.data.tabBarStyle = miniTheme.getTabBarStyle();
      this.renderedClasses.push(themeClass);
      return new Promise((resolve) => setImmediate(() => resolve(true)));
    },
  });
  const home = makePage("pages/index/index");
  const tools = makePage("pages/tools/index");
  const pageDefinition = {};
  let homeTabBar = null;
  let toolsTabBar = null;

  global.wx = {
    getStorageSync(key) { return storage[key]; },
    setStorageSync(key, value) { storage[key] = value; },
    setNavigationBarColor() {},
    setBackgroundColor() {},
    nextTick(callback) { setImmediate(callback); },
    onBeforeAppRoute(callback) { beforeAppRoute = callback; },
    getWindowInfo() { return { windowWidth: 375, screenHeight: 812, safeArea: { bottom: 778 } }; },
  };
  global.getApp = () => app;
  global.getCurrentPages = () => [visibleSettingsPage];

  try {
    miniTheme.installRouteThemeSync();
    miniTheme.registerPageDefinition(pageDefinition);
    miniTheme.applyPageTheme(home);
    miniTheme.applyPageTheme(tools);
    homeTabBar = makeTabBar();
    toolsTabBar = makeTabBar();
    miniTheme.registerCustomTabBar(homeTabBar);
    miniTheme.registerCustomTabBar(toolsTabBar);
    home.updates = 0;
    tools.updates = 0;
    home.renderedClasses = [];
    tools.renderedClasses = [];
    homeTabBar.renderedClasses = [];
    toolsTabBar.renderedClasses = [];

    miniTheme.setTheme("berry");
    assert.equal(miniTheme.isThemeTransitioning(), true);
    await miniTheme.whenThemeReady();

    assert.equal(home.data.themeKey, "berry");
    assert.equal(tools.data.themeKey, "berry");
    assert.equal(pageDefinition.themeKey, "berry");
    assert.equal(pageDefinition.themeClass, "theme-berry");
    assert.equal(home.data.themeClass, "theme-berry incircle-theme-sync");
    assert.equal(tools.data.themeClass, "theme-berry incircle-theme-sync");
    assert.equal(Object.hasOwn(home.data, "themeOptions"), false);
    assert.equal(Object.hasOwn(tools.data, "themeOptions"), false);
    assert.equal(home.updates, 1);
    assert.equal(tools.updates, 1);
    assert.equal(homeTabBar.data.themeClass, "theme-berry incircle-theme-sync");
    assert.equal(toolsTabBar.data.themeClass, "theme-berry incircle-theme-sync");
    assert.equal(homeTabBar.updates, 1);
    assert.equal(toolsTabBar.updates, 1);
    assert.match(home.renderedClasses[0], /incircle-theme-sync/);
    assert.match(homeTabBar.renderedClasses[0], /incircle-theme-sync/);
    assert.equal(miniTheme.isThemeTransitioning(), false);

    assert.equal(typeof beforeAppRoute, "function");
    beforeAppRoute({ openType: "switchTab", path: "/pages/index/index" });
    assert.match(home.data.themeClass, /theme-berry incircle-theme-sync incircle-theme-frame-[ab]/);
    assert.match(home.data.themeStyle, /--incircle-theme-frame: route-[ab]/);
    assert.equal(home.updates, 2);
    miniTheme.applyPageTheme(home);
    miniTheme.acknowledgePageShown(home);
    assert.equal(home.data.themeClass, "theme-berry");
    assert.equal(home.updates, 3);
    assert.equal(tools.data.themeClass, "theme-berry incircle-theme-sync");

    beforeAppRoute({ openType: "navigateBack", path: "/pages/tools/index" });
    assert.match(tools.data.themeClass, /theme-berry incircle-theme-sync incircle-theme-frame-[ab]/);
    assert.match(tools.data.themeStyle, /--incircle-theme-frame: route-[ab]/);

    const firstCustomStyle = home.data.themeStyle;
    miniTheme.setTheme("custom", { r: 36, g: 112, b: 184, a: 0.42 });
    await miniTheme.whenThemeReady();
    assert.match(home.data.themeClass, /theme-custom/);
    assert.notEqual(home.data.themeStyle, firstCustomStyle);
    assert.match(home.data.themeStyle, /--theme-primary:/);
    assert.match(homeTabBar.data.tabBarStyle, /--tabbar-active:/);
  } finally {
    miniTheme.unregisterPage(home);
    miniTheme.unregisterPage(tools);
    if (homeTabBar) miniTheme.unregisterCustomTabBar(homeTabBar);
    if (toolsTabBar) miniTheme.unregisterCustomTabBar(toolsTabBar);
    if (previousWx === undefined) delete global.wx;
    else global.wx = previousWx;
    if (previousGetApp === undefined) delete global.getApp;
    else global.getApp = previousGetApp;
    if (previousGetCurrentPages === undefined) delete global.getCurrentPages;
    else global.getCurrentPages = previousGetCurrentPages;
  }
});

test("an older session response cannot overwrite a theme preference being saved", async () => {
  const previousWx = global.wx;
  const previousGetApp = global.getApp;
  const previousGetCurrentPages = global.getCurrentPages;
  const storage = {};
  const app = { globalData: { themeKey: "forest", customTheme: DEFAULT_CUSTOM_THEME_RGBA } };
  let preferenceToken = null;

  global.wx = {
    getStorageSync(key) { return storage[key]; },
    setStorageSync(key, value) { storage[key] = value; },
    setNavigationBarColor() {},
    setBackgroundColor() {},
    nextTick(callback) { setImmediate(callback); },
  };
  global.getApp = () => app;
  global.getCurrentPages = () => [];

  try {
    preferenceToken = miniTheme.beginPreferenceSave();
    miniTheme.setTheme("sky");
    await miniTheme.whenThemeReady();

    miniTheme.setThemeFromServer("forest");
    assert.equal(miniTheme.getCurrentTheme().key, "sky");

    miniTheme.endPreferenceSave(preferenceToken);
    preferenceToken = null;
    miniTheme.setThemeFromServer("mint");
    await miniTheme.whenThemeReady();
    assert.equal(miniTheme.getCurrentTheme().key, "mint");
  } finally {
    if (preferenceToken !== null) miniTheme.endPreferenceSave(preferenceToken);
    if (previousWx === undefined) delete global.wx;
    else global.wx = previousWx;
    if (previousGetApp === undefined) delete global.getApp;
    else global.getApp = previousGetApp;
    if (previousGetCurrentPages === undefined) delete global.getCurrentPages;
    else global.getCurrentPages = previousGetCurrentPages;
  }
});

test("theme consumers subscribe for their full cached lifetime", () => {
  const appSource = fs.readFileSync(path.join(root, "inCircleClient/app.js"), "utf8");
  const tabBarSource = fs.readFileSync(path.join(root, "inCircleClient/custom-tab-bar/index.js"), "utf8");
  const tabBarTemplate = fs.readFileSync(path.join(root, "inCircleClient/custom-tab-bar/index.wxml"), "utf8");
  const aiFabSource = fs.readFileSync(path.join(root, "inCircleClient/components/ai-fab/index.js"), "utf8");
  const switchSource = fs.readFileSync(path.join(root, "inCircleClient/pages/circle-switch/index.js"), "utf8");

  assert.match(appSource, /registerPageDefinition\(config\.data\)/);
  assert.match(appSource, /installRouteThemeSync\(\)/);
  assert.match(appSource, /acknowledgePageShown\(this\)/);
  assert.match(appSource, /config\.onUnload = function[\s\S]*theme\.unregisterPage\(this\)/);
  assert.doesNotMatch(appSource, /config\.onHide = function[\s\S]*theme\.unregisterPage\(this\)[\s\S]*config\.onUnload/);
  assert.match(tabBarSource, /attached\(\)[\s\S]*registerCustomTabBar\(this\)/);
  assert.match(tabBarSource, /detached\(\)[\s\S]*unregisterCustomTabBar\(this\)/);
  assert.match(tabBarSource, /refreshTheme\(options\)[\s\S]*themeOnly:\s*true/);
  assert.match(tabBarSource, /whenThemeReady\(\)\.then\(performSwitch\)/);
  assert.match(tabBarTemplate, /themeReady && !hidden/);
  assert.match(aiFabSource, /registerVisualConsumer\(this\)/);
  assert.match(aiFabSource, /unregisterVisualConsumer\(this\)/);
  assert.match(switchSource, /beginPreferenceSave\(\)/);
  assert.match(switchSource, /theme\.whenThemeReady\(\)/);
  assert.doesNotMatch(switchSource, /wx\.reLaunch/);
  assert.doesNotMatch(switchSource, /已保存.*主题|自定义主题已应用/);
  assert.doesNotMatch(switchSource, /setTheme\([^\n]+\);\s*theme\.applyPageTheme\(this\)/);
});
