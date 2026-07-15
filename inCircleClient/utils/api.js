const HTTP_READ_CACHE_STORAGE_KEY = "incircleHttpReadCache";
const HTTP_READ_CACHE_LIMIT = 40;
const auth = require("./auth");
const theme = require("./theme");

const WECHAT_CODE_TYPES = {
  incircleAccountLogin: true,
  incircleRegisterAccount: true,
  incircleBindAccount: true,
  incircleResetPassword: true,
};

const REQUEST_TIMEOUT_BY_TYPE = {
  incircleAiTestProvider: 30000,
  incircleAiSyncModels: 35000,
};
const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 15000;
const AI_STREAM_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const AI_STREAM_RECOVERY_DELAYS_MS = [300, 700, 1200, 2000, 3500, 5000, 8000, 10000];
const AI_STREAM_RECOVERY_TIMEOUT_MS = 10 * 60 * 1000;
const AI_STREAM_RECOVERY_FRAME_CHARS = 32;

const READ_TTL = {
  // This is the shared policy for cache, in-flight merging, and safe transient retries.
  incircleSession: 300000,
  incircleListMyCircles: 20000,
  incircleJoinPreview: 0,
  incircleCircleSettings: 20000,
  incircleCircleMemberDetail: 20000,
  incircleAdminOverview: 10000,
  incircleAdminListCircles: 20000,
  incircleAdminListUsers: 10000,
  incircleAdminUserDetail: 10000,
  incircleAdminOperationLogs: 10000,
  incircleHome: 10000,
  incircleActivities: 15000,
  incircleActivityDetail: 20000,
  incircleTools: 10000,
  incircleBillDetail: 20000,
  incircleVoteDetail: 20000,
  incircleCheckinDetail: 20000,
  incircleDocs: 30000,
  incircleDocDetail: 30000,
  incircleMembers: 20000,
  incircleScoreLogs: 10000,
  incircleMemberDetail: 20000,
  incircleGetInviteQrCode: 0,
  incircleAiStatus: 60000,
  incircleAiSettings: 10000,
  incircleAiListProviders: 10000,
  incircleAiListModels: 10000,
  incircleAiListConversations: 5000,
  incircleAiListMessages: 3000,
  incircleAiUsage: 10000,
  incircleAiReports: 10000,
};

const PERSISTED_READ_TYPES = {
  incircleSession: true,
};

const WRITE_INVALIDATION = {
  incircleAiUpdateSettings: ["incircleAiStatus", "incircleAiSettings"],
  incircleAiSaveProvider: ["incircleAiStatus", "incircleAiSettings", "incircleAiListProviders", "incircleAiListModels"],
  incircleAiArchiveProvider: ["incircleAiStatus", "incircleAiSettings", "incircleAiListProviders", "incircleAiListModels"],
  incircleAiTestProvider: ["incircleAiListProviders"],
  incircleAiSyncModels: ["incircleAiStatus", "incircleAiSettings", "incircleAiListModels"],
  incircleAiSaveModel: ["incircleAiStatus", "incircleAiSettings", "incircleAiListModels"],
  incircleAiUpdateModel: ["incircleAiStatus", "incircleAiSettings", "incircleAiListModels"],
  incircleAiCreateConversation: ["incircleAiListConversations"],
  incircleAiDeleteConversation: ["incircleAiListConversations", "incircleAiListMessages"],
  incircleAiCancelGeneration: ["incircleAiListConversations", "incircleAiListMessages", "incircleAiUsage"],
  incircleAiGrantConsent: ["incircleAiStatus"],
  incircleAiReportMessage: ["incircleAiReports"],
  incircleAiUpdateReport: ["incircleAiReports"],
  incircleUpdateTheme: ["incircleSession", "incircleListMyCircles"],
  incircleRotateInviteCode: ["incircleCircleSettings", "incircleGetInviteQrCode", "incircleJoinPreview"],
};

const httpReadCache = {};
const httpInflight = {};
let httpCacheVersion = 0;

function clone(data) {
  if (data === null || typeof data === "undefined") return data;
  try {
    return JSON.parse(JSON.stringify(data));
  } catch (error) {
    return data;
  }
}

function getGlobalData() {
  if (typeof getApp !== "function") return {};
  try {
    const app = getApp();
    return (app && app.globalData) || {};
  } catch (error) {
    return {};
  }
}

function setGlobalSession(data) {
  if (typeof getApp !== "function" || !data) return;
  try {
    const app = getApp();
    if (!app || !app.globalData) return;
    const currentCircleId = data.currentCircleId || (data.currentCircle && data.currentCircle.id) || "";
    app.globalData.currentCircleId = currentCircleId;
    if (data.user && data.user.id) app.globalData.userId = data.user.id;
    if (typeof data.isSuperAdmin !== "undefined") app.globalData.isSuperAdmin = !!data.isSuperAdmin;
    if (data.user && data.user.themeKey) theme.setTheme(data.user.themeKey, data.user.customTheme);
    auth.updateFromSession(data);
  } catch (error) {
    // Ignore smoke-test contexts.
  }
}

function setGlobalRuntime(data) {
  if (typeof getApp !== "function" || !data) return;
  try {
    const app = getApp();
    if (!app || !app.globalData) return;
    const currentCircleId = data.currentCircleId || (data.circle && data.circle.id) || "";
    if (currentCircleId) app.globalData.currentCircleId = currentCircleId;
    if (data.user && data.user.id) app.globalData.userId = data.user.id;
    if (typeof data.isSuperAdmin !== "undefined") app.globalData.isSuperAdmin = !!data.isSuperAdmin;
  } catch (error) {
    // Ignore smoke-test contexts.
  }
}

