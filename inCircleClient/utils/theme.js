const STORAGE_KEY = "incircle_theme_key";
const CUSTOM_STORAGE_KEY = "incircle_custom_theme_rgba";
const CUSTOM_THEME_KEY = "custom";
const DEFAULT_CUSTOM_THEME_RGBA = Object.freeze({ r: 47, g: 130, b: 89, a: 1 });
const TAB_BAR_PATHS = [
  "/pages/index/index",
  "/pages/activities/index",
  "/pages/tools/index",
  "/pages/docs/index",
  "/pages/members/index",
];
const TAB_BAR_CONTENT_HEIGHT_RPX = 92;
const TAB_PAGE_EXTRA_BOTTOM_RPX = 32;
let runtimeColorKey = "";
let tabBarMetrics = null;

const THEMES = [
  {
    key: "forest",
    name: "青柚",
    className: "theme-forest",
    primary: "#2f8259",
    primaryDark: "#205f42",
    accent: "#b7dd72",
    pageBg: "#f3faf6",
    navBg: "#f3faf6",
    tabBg: "#fcfefd",
    selectedColor: "#2f8259",
    swatch: "linear-gradient(135deg, #205f42, #2f8259 58%, #b7dd72)",
  },
  {
    key: "ocean",
    name: "海盐",
    className: "theme-ocean",
    primary: "#3472a8",
    primaryDark: "#24527b",
    accent: "#8fc9e8",
    pageBg: "#f2f8fc",
    navBg: "#f2f8fc",
    tabBg: "#fcfdff",
    selectedColor: "#3472a8",
    swatch: "linear-gradient(135deg, #24527b, #3472a8 58%, #8fc9e8)",
  },
  {
    key: "berry",
    name: "樱雾",
    className: "theme-berry",
    primary: "#b6577a",
    primaryDark: "#823e58",
    accent: "#f0b2c3",
    pageBg: "#fff5f8",
    navBg: "#fff5f8",
    tabBg: "#fffdfd",
    selectedColor: "#b6577a",
    swatch: "linear-gradient(135deg, #823e58, #b6577a 58%, #f0b2c3)",
  },
  {
    key: "graphite",
    name: "月白",
    className: "theme-graphite",
    primary: "#5e6c78",
    primaryDark: "#414d57",
    accent: "#b8cbd2",
    pageBg: "#f6f8f9",
    navBg: "#f6f8f9",
    tabBg: "#fdfefe",
    selectedColor: "#5e6c78",
    swatch: "linear-gradient(135deg, #414d57, #5e6c78 58%, #b8cbd2)",
  },
  {
    key: "coral",
    name: "珊瑚",
    className: "theme-coral",
    primary: "#bc5745",
    primaryDark: "#874033",
    accent: "#f7af8f",
    pageBg: "#fff5f2",
    navBg: "#fff5f2",
    tabBg: "#fffdfc",
    selectedColor: "#bc5745",
    swatch: "linear-gradient(135deg, #874033, #bc5745 58%, #f7af8f)",
  },
  {
    key: "peacock",
    name: "青瓷",
    className: "theme-peacock",
    primary: "#247f7a",
    primaryDark: "#195c59",
    accent: "#9fd9cd",
    pageBg: "#f2faf9",
    navBg: "#f2faf9",
    tabBg: "#fcfffe",
    selectedColor: "#247f7a",
    swatch: "linear-gradient(135deg, #195c59, #247f7a 58%, #9fd9cd)",
  },
  {
    key: "cyan",
    name: "柠霜",
    className: "theme-cyan",
    primary: "#83701f",
    primaryDark: "#5d4f16",
    accent: "#e7d77a",
    pageBg: "#fffcf1",
    navBg: "#fffcf1",
    tabBg: "#fffef9",
    selectedColor: "#83701f",
    swatch: "linear-gradient(135deg, #5d4f16, #83701f 55%, #e7d77a)",
  },
  {
    key: "mint",
    name: "青梅",
    className: "theme-mint",
    primary: "#68783d",
    primaryDark: "#4a572b",
    accent: "#c4d292",
    pageBg: "#f8faf2",
    navBg: "#f8faf2",
    tabBg: "#fefefb",
    selectedColor: "#68783d",
    swatch: "linear-gradient(135deg, #4a572b, #68783d 55%, #c4d292)",
  },
  {
    key: "sky",
    name: "雾霁",
    className: "theme-sky",
    primary: "#5275a5",
    primaryDark: "#3b567d",
    accent: "#b8d2ea",
    pageBg: "#f5f8fc",
    navBg: "#f5f8fc",
    tabBg: "#fdfefe",
    selectedColor: "#5275a5",
    swatch: "linear-gradient(135deg, #3b567d, #5275a5 55%, #b8d2ea)",
  },
  {
    key: "apricot",
    name: "蜜杏",
    className: "theme-apricot",
    primary: "#a86732",
    primaryDark: "#784822",
    accent: "#edbe85",
    pageBg: "#fff8f1",
    navBg: "#fff8f1",
    tabBg: "#fffefa",
    selectedColor: "#a86732",
    swatch: "linear-gradient(135deg, #784822, #a86732 55%, #edbe85)",
  },
  {
    key: "lilac",
    name: "丁香",
    className: "theme-lilac",
    primary: "#8b699c",
    primaryDark: "#654b72",
    accent: "#d7c3e0",
    pageBg: "#faf7fc",
    navBg: "#faf7fc",
    tabBg: "#fffefe",
    selectedColor: "#8b699c",
    swatch: "linear-gradient(135deg, #654b72, #8b699c 55%, #d7c3e0)",
  },
];

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeCustomThemeRgba(value, fallback) {
  let source = value;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch (error) {
      source = null;
    }
  }
  if (source && typeof source === "object") {
    const r = Number(source.r);
    const g = Number(source.g);
    const b = Number(source.b);
    const a = Number(source.a);
    if (
      Number.isInteger(r) && r >= 0 && r <= 255 &&
      Number.isInteger(g) && g >= 0 && g <= 255 &&
      Number.isInteger(b) && b >= 0 && b <= 255 &&
      Number.isFinite(a) && a >= 0 && a <= 1
    ) {
      return { r, g, b, a: Math.round(a * 100) / 100 };
    }
  }
  const safe = fallback && typeof fallback === "object" ? fallback : DEFAULT_CUSTOM_THEME_RGBA;
  return { r: safe.r, g: safe.g, b: safe.b, a: safe.a };
}

