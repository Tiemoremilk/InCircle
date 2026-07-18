const { AppError } = require("./errors");

const TENCENT_GEOCODER_URL = "https://apis.map.qq.com/ws/geocoder/v1/";
const GEOCODER_TIMEOUT_MS = 5000;

function cleanText(value, maximum) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function invalidLocation() {
  return new AppError("登录定位数据无效，请重新获取", {
    statusCode: 400,
    errCode: "INVALID_LOGIN_LOCATION",
  });
}

function normalizeLoginLocation(source) {
  const value = source && typeof source === "object" ? source : {};
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  if (
    !Number.isFinite(latitude)
    || !Number.isFinite(longitude)
    || latitude < -90
    || latitude > 90
    || longitude < -180
    || longitude > 180
  ) {
    throw invalidLocation();
  }

  let accuracy = null;
  if (value.accuracy !== null && typeof value.accuracy !== "undefined" && value.accuracy !== "") {
    accuracy = Number(value.accuracy);
    if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100000) throw invalidLocation();
  }

  return {
    // Seven decimal places keep more precision than phone GPS normally provides
    // without persisting unstable floating-point tails.
    latitude: Number(latitude.toFixed(7)),
    longitude: Number(longitude.toFixed(7)),
    accuracy: accuracy === null ? null : Number(accuracy.toFixed(1)),
  };
}

function emptyAddress() {
  return {
    province: "",
    city: "",
    district: "",
    detail: "",
    resolved: false,
  };
}

async function reverseGeocodeTencent(location, key, options) {
  const mapKey = cleanText(key, 256);
  if (!mapKey) return emptyAddress();

  const requestOptions = options || {};
  const fetchImpl = requestOptions.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") return emptyAddress();

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Number(requestOptions.timeoutMs || GEOCODER_TIMEOUT_MS)
  );
  try {
    const url = new URL(TENCENT_GEOCODER_URL);
    url.searchParams.set("location", `${location.latitude},${location.longitude}`);
    url.searchParams.set("key", mapKey);
    url.searchParams.set("get_poi", "0");
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response || !response.ok) return emptyAddress();
    const payload = await response.json();
    if (!payload || Number(payload.status) !== 0 || !payload.result) return emptyAddress();

    const component = payload.result.address_component || {};
    const detail = cleanText(
      payload.result.address
      || [component.province, component.city, component.district, component.street, component.street_number]
        .filter(Boolean)
        .join(""),
      300
    );
    return {
      province: cleanText(component.province, 80),
      city: cleanText(component.city, 80),
      district: cleanText(component.district, 80),
      detail,
      resolved: !!detail,
    };
  } catch (error) {
    return emptyAddress();
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveLoginLocation(source, config, options) {
  const location = normalizeLoginLocation(source);
  const address = await reverseGeocodeTencent(
    location,
    config && config.tencentMapKey,
    options
  );
  return Object.assign(location, address, {
    source: "wx.getLocation",
  });
}

module.exports = {
  GEOCODER_TIMEOUT_MS,
  TENCENT_GEOCODER_URL,
  normalizeLoginLocation,
  resolveLoginLocation,
  reverseGeocodeTencent,
};
