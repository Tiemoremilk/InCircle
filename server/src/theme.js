const DEFAULT_THEME_KEY = "forest";
const DEFAULT_CUSTOM_THEME_RGBA = Object.freeze({ r: 47, g: 130, b: 89, a: 1 });
const PRESET_THEME_KEYS = Object.freeze([
  "forest",
  "ocean",
  "berry",
  "graphite",
  "coral",
  "peacock",
  "cyan",
  "mint",
  "sky",
  "apricot",
  "lilac",
]);
const THEME_KEYS = Object.freeze(PRESET_THEME_KEYS.concat(["custom"]));

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
  if (fallback === null) return null;
  const safeFallback = fallback && typeof fallback === "object" ? fallback : DEFAULT_CUSTOM_THEME_RGBA;
  return { r: safeFallback.r, g: safeFallback.g, b: safeFallback.b, a: safeFallback.a };
}

function normalizeThemeKey(value, fallback) {
  const key = String(value || "").trim().toLowerCase().replace(/^theme-/, "");
  if (THEME_KEYS.includes(key)) return key;
  return typeof fallback === "undefined" ? DEFAULT_THEME_KEY : fallback;
}

function legacyThemeKey(source, fallback) {
  const data = source && typeof source === "object" ? source : {};
  const direct = normalizeThemeKey(data.themeKey || data.theme_key || data.theme, "");
  if (direct) return direct;

  const camelIndex = Number(data.themeIndex);
  if (Number.isInteger(camelIndex) && camelIndex >= 0 && camelIndex < PRESET_THEME_KEYS.length) {
    return PRESET_THEME_KEYS[camelIndex];
  }
  const databaseIndex = Number(data.theme_index);
  if (Number.isInteger(databaseIndex) && databaseIndex >= 1 && databaseIndex <= PRESET_THEME_KEYS.length) {
    return PRESET_THEME_KEYS[databaseIndex - 1];
  }
  return typeof fallback === "undefined" ? DEFAULT_THEME_KEY : fallback;
}

module.exports = {
  DEFAULT_CUSTOM_THEME_RGBA,
  DEFAULT_THEME_KEY,
  PRESET_THEME_KEYS,
  THEME_KEYS,
  legacyThemeKey,
  normalizeCustomThemeRgba,
  normalizeThemeKey,
};
