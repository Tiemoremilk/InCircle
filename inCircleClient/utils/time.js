const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function padTimeUnit(value) {
  return String(value).padStart(2, "0");
}

function toDate(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? null : date;
}

function beijingParts(value) {
  const date = toDate(typeof value === "undefined" || value === null || value === "" ? Date.now() : value);
  if (!date) return null;
  const beijing = new Date(date.getTime() + BEIJING_OFFSET_MS);
  return {
    year: beijing.getUTCFullYear(),
    month: beijing.getUTCMonth() + 1,
    day: beijing.getUTCDate(),
    hour: beijing.getUTCHours(),
    minute: beijing.getUTCMinutes(),
    second: beijing.getUTCSeconds(),
  };
}

function dateFromBeijingParts(year, month, day, hour, minute, second) {
  const date = new Date(Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0) - BEIJING_OFFSET_MS);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseBeijingDateTime(value, reference) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  const raw = String(value || "").trim();
  if (!raw) return null;
  const refParts = beijingParts(reference) || beijingParts();
  if (!refParts) return null;
  const text = raw
    .replace(/[年月]/g, "-")
    .replace(/[日号]/g, " ")
    .replace(/(北京时间|截止|截至|前|之前|到期)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let matched = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:(?:\s+|T)(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (matched) {
    return dateFromBeijingParts(
      Number(matched[1]),
      Number(matched[2]),
      Number(matched[3]),
      Number(matched[4] || 22),
      Number(matched[5] || 0),
      Number(matched[6] || 0)
    );
  }

  matched = text.match(/^(\d{1,2})-(\d{1,2})(?:(?:\s+|T)(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (matched) {
    return dateFromBeijingParts(
      refParts.year,
      Number(matched[1]),
      Number(matched[2]),
      Number(matched[3] || 22),
      Number(matched[4] || 0),
      Number(matched[5] || 0)
    );
  }

  matched = text.match(/^(今晚|今天)\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (matched) {
    return dateFromBeijingParts(
      refParts.year,
      refParts.month,
      refParts.day,
      Number(matched[2]),
      Number(matched[3]),
      Number(matched[4] || 0)
    );
  }

  matched = text.match(/^明天\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (matched) {
    const todayMidnight = dateFromBeijingParts(refParts.year, refParts.month, refParts.day, 0, 0, 0);
    const tomorrow = new Date(todayMidnight.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowParts = beijingParts(tomorrow);
    return dateFromBeijingParts(
      tomorrowParts.year,
      tomorrowParts.month,
      tomorrowParts.day,
      Number(matched[1]),
      Number(matched[2]),
      Number(matched[3] || 0)
    );
  }

  matched = text.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (matched) {
    return dateFromBeijingParts(
      refParts.year,
      refParts.month,
      refParts.day,
      Number(matched[1]),
      Number(matched[2]),
      Number(matched[3] || 0)
    );
  }

  return toDate(raw);
}

function toTimestamp(value, valueMs, fallbackId) {
  const explicitMs = Number(valueMs || 0);
  if (explicitMs) return explicitMs;
  const parsed = parseBeijingDateTime(value);
  if (parsed) return parsed.getTime();
  return timestampFromId(fallbackId);
}

function formatDateTime(value) {
  const date = toDate(value);
  if (!date) return "";
  const beijing = new Date(date.getTime() + BEIJING_OFFSET_MS);
  return `${beijing.getUTCFullYear()}-${padTimeUnit(beijing.getUTCMonth() + 1)}-${padTimeUnit(beijing.getUTCDate())} ${padTimeUnit(beijing.getUTCHours())}:${padTimeUnit(beijing.getUTCMinutes())}:${padTimeUnit(beijing.getUTCSeconds())}`;
}

function formatDateMinute(value) {
  return formatDateTime(value).slice(0, 16);
}

function nowDateTime() {
  return formatDateTime(Date.now());
}

function timestampFromId(id) {
  const matched = String(id || "").match(/-(\d{13})(?:-|$)/);
  return matched ? Number(matched[1]) : 0;
}

function isDisplayDateTime(value) {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(String(value || ""));
}

function displayDateTime(value, valueMs, fallbackId) {
  if (valueMs) return formatDateTime(valueMs);
  const idMs = timestampFromId(fallbackId);
  if (idMs) return formatDateTime(idMs);
  if (value === "刚刚") return "";
  if (value) {
    if (isDisplayDateTime(value)) return value;
    return formatDateTime(value) || String(value);
  }
  return value || "";
}

module.exports = {
  beijingParts,
  dateFromBeijingParts,
  formatDateTime,
  formatDateMinute,
  nowDateTime,
  parseBeijingDateTime,
  timestampFromId,
  toTimestamp,
  displayDateTime,
};
