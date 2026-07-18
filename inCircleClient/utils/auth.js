const ACCESS_TOKEN_KEY = "incircleAccessToken";
const ACCESS_TOKEN_EXPIRES_KEY = "incircleAccessTokenExpiresAt";
let agreementRedirecting = false;
let loginRedirecting = false;

function getGlobalData() {
  if (typeof getApp !== "function") return {};
  try {
    const app = getApp();
    return (app && app.globalData) || {};
  } catch (error) {
    return {};
  }
}

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
    // Storage can be unavailable in smoke-test contexts.
  }
}

function storageRemove(key) {
  try {
    if (typeof wx !== "undefined" && wx.removeStorageSync) wx.removeStorageSync(key);
  } catch (error) {
    // Storage can be unavailable in smoke-test contexts.
  }
}

function getAccessToken() {
  const globalData = getGlobalData();
  const token = globalData.accessToken || storageGet(ACCESS_TOKEN_KEY) || "";
  const expiresAt = globalData.accessTokenExpiresAt || storageGet(ACCESS_TOKEN_EXPIRES_KEY) || "";
  if (expiresAt && Date.parse(expiresAt) <= Date.now() + 30000) {
    clearAccessToken();
    return "";
  }
  return token;
}

function setAccessToken(token, expiresAt) {
  const globalData = getGlobalData();
  globalData.accessToken = token || "";
  globalData.accessTokenExpiresAt = expiresAt || "";
  if (!token) {
    storageRemove(ACCESS_TOKEN_KEY);
    storageRemove(ACCESS_TOKEN_EXPIRES_KEY);
    return;
  }
  storageSet(ACCESS_TOKEN_KEY, token);
  storageSet(ACCESS_TOKEN_EXPIRES_KEY, expiresAt || "");
}

function clearAccessToken() {
  setAccessToken("", "");
}

function updateFromSession(data) {
  if (!data) return;
  if (data.accessToken) {
    setAccessToken(data.accessToken, data.accessTokenExpiresAt);
    return;
  }
  if (data.loggedIn === false) clearAccessToken();
}

function authorizationHeader() {
  const token = getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function getWechatLoginCode() {
  if (typeof wx === "undefined" || typeof wx.login !== "function") return Promise.resolve("");
  return new Promise((resolve, reject) => {
    wx.login({
      success(res) {
        if (res && res.code) {
          resolve(res.code);
          return;
        }
        reject(new Error("微信登录凭证获取失败，请重新打开小程序"));
      },
      fail(error) {
        reject(new Error((error && error.errMsg) || "微信登录凭证获取失败"));
      },
    });
  });
}

function handleAgreementRequired(error) {
  if (!error || error.errCode !== "AGREEMENT_ACCEPTANCE_REQUIRED") return false;
  const globalData = getGlobalData();
  globalData.pendingAgreementRequirement = error.details || null;
  if (typeof wx === "undefined" || typeof wx.reLaunch !== "function") return true;
  try {
    const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];
    const current = pages.length ? pages[pages.length - 1] : null;
    if (current && current.route === "pages/agreement-consent/index") return true;
  } catch (navigationError) {
    // Continue with the guarded reLaunch.
  }
  if (agreementRedirecting) return true;
  agreementRedirecting = true;
  wx.reLaunch({
    url: "/pages/agreement-consent/index",
    complete() {
      setTimeout(() => { agreementRedirecting = false; }, 500);
    },
  });
  return true;
}

function handleAuthenticationRequired(error) {
  const codes = [
    "AUTH_REQUIRED",
    "LOGIN_REQUIRED",
    "TOKEN_INVALID",
    "TOKEN_EXPIRED",
    "TOKEN_REVOKED",
    "TOKEN_SUBJECT_MISMATCH",
    "TOKEN_SESSION_REQUIRED",
    "ACCOUNT_SESSION_REVOKED",
    "ACCOUNT_SESSION_EXPIRED",
    "ACCOUNT_BLOCKED",
    "ACCOUNT_DELETED",
  ];
  if (!error || codes.indexOf(error.errCode) === -1) return false;
  clearAccessToken();
  if (typeof wx === "undefined" || typeof wx.reLaunch !== "function") return true;
  try {
    const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];
    const current = pages.length ? pages[pages.length - 1] : null;
    if (current && current.route === "pages/login/index") return true;
  } catch (navigationError) {
    // Continue with guarded navigation.
  }
  if (loginRedirecting) return true;
  loginRedirecting = true;
  wx.reLaunch({
    url: "/pages/login/index",
    complete() {
      setTimeout(() => { loginRedirecting = false; }, 500);
    },
  });
  return true;
}

module.exports = {
  authorizationHeader,
  clearAccessToken,
  getAccessToken,
  getWechatLoginCode,
  handleAgreementRequired,
  handleAuthenticationRequired,
  setAccessToken,
  updateFromSession,
};
