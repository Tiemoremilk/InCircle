const DEVICE_KEY_STORAGE = "incircleDeviceKeyV1";

function storageGet(key) {
  try {
    return typeof wx !== "undefined" && wx.getStorageSync ? wx.getStorageSync(key) : "";
  } catch (error) {
    return "";
  }
}

function storageSet(key, value) {
  try {
    if (typeof wx !== "undefined" && wx.setStorageSync) wx.setStorageSync(key, value);
  } catch (error) {
    // A temporary key is still enough for this login when storage is unavailable.
  }
}

function randomPart() {
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
}

function getDeviceKey() {
  const stored = String(storageGet(DEVICE_KEY_STORAGE) || "");
  if (stored.length >= 16) return stored;
  const created = `${Date.now().toString(36)}-${randomPart()}-${randomPart()}-${randomPart()}`;
  storageSet(DEVICE_KEY_STORAGE, created);
  return created;
}

function safeCall(callback) {
  try {
    return callback() || {};
  } catch (error) {
    return {};
  }
}

function getDeviceContext() {
  if (typeof wx === "undefined") return { deviceKey: getDeviceKey() };
  const fallback = safeCall(() => (wx.getSystemInfoSync ? wx.getSystemInfoSync() : {}));
  const device = safeCall(() => (wx.getDeviceInfo ? wx.getDeviceInfo() : fallback));
  const appBase = safeCall(() => (wx.getAppBaseInfo ? wx.getAppBaseInfo() : fallback));
  const account = safeCall(() => (wx.getAccountInfoSync ? wx.getAccountInfoSync() : {}));
  const miniProgram = account.miniProgram || {};
  const brand = String(device.brand || fallback.brand || "").trim();
  const model = String(device.model || fallback.model || "").trim();
  return {
    deviceKey: getDeviceKey(),
    deviceName: [brand, model].filter(Boolean).join(" ") || "微信设备",
    brand,
    model,
    platform: String(device.platform || fallback.platform || "").trim(),
    system: String(device.system || fallback.system || "").trim(),
    wechatVersion: String(appBase.version || fallback.version || "").trim(),
    sdkVersion: String(appBase.SDKVersion || fallback.SDKVersion || "").trim(),
    environmentVersion: String(miniProgram.envVersion || "").trim(),
  };
}

module.exports = {
  getDeviceContext,
  getDeviceKey,
};
