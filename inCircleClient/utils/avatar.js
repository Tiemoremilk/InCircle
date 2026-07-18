const auth = require("./auth");

function getGlobalData() {
  if (typeof getApp !== "function") return {};
  try {
    const app = getApp();
    return (app && app.globalData) || {};
  } catch (error) {
    return {};
  }
}

function isTemporaryAvatar(value) {
  const src = String(value || "");
  return src.indexOf("wxfile://") === 0 || src.indexOf("http://tmp/") === 0 || src.indexOf("https://tmp/") === 0;
}

function isLegacyStorageFileID(value) {
  return String(value || "").indexOf("cloud://") === 0;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function defaultAvatar(value) {
  if (!value || isLegacyStorageFileID(value) || isTemporaryAvatar(value)) return "/images/avatar.png";
  return value;
}

function sanitizeKeyPart(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function getFileSize(filePath) {
  if (typeof wx === "undefined" || typeof wx.getFileInfo !== "function") {
    return Promise.resolve(0);
  }
  return new Promise((resolve) => {
    wx.getFileInfo({
      filePath,
      success: (res) => resolve(Number(res.size || 0)),
      fail: () => resolve(0),
    });
  });
}

function compressImage(filePath, quality) {
  if (typeof wx === "undefined" || typeof wx.compressImage !== "function") {
    return Promise.resolve(filePath);
  }
  return new Promise((resolve) => {
    wx.compressImage({
      src: filePath,
      quality,
      success: (res) => resolve((res && res.tempFilePath) || filePath),
      fail: () => resolve(filePath),
    });
  });
}

const AVATAR_TARGET_BYTES = 700 * 1024;
const AVATAR_QUALITIES = [72, 55, 42, 32];

function compressAvatar(filePath) {
  if (!isTemporaryAvatar(filePath)) return Promise.resolve(filePath);
  return AVATAR_QUALITIES.reduce(
    (promise, quality) =>
      promise.then((currentPath) =>
        getFileSize(currentPath).then((size) => {
          if (size && size <= AVATAR_TARGET_BYTES) return currentPath;
          return compressImage(currentPath, quality);
        })
      ),
    Promise.resolve(filePath)
  );
}

function httpBackendUrl(path) {
  const globalData = getGlobalData();
  const baseUrl = String(globalData.httpBackendBaseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("HTTP 后端地址未配置");
  return `${baseUrl}${path}`;
}

function uploadDomainHint() {
  return "头像上传失败：请在微信小程序后台配置正确的 uploadFile 合法域名";
}

function normalizeUploadError(error, fallback) {
  const message = String((error && (error.errMsg || error.message)) || fallback || "头像上传失败");
  if (/url not in domain list|domain list|合法域名/i.test(message)) return uploadDomainHint();
  if (/fail url/i.test(message)) return uploadDomainHint();
  return message;
}

function normalizeUploadOptions(options) {
  if (typeof options === "string") return { folder: options };
  return options || {};
}

function buildAvatarKey(options) {
  const globalData = getGlobalData();
  const circleId = sanitizeKeyPart(options.circleId || globalData.currentCircleId);
  const userKey = sanitizeKeyPart(options.userId || globalData.userId || options.openid || options.cardId);
  return circleId && userKey ? `${circleId}-${userKey}` : "";
}

function uploadFileToHttp(filePath, options) {
  if (!filePath) return Promise.resolve("/images/avatar.png");
  if (!isTemporaryAvatar(filePath)) return Promise.resolve(defaultAvatar(filePath));
  if (typeof wx === "undefined" || typeof wx.uploadFile !== "function") {
    return Promise.reject(new Error("当前微信基础库不支持上传文件"));
  }
  const uploadOptions = normalizeUploadOptions(options);
  const token = auth.getAccessToken();
  const codePromise = token ? Promise.resolve("") : auth.getWechatLoginCode();
  return codePromise.then(
    (wechatLoginCode) =>
      new Promise((resolve, reject) => {
        wx.uploadFile({
          url: httpBackendUrl("/api/upload"),
          filePath,
          name: "file",
          header: token ? auth.authorizationHeader() : {},
          formData: {
            folder: uploadOptions.folder || "avatars",
            kind: uploadOptions.kind || "",
            circleId: uploadOptions.circleId || getGlobalData().currentCircleId || "",
            wechatLoginCode,
          },
          success(response) {
            let body = response && response.data;
            if (typeof body === "string") {
              try {
                body = JSON.parse(body);
              } catch (error) {
                body = null;
              }
            }
            if (!response || response.statusCode < 200 || response.statusCode >= 300 || !body || body.success === false) {
              const error = new Error((body && body.errMsg) || `头像上传失败 (${response && response.statusCode})`);
              if (body && body.errCode) error.errCode = body.errCode;
               if (body && typeof body.details !== "undefined") error.details = body.details;
               auth.handleAgreementRequired(error);
               auth.handleAuthenticationRequired(error);
               reject(error);
              return;
            }
            const data = body.data || body;
            resolve(data.url || data.src || "/images/avatar.png");
          },
          fail(error) {
            reject(new Error(normalizeUploadError(error, "头像上传失败")));
          },
        });
      })
  );
}

function uploadAvatar(filePath, options) {
  const avatarOptions = normalizeUploadOptions(options);
  const avatarKey = avatarOptions.avatarKey || buildAvatarKey(avatarOptions);
  return compressAvatar(filePath).then((compressedPath) =>
    uploadFileToHttp(compressedPath, {
      folder: "avatars",
      kind: "avatar",
      avatarKey,
      circleId: avatarOptions.circleId || getGlobalData().currentCircleId || "",
    })
  );
}

function resolveAvatarUrl(value) {
  if (isHttpUrl(value)) return Promise.resolve(value);
  return Promise.resolve(defaultAvatar(value));
}

function resolveDataAvatarUrls(data) {
  return Promise.resolve(data);
}

module.exports = {
  isTemporaryAvatar,
  isLegacyStorageFileID,
  uploadAvatar,
  resolveAvatarUrl,
  resolveDataAvatarUrls,
};