function getStoredCustomThemeRgba() {
  try {
    return normalizeCustomThemeRgba(wx.getStorageSync(CUSTOM_STORAGE_KEY), DEFAULT_CUSTOM_THEME_RGBA);
  } catch (error) {
    return normalizeCustomThemeRgba(null, DEFAULT_CUSTOM_THEME_RGBA);
  }
}

function getCustomThemeRgba() {
  try {
    const app = typeof getApp === "function" ? getApp() : null;
    const value = app && app.globalData && app.globalData.customTheme;
    return normalizeCustomThemeRgba(value, getStoredCustomThemeRgba());
  } catch (error) {
    return getStoredCustomThemeRgba();
  }
}

function saveCustomThemeRgba(value) {
  const rgba = normalizeCustomThemeRgba(value, getStoredCustomThemeRgba());
  try {
    wx.setStorageSync(CUSTOM_STORAGE_KEY, rgba);
  } catch (error) {
    // Storage can fail in smoke-test contexts.
  }
  try {
    const app = typeof getApp === "function" ? getApp() : null;
    if (app && app.globalData) app.globalData.customTheme = rgba;
  } catch (error) {
    // getApp can fail before App is initialized.
  }
  return rgba;
}

function mixRgb(source, target, ratio) {
  const weight = clamp(Number(ratio || 0), 0, 1);
  return source.map((value, index) => Math.round(value + (target[index] - value) * weight));
}

