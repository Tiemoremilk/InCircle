const PRIVACY_DENIED_CODES = Object.freeze({ 103: true, 104: true });

function errorInfo(error) {
  const source = error || {};
  const numericCodes = [source.errno, source.errCode, source.errorCode]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  const numericCode = numericCodes.find((value) => PRIVACY_DENIED_CODES[value] || value === 112)
    || numericCodes.find((value) => value !== 0)
    || numericCodes[0];
  return {
    code: Number.isFinite(numericCode) ? numericCode : null,
    errCode: source.errCode === undefined ? "" : String(source.errCode),
    errMsg: String(source.errMsg || source.message || "").slice(0, 240),
  };
}

function classifyPrivacyFailure(error) {
  const info = errorInfo(error);
  const message = info.errMsg.toLowerCase();
  if (
    PRIVACY_DENIED_CODES[info.code]
    || /privacy permission is not authorized/.test(message)
    || /privacy authorization.*(?:deny|denied|cancel)/.test(message)
  ) return "privacy-denied";
  if (
    info.code === 112
    || /api scope is not declared in the privacy agreement/.test(message)
    || /appid privacy api banned/.test(message)
  ) return "privacy-config-error";
  return "";
}

function privateApiFailureMessage(error, fallback) {
  const reason = classifyPrivacyFailure(error);
  if (reason === "privacy-denied") return "未同意微信隐私授权";
  if (reason === "privacy-config-error") return "微信隐私配置尚未生效";
  return fallback || "当前功能暂不可用";
}

function logPrivateApiFailure(apiName, error) {
  if (typeof console === "undefined" || typeof console.warn !== "function") return;
  const info = errorInfo(error);
  console.warn(`[${String(apiName || "private-api")}] failed`, info);
}

module.exports = {
  classifyPrivacyFailure,
  errorInfo,
  logPrivateApiFailure,
  privateApiFailureMessage,
};