function activeCircleIdFromRuntime(payload) {
  const globalData = getGlobalData();
  return (payload && payload.circleId) || globalData.currentCircleId || "";
}

function shouldUseHttpBackend() {
  const globalData = getGlobalData();
  return !!(
    (globalData.backendMode === "http" || globalData.useHttpBackend === true) &&
    globalData.httpBackendBaseUrl &&
    typeof wx !== "undefined" &&
    typeof wx.request === "function"
  );
}

function httpBackendUrl(path) {
  const globalData = getGlobalData();
  const baseUrl = String(globalData.httpBackendBaseUrl || "").replace(/\/+$/, "");
  return `${baseUrl}${path}`;
}

function normalizeHttpResponseBody(body) {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch (error) {
    return body;
  }
}

function makeHttpError(result, fallbackMessage) {
  const source = result && typeof result === "object" ? result : null;
  const error = new Error((source && source.errMsg) || fallbackMessage);
  if (source && source.errCode) error.errCode = source.errCode;
  if (source && typeof source.details !== "undefined") error.details = source.details;
  return error;
}

function codedError(message, errCode, details) {
  const error = new Error(message);
  error.errCode = errCode;
  if (typeof details !== "undefined") error.details = details;
  return error;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function withTimeout(promise, ms, message, errCode) {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(codedError(message, errCode || "HTTP_RESPONSE_TIMEOUT")), ms);
  });
  return Promise.race([promise, timeout]).then(
    (data) => {
      if (timer) clearTimeout(timer);
      return data;
    },
    (error) => {
      if (timer) clearTimeout(timer);
      throw error;
    }
  );
}

function sendHttpRequest(type, data, options) {
  if (!shouldUseHttpBackend()) {
    return Promise.reject(new Error("HTTP 后端未启用：请检查 backendMode、baseUrl 和 request 合法域名"));
  }
  const globalData = getGlobalData();
  const timeout = REQUEST_TIMEOUT_BY_TYPE[type] || globalData.httpBackendTimeout || DEFAULT_HTTP_REQUEST_TIMEOUT_MS;
  const forceWechatCode = !!WECHAT_CODE_TYPES[type] || !!(options && options.forceWechatCode);
  const accessToken = forceWechatCode ? "" : auth.getAccessToken();
  const headers = Object.assign(
    {
      "content-type": "application/json",
      "x-incircle-env-version": globalData.envVersion || "",
    },
    globalData.httpBackendHeaders || {},
    accessToken ? { Authorization: `Bearer ${accessToken}` } : {}
  );
  const loginCodePromise = forceWechatCode || !accessToken ? auth.getWechatLoginCode() : Promise.resolve("");
  let requestTask = null;
  const request = loginCodePromise.then(
    (wechatLoginCode) =>
      new Promise((resolve, reject) => {
        requestTask = wx.request({
          url: httpBackendUrl("/api/incircle"),
          method: "POST",
          timeout,
          header: headers,
          data: Object.assign({}, data || {}, wechatLoginCode ? { wechatLoginCode } : {}),
          success(response) {
            const statusCode = response && response.statusCode;
            const result = normalizeHttpResponseBody(response && response.data);
            if (statusCode < 200 || statusCode >= 300) {
              const error = makeHttpError(result, `HTTP 后端 ${type} 调用失败 (${statusCode})`);
              error.statusCode = Number(statusCode || 0);
              reject(error);
              return;
            }
            if (!result || result.success === false) {
              reject(makeHttpError(result, `HTTP 后端 ${type} 调用失败`));
              return;
            }
            const responseData = typeof result.data === "undefined" ? null : result.data;
            auth.updateFromSession(responseData);
            resolve(responseData);
          },
          fail(error) {
            const message = (error && error.errMsg) || `HTTP 后端 ${type} 请求失败`;
            reject(codedError(
              message,
              /timeout/i.test(message) ? "HTTP_RESPONSE_TIMEOUT" : "HTTP_NETWORK_ERROR"
            ));
          },
        });
      })
  );

  return withTimeout(
    request,
    timeout + 1000,
    `HTTP 后端 ${type} 响应超时，请稍后重试`,
    "HTTP_RESPONSE_TIMEOUT"
  ).catch((error) => {
    if (
      error && error.errCode === "HTTP_RESPONSE_TIMEOUT" &&
      requestTask && typeof requestTask.abort === "function"
    ) requestTask.abort();
    throw error;
  });
}

function isTransientReadError(error) {
  if (!error) return false;
  if (["HTTP_RESPONSE_TIMEOUT", "HTTP_NETWORK_ERROR"].includes(error.errCode)) return true;
  return [408, 425, 429, 502, 503, 504].includes(Number(error.statusCode || 0));
}

function callHttpBackend(type, data, options) {
  return sendHttpRequest(type, data, options).catch((error) => {
    const authRetryable = error && ["TOKEN_INVALID", "TOKEN_EXPIRED", "TOKEN_REVOKED", "TOKEN_SUBJECT_MISMATCH"].indexOf(error.errCode) !== -1;
    if (authRetryable && !(options && options.authRetried)) {
      auth.clearAccessToken();
      if (type === "incircleSession") {
        return sendHttpRequest(type, data, { forceWechatCode: true, authRetried: true });
      }
      return sendHttpRequest("incircleSession", { type: "incircleSession" }, { forceWechatCode: true, authRetried: true }).then(
        () => callHttpBackend(type, data, Object.assign({}, options, { authRetried: true }))
      );
    }
    if (isRead(type) && isTransientReadError(error) && !(options && options.transientRetried)) {
      return delay(280).then(() => callHttpBackend(
        type,
        data,
        Object.assign({}, options, { transientRetried: true })
      ));
    }
    throw error;
  });
}

function isRead(type) {
  return Object.prototype.hasOwnProperty.call(READ_TTL, type);
}