function rgbHex(rgb) {
  return `#${rgb.map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

function rgbaCss(rgb, alpha) {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${Math.round(clamp(alpha, 0, 1) * 100) / 100})`;
}

function whiteContrast(rgb) {
  const channels = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return 1.05 / (luminance + 0.05);
}

function readablePrimary(rgb) {
  let result = rgb.slice();
  for (let darkness = 0; whiteContrast(result) < 4.6 && darkness < 0.8; darkness += 0.05) {
    result = mixRgb(rgb, [0, 0, 0], darkness + 0.05);
  }
  return result;
}

function rgbToHsl(rgb) {
  const values = rgb.map((channel) => channel / 255);
  const maximum = Math.max(...values);
  const minimum = Math.min(...values);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta) {
    if (maximum === values[0]) hue = ((values[1] - values[2]) / delta) % 6;
    else if (maximum === values[1]) hue = (values[2] - values[0]) / delta + 2;
    else hue = (values[0] - values[1]) / delta + 4;
    hue = (hue * 60 + 360) % 360;
  }
  const lightness = (maximum + minimum) / 2;
  const saturation = delta ? delta / (1 - Math.abs(2 * lightness - 1)) : 0;
  return { hue, saturation, lightness };
}

function iconFilterFor(rgb) {
  const hsl = rgbToHsl(rgb);
  const invert = Math.round(35 + hsl.lightness * 30);
  const sepia = Math.round(hsl.saturation * 75);
  const saturate = Math.round(180 + hsl.saturation * 1500);
  const rotation = Math.round((hsl.hue - 38 + 360) % 360);
  const brightness = Math.round(82 + hsl.lightness * 18);
  return `brightness(0) saturate(100%) invert(${invert}%) sepia(${sepia}%) saturate(${saturate}%) hue-rotate(${rotation}deg) brightness(${brightness}%) contrast(90%)`;
}

function buildCustomTheme(value) {
  const customRgba = normalizeCustomThemeRgba(value, DEFAULT_CUSTOM_THEME_RGBA);
  const raw = [customRgba.r, customRgba.g, customRgba.b];
  const primaryRgb = readablePrimary(raw);
  const primaryDarkRgb = mixRgb(primaryRgb, [0, 0, 0], 0.2);
  const accentRgb = mixRgb(raw, [255, 255, 255], 0.56 + (1 - customRgba.a) * 0.12);
  const pageRgb = mixRgb(raw, [255, 255, 255], 0.92 + (1 - customRgba.a) * 0.04);
  const pageEndRgb = mixRgb(raw, [255, 255, 255], 0.87 + (1 - customRgba.a) * 0.05);
  const primary = rgbHex(primaryRgb);
  const primaryDark = rgbHex(primaryDarkRgb);
  const accent = rgbHex(accentRgb);
  const pageBg = rgbHex(pageRgb);
  const softAlpha = 0.08 + customRgba.a * 0.14;
  const borderAlpha = 0.12 + customRgba.a * 0.14;
  const shadowAlpha = 0.08 + customRgba.a * 0.1;
  const iconFilter = iconFilterFor(primaryRgb);
  const pageStyle = [
    `--theme-page-bg: linear-gradient(180deg, ${pageBg} 0%, #ffffff 52%, ${rgbHex(pageEndRgb)} 100%)`,
    `--theme-primary: ${primary}`,
    `--theme-primary-dark: ${primaryDark}`,
    `--theme-accent: ${accent}`,
    `--theme-soft: ${rgbaCss(raw, softAlpha)}`,
    `--theme-warm: ${rgbaCss(accentRgb, 0.28 + customRgba.a * 0.12)}`,
    "--theme-danger-soft: #fff1ef",
    `--theme-card-active-border: ${rgbaCss(raw, borderAlpha)}`,
    `--theme-hero-shadow: ${rgbaCss(raw, shadowAlpha)}`,
    `--theme-button-shadow: ${rgbaCss(raw, Math.max(0.08, shadowAlpha - 0.02))}`,
    `--theme-notice-bg: ${rgbaCss(pageRgb, 0.88)}`,
    `--theme-notice-border: ${rgbaCss(raw, borderAlpha)}`,
    `--theme-icon-filter: ${iconFilter}`,
  ].join("; ") + ";";
  return {
    key: CUSTOM_THEME_KEY,
    name: "自定义",
    className: "theme-forest theme-custom",
    primary,
    primaryDark,
    accent,
    pageBg,
    navBg: pageBg,
    tabBg: rgbHex(mixRgb(raw, [255, 255, 255], 0.97)),
    selectedColor: primary,
    swatch: rgbaCss(raw, customRgba.a),
    iconFilter,
    customRgba,
    pageStyle,
    tabBarVariables: [
      `--tabbar-bg: ${rgbaCss(mixRgb(raw, [255, 255, 255], 0.96), 0.96)}`,
      `--tabbar-border: ${rgbaCss(raw, borderAlpha)}`,
      `--tabbar-shadow: ${rgbaCss(raw, Math.max(0.06, shadowAlpha - 0.02))}`,
      `--tabbar-active: ${primary}`,
      `--tabbar-active-filter: ${iconFilter}`,
    ].join("; ") + ";",
  };
}

