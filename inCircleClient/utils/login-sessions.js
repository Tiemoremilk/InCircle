const time = require("./time");

function decorateSession(item) {
  const session = item || {};
  const location = session.loginLocation || {};
  const hasLocation = !!location.available;
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  const accuracy = Number(location.accuracyMeters);
  const areaParts = [location.province, location.city, location.district]
    .filter((part, index, values) => part && values.indexOf(part) === index);
  const locationText = hasLocation
    ? location.detail || areaParts.join(" · ") || "坐标已记录，详细地址暂不可用"
    : "本次登录未记录授权位置";
  const coordinateText = hasLocation && Number.isFinite(latitude) && Number.isFinite(longitude)
    ? `GCJ-02 ${latitude.toFixed(6)}, ${longitude.toFixed(6)}${Number.isFinite(accuracy) ? ` · 精度约 ${Math.round(accuracy)} 米` : ""}`
    : "";
  const statusClass = session.current ? "current" : session.canRevoke ? "active" : "inactive";
  return Object.assign({}, session, {
    lastLoginText: time.displayDateTime(session.lastLoginAt) || "时间未知",
    networkAddressText: session.loginAddress && session.loginAddress !== "未知地址"
      ? session.loginAddress
      : "暂不可用",
    hasLoginLocation: hasLocation,
    loginLocationText: locationText,
    loginCoordinateText: coordinateText,
    loginLocationCapturedText: hasLocation
      ? time.displayDateTime(location.capturedAt) || "采集时间未知"
      : "",
    statusClass,
    deviceIcon: session.current
      ? "/images/ui-icons/phone.svg"
      : session.canRevoke
        ? "/images/ui-icons/log-in.svg"
        : "/images/ui-icons/history.svg",
  });
}

function matchesSessionSearch(session, keyword) {
  const normalized = String(keyword || "").trim().toLowerCase();
  if (!normalized) return true;
  const location = session && session.loginLocation ? session.loginLocation : {};
  return [
    session && session.deviceName,
    session && session.environment,
    session && session.statusText,
    session && session.lastLoginText,
    session && session.networkAddressText,
    session && session.loginLocationText,
    session && session.loginCoordinateText,
    location.province,
    location.city,
    location.district,
  ].some((value) => String(value || "").toLowerCase().includes(normalized));
}

function filterSessions(sessions, keyword) {
  return (sessions || []).filter((session) => matchesSessionSearch(session, keyword));
}

function showLocationToast(title) {
  if (typeof wx !== "undefined" && typeof wx.showToast === "function") {
    wx.showToast({ title, icon: "none" });
  }
}

function locationCoordinate(value) {
  if (typeof value !== "number" && typeof value !== "string") return NaN;
  if (typeof value === "string" && !value.trim()) return NaN;
  const coordinate = Number(value);
  return Number.isFinite(coordinate) ? coordinate : NaN;
}

function openSessionLocation(session) {
  const location = session && session.loginLocation ? session.loginLocation : {};
  const latitude = locationCoordinate(location.latitude);
  const longitude = locationCoordinate(location.longitude);
  if (!location.available || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    showLocationToast("本次登录没有可查看的位置");
    return;
  }

  const areaParts = [location.province, location.city, location.district]
    .filter((part, index, values) => part && values.indexOf(part) === index);
  if (typeof wx === "undefined" || typeof wx.openLocation !== "function") {
    showLocationToast("地图暂时无法打开");
    return;
  }

  try {
    wx.openLocation({
      latitude,
      longitude,
      scale: 16,
      name: "登录位置",
      address: location.detail || areaParts.join(" "),
      fail() {
        showLocationToast("地图暂时无法打开");
      },
    });
  } catch (error) {
    showLocationToast("地图暂时无法打开");
  }
}

module.exports = {
  decorateSession,
  filterSessions,
  matchesSessionSearch,
  openSessionLocation,
};
