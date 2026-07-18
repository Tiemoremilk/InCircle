const api = require("./api");
const privateApi = require("./wechat-private-api");

const LOCATION_SCOPE = "scope.userLocation";

function readLocationAuthorization() {
  if (typeof wx === "undefined" || typeof wx.getSetting !== "function") {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    try {
      wx.getSetting({
        success(result) {
          const settings = (result && result.authSetting) || {};
          resolve(settings[LOCATION_SCOPE]);
        },
        fail() { resolve(undefined); },
      });
    } catch (error) {
      resolve(undefined);
    }
  });
}

function readPrivacyAuthorization() {
  if (typeof wx === "undefined" || typeof wx.getPrivacySetting !== "function") {
    return Promise.resolve({ supported: false, needAuthorization: true });
  }
  return new Promise((resolve) => {
    try {
      wx.getPrivacySetting({
        success(result) {
          resolve({
            supported: true,
            needAuthorization: !result || result.needAuthorization !== false,
          });
        },
        fail() { resolve({ supported: true, needAuthorization: true }); },
      });
    } catch (error) {
      resolve({ supported: true, needAuthorization: true });
    }
  });
}

function readLocationEnvironment() {
  let system = {};
  let app = {};
  try {
    if (typeof wx !== "undefined" && typeof wx.getSystemSetting === "function") {
      system = wx.getSystemSetting() || {};
    }
  } catch (error) {
    system = {};
  }
  try {
    if (typeof wx !== "undefined" && typeof wx.getAppAuthorizeSetting === "function") {
      app = wx.getAppAuthorizeSetting() || {};
    }
  } catch (error) {
    app = {};
  }
  return {
    systemLocationEnabled: system.locationEnabled,
    appLocationAuthorized: app.locationAuthorized || "",
    reducedAccuracy: app.locationReducedAccuracy === true,
  };
}

function canCaptureSilently() {
  return Promise.all([readPrivacyAuthorization(), readLocationAuthorization()])
    .then(([privacy, scopeAuthorization]) => {
      if (!privacy.supported || privacy.needAuthorization) {
        return { ready: false, reason: "privacy-authorization-required" };
      }
      if (scopeAuthorization !== true) {
        return { ready: false, reason: "permission-not-granted" };
      }
      const environment = readLocationEnvironment();
      if (environment.systemLocationEnabled === false) {
        return { ready: false, reason: "system-location-disabled" };
      }
      if (
        environment.appLocationAuthorized
        && environment.appLocationAuthorized !== "authorized"
      ) {
        return { ready: false, reason: "app-permission-not-granted" };
      }
      return { ready: true };
    });
}

function getWechatLocation() {
  if (typeof wx === "undefined" || typeof wx.getLocation !== "function") {
    return Promise.reject({ errMsg: "getLocation unavailable" });
  }
  return new Promise((resolve, reject) => {
    try {
      wx.getLocation({
        type: "gcj02",
        altitude: false,
        isHighAccuracy: true,
        highAccuracyExpireTime: 5000,
        success(result) { resolve(result || {}); },
        fail(error) { reject(error || {}); },
      });
    } catch (error) {
      reject(error);
    }
  });
}

function classifyLocationFailure(error) {
  const privacyReason = privateApi.classifyPrivacyFailure(error);
  const info = privateApi.errorInfo(error);
  if (privacyReason) return Promise.resolve({ reason: privacyReason, diagnostic: info });
  if (/timeout/i.test(info.errMsg)) {
    return Promise.resolve({ reason: "timeout", diagnostic: info });
  }
  return readLocationAuthorization().then((scopeAuthorization) => {
    const environment = readLocationEnvironment();
    if (environment.systemLocationEnabled === false) {
      return { reason: "system-location-disabled", diagnostic: info };
    }
    if (environment.appLocationAuthorized === "denied") {
      return { reason: "app-permission-denied", diagnostic: info };
    }
    if (scopeAuthorization === false) {
      return { reason: "permission-denied", diagnostic: info };
    }
    return { reason: "unavailable", diagnostic: info };
  });
}

function locationPayload(location) {
  const source = location || {};
  return {
    latitude: source.latitude,
    longitude: source.longitude,
    accuracy: source.accuracy,
  };
}

function saveLocation(location, options) {
  const payload = locationPayload(location);
  if (options && options.enablePreference) {
    return api.enablePreciseLoginLocation(payload);
  }
  return api.updateCurrentLoginLocation(payload);
}

function captureReadyLocation(enablePreference) {
  return getWechatLocation().then(
    (location) => saveLocation(location, { enablePreference }).catch((error) => ({
      updated: false,
      skipped: false,
      reason: "save-failed",
      message: error && error.message ? error.message : "登录位置保存失败",
      diagnostic: privateApi.errorInfo(error),
    })),
    (error) => classifyLocationFailure(error).then((failure) => {
      if (failure.reason === "privacy-config-error" || failure.reason === "unavailable") {
        privateApi.logPrivateApiFailure("wx.getLocation", error);
      }
      return Object.assign({ updated: false, skipped: true }, failure);
    })
  );
}

function captureAndSave(session, options) {
  const settings = options || {};
  const interactive = settings.interactive === true;
  const enablePreference = settings.enablePreference === true;
  const user = session && session.user;
  if (!enablePreference && (!user || user.preciseLoginLocationEnabled !== true)) {
    return Promise.resolve({ updated: false, skipped: true, reason: "disabled" });
  }

  // Keep the privacy and location prompts in the original user gesture call stack.
  if (interactive) return captureReadyLocation(enablePreference);
  return canCaptureSilently().then((state) => {
    if (!state.ready) {
      return { updated: false, skipped: true, reason: state.reason };
    }
    return captureReadyLocation(enablePreference);
  });
}

module.exports = {
  LOCATION_SCOPE,
  canCaptureSilently,
  captureAndSave,
  classifyLocationFailure,
  getWechatLocation,
  readLocationAuthorization,
  readLocationEnvironment,
  readPrivacyAuthorization,
};