function findTheme(key, customRgba) {
  if (key === CUSTOM_THEME_KEY) return buildCustomTheme(customRgba || getCustomThemeRgba());
  return THEMES.find((theme) => theme.key === key) || THEMES[0];
}

function getStoredThemeKey() {
  try {
    return wx.getStorageSync(STORAGE_KEY) || THEMES[0].key;
  } catch (error) {
    return THEMES[0].key;
  }
}

function getCurrentTheme() {
  try {
    const app = typeof getApp === "function" ? getApp() : null;
    const key = app && app.globalData && app.globalData.themeKey ? app.globalData.themeKey : getStoredThemeKey();
    const customRgba = app && app.globalData ? app.globalData.customTheme : null;
    return findTheme(key, customRgba);
  } catch (error) {
    return findTheme(getStoredThemeKey());
  }
}

function getSafeBottomRpx() {
  if (typeof wx === "undefined") return 0;
  try {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const windowWidth = info.windowWidth || info.screenWidth || 375;
    const screenHeight = info.screenHeight || info.windowHeight || 0;
    const safeBottomPx =
      info.safeArea && typeof info.safeArea.bottom === "number" && screenHeight
        ? Math.max(0, screenHeight - info.safeArea.bottom)
        : 0;
    const safeBottomRpx = Math.round((safeBottomPx * 750) / windowWidth);
    return Math.min(Math.max(safeBottomRpx, 0), 90);
  } catch (error) {
    return 0;
  }
}

function getTabBarMetrics() {
  if (!tabBarMetrics) {
    const safeBottomRpx = getSafeBottomRpx();
    const heightRpx = TAB_BAR_CONTENT_HEIGHT_RPX + safeBottomRpx;
    tabBarMetrics = {
      safeBottomRpx,
      heightRpx,
      pagePaddingBottomRpx: heightRpx + TAB_PAGE_EXTRA_BOTTOM_RPX,
    };
  }
  return tabBarMetrics;
}

function getTabBarStyle() {
  const metrics = getTabBarMetrics();
  const currentTheme = getCurrentTheme();
  const variables = currentTheme.key === CUSTOM_THEME_KEY ? ` ${currentTheme.tabBarVariables}` : "";
  return `height: ${metrics.heightRpx}rpx; padding-bottom: ${metrics.safeBottomRpx}rpx;${variables}`;
}

function getTabPageInsetStyle() {
  const metrics = getTabBarMetrics();
  return `--incircle-tabbar-height: ${metrics.heightRpx}rpx; --incircle-tabbar-page-bottom: ${metrics.pagePaddingBottomRpx}rpx;`;
}

function applyRuntimeColors(theme, options) {
  if (typeof wx === "undefined") return;
  const force = options && options.force;
  const nextRuntimeColorKey = theme.navBg;
  if (!force && runtimeColorKey === nextRuntimeColorKey) return;
  runtimeColorKey = nextRuntimeColorKey;
  if (wx.setNavigationBarColor) {
    wx.setNavigationBarColor({
      frontColor: "#000000",
      backgroundColor: theme.navBg,
    });
  }
}

