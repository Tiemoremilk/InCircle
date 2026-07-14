const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatBeijingDateTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  const beijing = new Date(date.getTime() + BEIJING_OFFSET_MS);
  return `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(
    beijing.getUTCDate()
  )} ${pad(beijing.getUTCHours())}:${pad(beijing.getUTCMinutes())}:${pad(
    beijing.getUTCSeconds()
  )}`;
}

function beijingDateKey(value) {
  const hasValue = typeof value !== "undefined" && value !== null && value !== "";
  const date = hasValue ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  const beijing = new Date(date.getTime() + BEIJING_OFFSET_MS);
  return `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())}`;
}

function beijingParts(value) {
  const hasValue = typeof value !== "undefined" && value !== null && value !== "";
  const date = hasValue ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return null;
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

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

module.exports = {
  beijingDateKey,
  beijingParts,
  dateFromBeijingParts,
  formatBeijingDateTime,
  parseBeijingDateTime,
};