function isPersistedRead(type) {
  return !!PERSISTED_READ_TYPES[type];
}

function stableStringify(value) {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function cacheKey(type, data) {
  const globalData = getGlobalData();
  const backendKey = `http-auth-v2:${globalData.httpBackendBaseUrl || ""}:${globalData.userId || "anonymous"}`;
  return `${backendKey}:${type}:${stableStringify(data || {})}`;
}

function canUseStorageCache() {
  return !!(typeof wx !== "undefined" && wx.getStorageSync && wx.setStorageSync && wx.removeStorageSync);
}

function getStoredReadCache() {
  if (!canUseStorageCache()) return {};
  try {
    return wx.getStorageSync(HTTP_READ_CACHE_STORAGE_KEY) || {};
  } catch (error) {
    return {};
  }
}

function setStoredReadCache(cache) {
  if (!canUseStorageCache()) return;
  try {
    wx.setStorageSync(HTTP_READ_CACHE_STORAGE_KEY, cache || {});
  } catch (error) {
    // Storage may be unavailable in smoke-test contexts.
  }
}

function removeStoredReadCache() {
  if (!canUseStorageCache()) return;
  try {
    wx.removeStorageSync(HTTP_READ_CACHE_STORAGE_KEY);
  } catch (error) {
    // Storage may be unavailable in smoke-test contexts.
  }
}

function pruneStoredReadCache(cache) {
  const next = cache || {};
  Object.keys(next)
    .sort((a, b) => (next[b].time || 0) - (next[a].time || 0))
    .slice(HTTP_READ_CACHE_LIMIT)
    .forEach((key) => {
      delete next[key];
    });
  return next;
}

function readCache(type, key) {
  const ttl = READ_TTL[type] || 0;
  let cached = httpReadCache[key];
  if (!cached && isPersistedRead(type)) {
    const stored = getStoredReadCache();
    cached = stored[key];
    if (cached) httpReadCache[key] = cached;
  }
  if (!ttl || !cached) return null;
  if (Date.now() - cached.time > ttl) {
    delete httpReadCache[key];
    const stored = getStoredReadCache();
    if (stored[key]) {
      delete stored[key];
      setStoredReadCache(stored);
    }
    return null;
  }
  return Promise.resolve(clone(cached.data));
}

function writeCache(type, key, data) {
  if (!isRead(type)) return data;
  const entry = {
    type,
    time: Date.now(),
    data: clone(data),
  };
  httpReadCache[key] = entry;
  if (!isPersistedRead(type)) return data;
  const stored = getStoredReadCache();
  stored[key] = entry;
  setStoredReadCache(pruneStoredReadCache(stored));
  return data;
}

function clearCache(types) {
  const typeMap = Array.isArray(types)
    ? types.reduce((map, type) => {
        if (type) map[type] = true;
        return map;
      }, {})
    : null;
  httpCacheVersion += 1;
  Object.keys(httpReadCache).forEach((key) => {
    if (!typeMap || typeMap[httpReadCache[key].type]) delete httpReadCache[key];
  });
  Object.keys(httpInflight).forEach((key) => {
    if (!typeMap || typeMap[httpInflight[key].type]) delete httpInflight[key];
  });
  if (!typeMap) {
    removeStoredReadCache();
    return;
  }
  const stored = getStoredReadCache();
  Object.keys(stored).forEach((key) => {
    if (!typeMap || typeMap[stored[key].type]) delete stored[key];
  });
  setStoredReadCache(stored);
}

function requestAction(type, payload) {
  const data = Object.assign(
    {
      type,
      circleId: activeCircleIdFromRuntime(payload),
    },
    payload || {}
  );
  const key = cacheKey(type, data);

  if (isRead(type)) {
    const cached = readCache(type, key);
    if (cached) return cached;
    if (httpInflight[key]) return httpInflight[key].promise.then(clone);
  }

  const requestCacheVersion = httpCacheVersion;
  const request = callHttpBackend(type, data)
    .then((response) => {
      if (isRead(type) && requestCacheVersion === httpCacheVersion) {
        return writeCache(type, key, response);
      }
      if (!isRead(type)) clearCache(WRITE_INVALIDATION[type]);
      return response;
    })
    .then(
      (response) => {
        if (httpInflight[key] && httpInflight[key].promise === request) delete httpInflight[key];
        return response;
      },
      (error) => {
        if (httpInflight[key] && httpInflight[key].promise === request) delete httpInflight[key];
        throw error;
      }
    );

  if (isRead(type)) httpInflight[key] = { type, promise: request };
  return request.then(clone);
}

function afterSession(data) {
  setGlobalSession(data);
  return data;
}

function currentThemeKey() {
  return theme.getCurrentTheme().key;
}

function getSession(options) {
  if (options && options.force) clearCache(["incircleSession"]);
  return requestAction("incircleSession", { clientThemeKey: currentThemeKey() }).then(afterSession);
}

function login(profile) {
  return requestAction("incircleLogin", { profile, clientThemeKey: currentThemeKey() }).then(afterSession);
}

function accountLogin(account, password, options) {
  return requestAction("incircleAccountLogin", {
    account,
    password,
    clientThemeKey: currentThemeKey(),
    themePreferenceExplicit: !!(options && options.themePreferenceExplicit),
    confirmWechatRebind: !!(options && options.confirmWechatRebind),
  }).then(afterSession);
}

function registerAccount(payload) {
  return requestAction(
    "incircleRegisterAccount",
    Object.assign({}, payload || {}, { clientThemeKey: currentThemeKey() })
  ).then(afterSession);
}

function bindAccount(payload) {
  return requestAction(
    "incircleBindAccount",
    Object.assign({}, payload || {}, { clientThemeKey: currentThemeKey() })
  ).then(afterSession);
}

function resetPassword(payload) {
  return requestAction(
    "incircleResetPassword",
    Object.assign({}, payload || {}, { clientThemeKey: currentThemeKey() })
  ).then(afterSession);
}

function changePassword(payload) {
  return requestAction("incircleChangePassword", payload || {});
}

function updateTheme(themeKey, customTheme) {
  return requestAction("incircleUpdateTheme", Object.assign(
    { themeKey },
    customTheme ? { customTheme } : {}
  ));
}

function logout() {
  return requestAction("incircleLogout", {}).then(afterSession);
}

function deleteAccount() {
  return requestAction("incircleDeleteAccount", {}).then(afterSession);
}

function listMyCircles(params) {
  return requestAction("incircleListMyCircles", params || {}).then(afterSession);
}

function switchCircle(circleId) {
  return requestAction("incircleSwitchCircle", { circleId }).then(afterSession);
}

function inviteCredentialPayload(joinCode, inviteToken) {
  if (joinCode && typeof joinCode === "object") {
    return {
      joinCode: String(joinCode.joinCode || ""),
      inviteToken: String(joinCode.inviteToken || ""),
    };
  }
  return {
    joinCode: String(joinCode || ""),
    inviteToken: String(inviteToken || ""),
  };
}

function joinCircle(joinCode, inviteToken) {
  return requestAction("incircleJoinCircle", inviteCredentialPayload(joinCode, inviteToken)).then(afterSession);
}

function createCircle(circle) {
  return requestAction("incircleCreateCircle", { circle }).then(afterSession);
}

function exitCircle(circleId) {
  return requestAction("incircleExitCircle", { circleId }).then(afterSession);
}

function dissolveCircle(circleId) {
  return requestAction("incircleDissolveCircle", { circleId }).then(afterSession);
}

function removeCircleMember(circleId, membershipId, reason) {
  return requestAction("incircleRemoveCircleMember", { circleId, membershipId, reason });
}

function getJoinPreview(joinCode, inviteToken) {
  return requestAction("incircleJoinPreview", inviteCredentialPayload(joinCode, inviteToken));
}

function getCircleSettings(circleId) {
  return requestAction("incircleCircleSettings", { circleId });
}

function getCircleMember(circleId, membershipId) {
  return requestAction("incircleCircleMemberDetail", { circleId, membershipId });
}

function updateCircleInfo(circleId, patch) {
  return requestAction("incircleUpdateCircleInfo", { circleId, patch });
}

function rotateInviteCode(circleId) {
  return requestAction("incircleRotateInviteCode", { circleId });
}

function getInviteQrCode(circleId) {
  const globalData = getGlobalData();
  return requestAction("incircleGetInviteQrCode", {
    circleId,
    envVersion: globalData.envVersion || "release",
    qrVersion: "wechat-miniprogram-code-v2",
  });
}

function adminOverview() {
  return requestAction("incircleAdminOverview", {});
}

function adminListCircles(params) {
  return requestAction("incircleAdminListCircles", params || {});
}

function adminUpdateCircleStatus(circleId, status) {
  return requestAction("incircleAdminUpdateCircleStatus", { circleId, status });
}

function adminDeleteCircle(circleId) {
  return requestAction("incircleAdminDeleteCircle", { circleId });
}

function adminListUsers(params) {
  return requestAction("incircleAdminListUsers", params || {});
}

function adminGetUser(userId) {
  return requestAction("incircleAdminUserDetail", { userId });
}

function adminUpdateUserStatus(userId, status, reason) {
  return requestAction("incircleAdminUpdateUserStatus", { userId, status, reason: reason || "" });
}

function adminUnbindUserWechat(userId) {
  return requestAction("incircleAdminUnbindUserWechat", { userId });
}

function adminDeleteUser(userId, confirmation) {
  return requestAction("incircleAdminDeleteUser", { userId, confirmation, confirmOwnedCircles: true });
}

function adminListOperationLogs(params) {
  return requestAction("incircleAdminOperationLogs", params || {});
}

function adminDeleteOperationLogs(params) {
  return requestAction("incircleAdminDeleteOperationLogs", params || {});
}

function getHome() {
  return requestAction("incircleHome", {}).then((data) => {
    setGlobalRuntime(data);
    return data;
  });
}

function listActivities() {
  return requestAction("incircleActivities", {});
}

function getActivity(id) {
  return requestAction("incircleActivityDetail", { id });
}

function listTools() {
  return requestAction("incircleTools", {});
}

function getBill(id) {
  return requestAction("incircleBillDetail", { id });
}

function getVote(id) {
  return requestAction("incircleVoteDetail", { id });
}

function getCheckin(id) {
  return requestAction("incircleCheckinDetail", { id });
}

function listDocs() {
  return requestAction("incircleDocs", {});
}

function getDoc(id) {
  return requestAction("incircleDocDetail", { id });
}

function listMembers() {
  return requestAction("incircleMembers", {});
}

function listScoreLogs(params) {
  return requestAction("incircleScoreLogs", params || {});
}

function getMember(id) {
  return requestAction("incircleMemberDetail", { id });
}

function createActivity(activity) {
  return requestAction("incircleCreateActivity", { activity });
}

function updateActivity(id, activity) {
  return requestAction("incircleUpdateActivity", { id, activity });
}

function deleteActivity(id) {
  return requestAction("incircleDeleteActivity", { id });
}

function updateActivityStatus(id, status) {
  return requestAction("incircleUpdateActivityStatus", { id, status });
}

function finishActivity(id) {
  return requestAction("incircleFinishActivity", { id });
}

function addActivityPhoto(id, photoList) {
  return requestAction("incircleAddActivityPhoto", { id, photoList });
}

function createBillFromActivity(id) {
  return requestAction("incircleCreateBillFromActivity", { id });
}

function createBill(bill) {
  return requestAction("incircleCreateBill", { bill });
}

function updateBill(id, bill) {
  return requestAction("incircleUpdateBill", { id, bill });
}

function deleteBill(id) {
  return requestAction("incircleDeleteBill", { id });
}

function settleBill(id) {
  return requestAction("incircleSettleBill", { id });
}

function remindBill(id, noticeOptions) {
  return requestAction("incircleRemindBill", { id, noticeOptions });
}

function createVote(vote) {
  return requestAction("incircleCreateVote", { vote });
}

function updateVote(id, vote) {
  return requestAction("incircleUpdateVote", { id, vote });
}

function deleteVote(id) {
  return requestAction("incircleDeleteVote", { id });
}

function voteOption(id, name) {
  return requestAction("incircleVoteOption", { id, name });
}

function vetoVoteOption(id, name) {
  return requestAction("incircleVetoVoteOption", { id, name });
}

function finishVote(id) {
  return requestAction("incircleFinishVote", { id });
}

function createCheckin(checkin) {
  return requestAction("incircleCreateCheckin", { checkin });
}

function updateCheckin(id, checkin) {
  return requestAction("incircleUpdateCheckin", { id, checkin });
}

function deleteCheckin(id) {
  return requestAction("incircleDeleteCheckin", { id });
}

function useCheckinCard(id, cardType) {
  return requestAction("incircleUseCheckinCard", { id, cardType });
}

function checkIn(id, record) {
  return requestAction("incircleCheckIn", { id, record });
}

function updateCheckinRecordMedia(id, recordId, image) {
  return requestAction("incircleUpdateCheckinRecordMedia", {
    id,
    recordId,
    image,
    media: image ? [image] : [],
  });
}

function runCheckinPunishment(id) {
  return requestAction("incircleRunCheckinPunishment", { id });
}

function runDecision(id) {
  return requestAction("incircleRunDecision", { id });
}

function createDoc(doc) {
  return requestAction("incircleCreateDoc", { doc });
}

function updateDoc(id, doc) {
  return requestAction("incircleUpdateDoc", { id, doc });
}

function deleteDoc(id) {
  return requestAction("incircleDeleteDoc", { id });
}

function addMemberTag(id, tag, options) {
  return requestAction("incircleAddMemberTag", Object.assign({ id, tag }, options || {}));
}

function proposeMemberTag(id, tag) {
  return requestAction("incircleProposeMemberTag", { id, tag });
}

function voteMemberTagProposal(id, proposalId) {
  return requestAction("incircleVoteMemberTagProposal", { id, proposalId });
}

function removeMemberTag(id, tag) {
  return requestAction("incircleRemoveMemberTag", { id, tag });
}

function appealMemberTag(id, tag, reason) {
  return requestAction("incircleAppealMemberTag", { id, tag, reason });
}

function updateMyCard(patch) {
  return requestAction("incircleUpdateMyCard", { patch });
}

function getAiStatus(circleId, options) {
  if (options && options.force) clearCache(["incircleAiStatus"]);
  return requestAction("incircleAiStatus", { circleId });
}

function getAiSettings(circleId) {
  return requestAction("incircleAiSettings", { circleId });
}

function updateAiSettings(circleId, patch) {
  return requestAction("incircleAiUpdateSettings", { circleId, patch });
}

function listAiProviders(circleId) {
  return requestAction("incircleAiListProviders", { circleId });
}

function saveAiProvider(circleId, providerId, provider, options) {
  return requestAction("incircleAiSaveProvider", {
    circleId,
    providerId: providerId || "",
    provider,
    validateBeforeSave: !!(options && options.validateBeforeSave),
  });
}

function archiveAiProvider(circleId, providerId) {
  return requestAction("incircleAiArchiveProvider", { circleId, providerId });
}

function testAiProvider(circleId, providerId) {
  return requestAction("incircleAiTestProvider", { circleId, providerId });
}

function listAiModels(circleId) {
  return requestAction("incircleAiListModels", { circleId });
}

function syncAiModels(circleId, providerId) {
  return requestAction("incircleAiSyncModels", { circleId, providerId });
}

function saveAiModel(circleId, model) {
  return requestAction("incircleAiSaveModel", { circleId, model });
}

function updateAiModel(circleId, modelId, patch) {
  return requestAction("incircleAiUpdateModel", { circleId, modelId, patch });
}

function testAiModel(circleId, modelId) {
  return requestAction("incircleAiTestModel", { circleId, modelId });
}

function listAiConversations(circleId, params) {
  return requestAction("incircleAiListConversations", Object.assign({ circleId }, params || {}));
}

function createAiConversation(circleId, modelId) {
  return requestAction("incircleAiCreateConversation", { circleId, modelId: modelId || "" });
}

function deleteAiConversation(circleId, conversationId) {
  return requestAction("incircleAiDeleteConversation", { circleId, conversationId });
}

function listAiMessages(circleId, conversationId, params) {
  const options = Object.assign({}, params || {});
  if (options.force) clearCache(["incircleAiListMessages"]);
  delete options.force;
  return requestAction(
    "incircleAiListMessages",
    Object.assign({ circleId, conversationId }, options)
  );
}

function cancelAiGeneration(circleId, messageId) {
  return requestAction("incircleAiCancelGeneration", { circleId, messageId });
}

function grantAiConsent(circleId, providerId) {
  return requestAction("incircleAiGrantConsent", { circleId, providerId });
}

function reportAiMessage(circleId, messageId, reason, detail) {
  return requestAction("incircleAiReportMessage", { circleId, messageId, reason, detail });
}

function getAiUsage(circleId) {
  return requestAction("incircleAiUsage", { circleId });
}

function listAiReports(circleId) {
  return requestAction("incircleAiReports", { circleId });
}

function updateAiReport(circleId, reportId, patch) {
  return requestAction("incircleAiUpdateReport", Object.assign({ circleId, reportId }, patch || {}));
}

function createUtf8StreamDecoder() {
  let carry = [];
  return function decode(value, flush) {
    if (typeof value === "string") return value;
    let view = null;
    if (value instanceof ArrayBuffer) view = new Uint8Array(value);
    else if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(value)) {
      view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    const incoming = view ? Array.prototype.slice.call(view) : [];
    const bytes = carry.concat(incoming);
    carry = [];
    let usable = bytes.length;
    if (!flush && usable) {
      let index = usable - 1;
      while (index >= 0 && (bytes[index] & 0xc0) === 0x80) index -= 1;
      if (index >= 0) {
        const first = bytes[index];
        const expected = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
        if (usable - index < expected) usable = index;
      }
      carry = bytes.slice(usable);
    }
    let result = "";
    for (let index = 0; index < usable;) {
      const first = bytes[index++];
      if (first < 0x80) {
        result += String.fromCharCode(first);
      } else if (first < 0xe0 && index < usable) {
        result += String.fromCharCode(((first & 0x1f) << 6) | (bytes[index++] & 0x3f));
      } else if (first < 0xf0 && index + 1 < usable) {
        result += String.fromCharCode(((first & 0x0f) << 12) | ((bytes[index++] & 0x3f) << 6) | (bytes[index++] & 0x3f));
      } else if (index + 2 < usable) {
        let codePoint = ((first & 0x07) << 18) | ((bytes[index++] & 0x3f) << 12) | ((bytes[index++] & 0x3f) << 6) | (bytes[index++] & 0x3f);
        codePoint -= 0x10000;
        result += String.fromCharCode(0xd800 + (codePoint >> 10), 0xdc00 + (codePoint & 0x3ff));
      } else {
        result += "�";
      }
    }
    if (flush && carry.length) {
      carry = [];
      result += "�";
    }
    return result;
  };
}

function streamAiChat(payload, handlers) {
  const callbacks = handlers || {};
  const globalData = getGlobalData();
  const accessToken = auth.getAccessToken();
  const decoder = createUtf8StreamDecoder();
  let requestTask = null;
  let lineBuffer = "";
  let receivedChunks = false;
  let settled = false;
  let abortedByCaller = false;
  let startEvent = null;
  let receivedText = "";
  let receivedReasoning = "";
  let recoveryTimer = null;
  let recoveryStarted = false;
  let recoveryStartedAt = 0;
  let stopPromise = null;
  let eventQueue = [];
  let eventQueueRunning = false;
  let pendingTransportError = null;
  let resolvePromise;
  let rejectPromise;

  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const fail = (error) => {
    if (settled) return;
    settled = true;
    if (recoveryTimer) clearTimeout(recoveryTimer);
    recoveryTimer = null;
    eventQueue = [];
    eventQueueRunning = false;
    pendingTransportError = null;
    if (typeof callbacks.onError === "function") callbacks.onError(error);
    rejectPromise(error);
  };
  const finish = (event) => {
    if (settled) return;
    settled = true;
    if (recoveryTimer) clearTimeout(recoveryTimer);
    recoveryTimer = null;
    eventQueue = [];
    eventQueueRunning = false;
    pendingTransportError = null;
    clearCache(["incircleAiStatus", "incircleAiListConversations", "incircleAiListMessages", "incircleAiUsage"]);
    resolvePromise(event || null);
  };
  const streamError = (message, errCode) => {
    const error = new Error(message || "AI 流式连接中断");
    error.errCode = errCode || "AI_NETWORK_ERROR";
    return error;
  };
  const recoveredFrames = (type, content, startOffset) => {
    const source = String(content || "");
    const frames = [];
    for (let offset = 0; offset < source.length;) {
      let end = Math.min(source.length, offset + AI_STREAM_RECOVERY_FRAME_CHARS);
      const lastCode = source.charCodeAt(end - 1);
      const nextCode = source.charCodeAt(end);
      if (lastCode >= 0xd800 && lastCode <= 0xdbff && nextCode >= 0xdc00 && nextCode <= 0xdfff) end += 1;
      frames.push({
        type,
        content: source.slice(offset, end),
        offset: startOffset + offset,
        endOffset: startOffset + end,
        recovered: true,
      });
      offset = end;
    }
    return frames;
  };
  const syncRecoveredMessage = async (assistant, terminal) => {
    if (!assistant) return;
    const fullContent = String(assistant.content || "");
    const fullReasoning = String(assistant.reasoningContent || "");
    const canAppendContent = fullContent.indexOf(receivedText) === 0;
    const canAppendReasoning = fullReasoning.indexOf(receivedReasoning) === 0;
    if (canAppendContent && canAppendReasoning) {
      const remainingReasoning = fullReasoning.slice(receivedReasoning.length);
      const remainingContent = fullContent.slice(receivedText.length);
      recoveredFrames("reasoning", remainingReasoning, receivedReasoning.length).forEach((event) => enqueueEvent(event));
      recoveredFrames("delta", remainingContent, receivedText.length).forEach((event) => enqueueEvent(event));
      return;
    }
    if (terminal && typeof callbacks.onReplaceContent === "function") {
      receivedText = fullContent;
      receivedReasoning = fullReasoning;
      await callbacks.onReplaceContent(fullContent, assistant);
    }
  };
  const recover = (originalError, attempt) => {
    if (settled) return;
    if (recoveryTimer) return;
    if (abortedByCaller) {
      fail(streamError("已停止生成", "AI_CANCELLED"));
      return;
    }
    if (!startEvent || !startEvent.conversationId || !startEvent.messageId) {
      fail(originalError);
      return;
    }
    const index = Number(attempt || 0);
    recoveryStarted = true;
    if (!recoveryStartedAt) recoveryStartedAt = Date.now();
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      listAiMessages(payload.circleId, startEvent.conversationId, { pageSize: 50, force: true })
        .then(async (data) => {
          if (settled) return;
          const messages = (data && data.messages) || [];
          const assistant = messages.find((message) => message.id === startEvent.messageId);
          const canKeepRecovering = Date.now() - recoveryStartedAt < AI_STREAM_RECOVERY_TIMEOUT_MS;
          if (assistant) await syncRecoveredMessage(assistant, assistant.status !== "generating");
          if ((!assistant || assistant.status === "generating") && canKeepRecovering) {
            recover(originalError, Math.min(index + 1, AI_STREAM_RECOVERY_DELAYS_MS.length - 1));
            return;
          }
          if (assistant && assistant.status === "complete") {
            const doneEvent = {
              type: "done",
              conversationId: startEvent.conversationId,
              messageId: startEvent.messageId,
              reasoningDurationMs: Math.max(0, Number(assistant.reasoningDurationMs || 0)),
              recovered: true,
            };
            enqueueEvent(doneEvent);
            return;
          }
          if (assistant && assistant.status === "blocked") {
            enqueueEvent({ type: "terminalError", error: streamError("内容未通过安全检查，请调整后重试", assistant.errorCode || "CONTENT_SECURITY_BLOCKED") });
            return;
          }
          if (assistant && assistant.status === "failed") {
            enqueueEvent({ type: "terminalError", error: streamError("回答没有完成，请重试", assistant.errorCode || "AI_GENERATION_FAILED") });
            return;
          }
          if (assistant && assistant.status === "cancelled") {
            enqueueEvent({ type: "terminalError", error: streamError("已停止生成", assistant.errorCode || "AI_CANCELLED") });
            return;
          }
          fail(originalError);
        })
        .catch(() => {
          if (Date.now() - recoveryStartedAt < AI_STREAM_RECOVERY_TIMEOUT_MS) {
            recover(originalError, Math.min(index + 1, AI_STREAM_RECOVERY_DELAYS_MS.length - 1));
          }
          else fail(originalError);
        });
    }, AI_STREAM_RECOVERY_DELAYS_MS[index] || AI_STREAM_RECOVERY_DELAYS_MS[AI_STREAM_RECOVERY_DELAYS_MS.length - 1]);
  };
  const dispatchEvent = async (event) => {
    if (!event || settled) return;
    if (event.type === "terminalError") {
      fail(event.error || streamError("回答没有完成，请重试", "AI_GENERATION_FAILED"));
      return;
    }
    if (event.type === "error") {
      pendingTransportError = null;
      recover(makeHttpError(event, event.errMsg || "AI 回答生成失败"), 0);
      return;
    }
    if (typeof callbacks.onEvent === "function") await callbacks.onEvent(event);
    if (event.type === "delta") {
      let content = String(event.content || "");
      const offset = Number(event.offset);
      if (Number.isInteger(offset) && offset >= 0 && offset <= receivedText.length) {
        content = content.slice(Math.max(0, receivedText.length - offset));
      }
      receivedText += content;
      if (content && typeof callbacks.onDelta === "function") await callbacks.onDelta(content, event);
    }
    if (event.type === "reasoning") {
      let content = String(event.content || "");
      const offset = Number(event.offset);
      if (Number.isInteger(offset) && offset >= 0 && offset <= receivedReasoning.length) {
        content = content.slice(Math.max(0, receivedReasoning.length - offset));
      }
      receivedReasoning += content;
      if (content && typeof callbacks.onReasoning === "function") await callbacks.onReasoning(content, event);
    }
    if (event.type === "start") {
      startEvent = event;
      if (typeof callbacks.onStart === "function") await callbacks.onStart(event);
    }
    if (event.type === "usage" && typeof callbacks.onUsage === "function") await callbacks.onUsage(event);
    if (event.type === "done") {
      if (typeof callbacks.onDone === "function") await callbacks.onDone(event);
      finish(event);
    }
  };
  const drainEventQueue = async () => {
    if (eventQueueRunning || settled) return;
    eventQueueRunning = true;
    try {
      while (eventQueue.length && !settled) {
        await dispatchEvent(eventQueue.shift());
      }
    } catch (error) {
      fail(error);
    } finally {
      eventQueueRunning = false;
    }
    if (settled) return;
    if (eventQueue.length) {
      drainEventQueue();
      return;
    }
    if (pendingTransportError) {
      const error = pendingTransportError;
      pendingTransportError = null;
      recover(error, 0);
    }
  };
  const enqueueEvent = (event) => {
    if (!event || settled || event.type === "ping") return;
    eventQueue.push(event);
    drainEventQueue();
  };
  const recoverAfterQueuedEvents = (error) => {
    if (settled) return;
    pendingTransportError = error;
    if (!eventQueueRunning && !eventQueue.length) {
      pendingTransportError = null;
      recover(error, 0);
    }
  };
  const consume = (text, flush) => {
    lineBuffer += text || "";
    const lines = lineBuffer.split(/\r?\n/);
    const tail = lines.pop() || "";
    if (flush) {
      lineBuffer = "";
      if (tail) lines.push(tail);
    } else {
      lineBuffer = tail;
    }
    lines.forEach((line) => {
      const value = line.trim();
      if (!value || settled) return;
      if (value.startsWith(":")) return;
      if (/^(event|id|retry)\s*:/i.test(value)) return;
      const eventData = /^data\s*:/i.test(value) ? value.replace(/^data\s*:/i, "").trim() : value;
      if (!eventData || eventData === "[DONE]") return;
      let event;
      try {
        event = JSON.parse(eventData);
      } catch (error) {
        return;
      }
      if (event.type === "start" && !startEvent) startEvent = event;
      enqueueEvent(event);
    });
  };

  requestTask = wx.request({
    url: httpBackendUrl("/api/ai/chat/stream"),
    method: "POST",
    timeout: AI_STREAM_REQUEST_TIMEOUT_MS,
    enableChunked: true,
    enableHttp2: false,
    enableQuic: false,
    enableCache: false,
    dataType: "text",
    responseType: "arraybuffer",
    header: Object.assign(
      {
        "content-type": "application/json",
        accept: "text/event-stream",
        "cache-control": "no-cache",
        "x-incircle-env-version": globalData.envVersion || "",
      },
      globalData.httpBackendHeaders || {},
      accessToken ? { Authorization: `Bearer ${accessToken}` } : {}
    ),
    data: payload || {},
    success(response) {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const error = makeHttpError(normalizeHttpResponseBody(response.data), `AI 请求失败 (${response.statusCode})`);
        if ([408, 502, 503, 504].indexOf(Number(response.statusCode)) !== -1) recover(error, 0);
        else fail(error);
        return;
      }
      if (!receivedChunks && response.data) consume(typeof response.data === "string" ? response.data : decoder(response.data, true), true);
      else consume(decoder(new ArrayBuffer(0), true), true);
      if (!settled) recoverAfterQueuedEvents(streamError("AI 连接提前结束，正在恢复回答", "AI_STREAM_INCOMPLETE"));
    },
    fail(error) {
      const message = error && error.errMsg ? error.errMsg : "AI 请求失败";
      if (abortedByCaller) {
        fail(streamError("已停止生成", "AI_CANCELLED"));
        return;
      }
      recoverAfterQueuedEvents(streamError(message, "AI_NETWORK_ERROR"));
    },
  });
  if (requestTask && typeof requestTask.onChunkReceived === "function") {
    requestTask.onChunkReceived((chunk) => {
      receivedChunks = true;
      consume(decoder(chunk.data, false), false);
    });
  }
  return {
    promise,
    abort() {
      abortedByCaller = true;
      if (recoveryTimer) clearTimeout(recoveryTimer);
      recoveryTimer = null;
      if (requestTask && typeof requestTask.abort === "function") requestTask.abort();
      if (recoveryStarted && !settled) fail(streamError("已停止生成", "AI_CANCELLED"));
    },
    stop() {
      if (stopPromise) return stopPromise;
      if (!startEvent || !startEvent.messageId) {
        return Promise.reject(streamError("回答还在准备中，请稍后再停止", "AI_GENERATION_NOT_READY"));
      }
      abortedByCaller = true;
      stopPromise = cancelAiGeneration(payload.circleId, startEvent.messageId)
        .then((result) => {
          if (!result || !result.cancelled) {
            abortedByCaller = false;
            return result;
          }
          setTimeout(() => {
            if (!settled && requestTask && typeof requestTask.abort === "function") requestTask.abort();
          }, 1200);
          return result;
        })
        .catch((error) => {
          abortedByCaller = false;
          stopPromise = null;
          throw error;
        });
      return stopPromise;
    },
  };
}