function syncCustomTabBar(page) {
  if (!page || typeof page.getTabBar !== "function") return;
  const route = page.route ? `/${page.route}` : "";
  if (TAB_BAR_PATHS.indexOf(route) === -1) return;
  const tabBar = page.getTabBar();
  if (tabBar && typeof tabBar.refresh === "function") {
    tabBar.refresh({ currentPath: route });
  }
}

function getThemeOptions(activeKey, options) {
  const source = THEMES.slice();
  if (options && options.includeCustom) source.push(buildCustomTheme(getCustomThemeRgba()));
  return source.map((theme) =>
    Object.assign({}, theme, {
      activeClass: theme.key === activeKey ? "active" : "",
    })
  );
}

function applyPageTheme(page) {
  if (!page || typeof page.setData !== "function") return;
  const theme = getCurrentTheme();
  applyRuntimeColors(theme);
  const data = page.data || {};
  const nextData = {};
  const tabBarInsetStyle = getTabPageInsetStyle();
  const themeStyle = theme.pageStyle || "";
  const includeCustom = data.allowCustomThemeOption === true;
  const optionSignature = `${theme.key}:${includeCustom ? JSON.stringify(getCustomThemeRgba()) : "presets"}`;
  const expectedOptionCount = THEMES.length + (includeCustom ? 1 : 0);
  const themeChanged = data.themeKey !== theme.key || data.themeClass !== theme.className || data.themeStyle !== themeStyle;
  if (data.themeKey !== theme.key) nextData.themeKey = theme.key;
  if (data.themeClass !== theme.className) nextData.themeClass = theme.className;
  if (data.themePrimary !== theme.primary) nextData.themePrimary = theme.primary;
  if (data.themeStyle !== themeStyle) nextData.themeStyle = themeStyle;
  if (data.tabBarInsetStyle !== tabBarInsetStyle) nextData.tabBarInsetStyle = tabBarInsetStyle;
  if (
    themeChanged ||
    (Object.prototype.hasOwnProperty.call(data, "themeOptions") &&
      (!Array.isArray(data.themeOptions) || data.themeOptions.length !== expectedOptionCount || data.themeOptionSignature !== optionSignature))
  ) {
    nextData.themeOptions = getThemeOptions(theme.key, { includeCustom });
    nextData.themeOptionSignature = optionSignature;
  }
  if (Object.keys(nextData).length) {
    page.setData(nextData);
  }
  return theme;
}

function setTheme(key, customRgba) {
  const savedCustomRgba = typeof customRgba === "undefined"
    ? getCustomThemeRgba()
    : saveCustomThemeRgba(customRgba);
  const theme = findTheme(key, savedCustomRgba);
  try {
    wx.setStorageSync(STORAGE_KEY, theme.key);
  } catch (error) {
    // Storage can fail in smoke-test contexts.
  }
  try {
    const app = typeof getApp === "function" ? getApp() : null;
    if (app && app.globalData) {
      app.globalData.themeKey = theme.key;
      app.globalData.customTheme = savedCustomRgba;
    }
  } catch (error) {
    // getApp can fail before App is initialized.
  }
  applyRuntimeColors(theme, { force: true });
  try {
    const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];
    syncCustomTabBar(pages[pages.length - 1]);
  } catch (error) {
    // getCurrentPages can fail in smoke-test contexts.
  }
  return theme;
}

module.exports = {
  CUSTOM_THEME_KEY,
  DEFAULT_CUSTOM_THEME_RGBA,
  THEMES,
  buildCustomTheme,
  getCustomThemeRgba,
  getCurrentTheme,
  getThemeOptions,
  getTabBarStyle,
  getTabPageInsetStyle,
  applyPageTheme,
  syncCustomTabBar,
  normalizeCustomThemeRgba,
  setTheme,
};