module.exports = {
  clearCache,
  getSession,
  login,
  accountLogin,
  registerAccount,
  bindAccount,
  resetPassword,
  changePassword,
  updateTheme,
  logout,
  deleteAccount,
  listMyCircles,
  switchCircle,
  joinCircle,
  createCircle,
  exitCircle,
  dissolveCircle,
  removeCircleMember,
  getJoinPreview,
  getCircleSettings,
  getCircleMember,
  updateCircleInfo,
  rotateInviteCode,
  getInviteQrCode,
  adminOverview,
  adminListCircles,
  adminUpdateCircleStatus,
  adminDeleteCircle,
  adminListUsers,
  adminGetUser,
  adminUpdateUserStatus,
  adminUnbindUserWechat,
  adminDeleteUser,
  adminListOperationLogs,
  adminDeleteOperationLogs,
  getHome,
  listActivities,
  getActivity,
  listTools,
  getBill,
  getVote,
  getCheckin,
  listDocs,
  getDoc,
  listMembers,
  listScoreLogs,
  getMember,
  createActivity,
  updateActivity,
  deleteActivity,
  updateActivityStatus,
  finishActivity,
  addActivityPhoto,
  createBillFromActivity,
  createBill,
  updateBill,
  deleteBill,
  settleBill,
  remindBill,
  createVote,
  updateVote,
  deleteVote,
  voteOption,
  vetoVoteOption,
  finishVote,
  createCheckin,
  updateCheckin,
  deleteCheckin,
  useCheckinCard,
  checkIn,
  updateCheckinRecordMedia,
  runCheckinPunishment,
  runDecision,
  createDoc,
  updateDoc,
  deleteDoc,
  addMemberTag,
  proposeMemberTag,
  voteMemberTagProposal,
  removeMemberTag,
  appealMemberTag,
  updateMyCard,
  getAiStatus,
  getAiSettings,
  updateAiSettings,
  listAiProviders,
  saveAiProvider,
  archiveAiProvider,
  testAiProvider,
  listAiModels,
  syncAiModels,
  saveAiModel,
  updateAiModel,
  testAiModel,
  listAiConversations,
  createAiConversation,
  deleteAiConversation,
  listAiMessages,
  cancelAiGeneration,
  grantAiConsent,
  reportAiMessage,
  getAiUsage,
  listAiReports,
  updateAiReport,
  streamAiChat,
};
