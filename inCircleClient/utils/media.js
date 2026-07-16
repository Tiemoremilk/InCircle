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

function sanitizePathPart(value) {
  return String(value || "media")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-");
}

function httpBackendUrl(path) {
  const globalData = getGlobalData();
  const baseUrl = String(globalData.httpBackendBaseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("HTTP 后端地址未配置");
  return `${baseUrl}${path}`;
}

function uploadDomainHint() {
  return "图片上传失败：请在微信小程序后台配置正确的 uploadFile 合法域名";
}

function normalizeUploadError(error, fallback) {
  const message = String((error && (error.errMsg || error.message)) || fallback || "图片上传失败");
  if (/url not in domain list|domain list|合法域名/i.test(message)) return uploadDomainHint();
  if (/fail url/i.test(message)) return uploadDomainHint();
  return message;
}

function chooseImages(options) {
  return new Promise((resolve, reject) => {
    if (typeof wx === "undefined" || !wx.chooseMedia) {
      reject(new Error("chooseMedia unavailable"));
      return;
    }
    wx.chooseMedia({
      count: (options && options.count) || 1,
      mediaType: ["image"],
      sourceType: ["album", "camera"],
      sizeType: ["compressed"],
      success: (res) => resolve(res.tempFiles || []),
      fail: (error) => reject(error),
    });
  });
}

function parseUploadResponse(response, fallbackMessage) {
  let body = response && response.data;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (error) {
      body = null;
    }
  }
  if (!response || response.statusCode < 200 || response.statusCode >= 300 || !body || body.success === false) {
    const error = new Error((body && body.errMsg) || `${fallbackMessage || "图片上传失败"} (${response && response.statusCode})`);
    if (body && body.errCode) error.errCode = body.errCode;
    if (body && typeof body.details !== "undefined") error.details = body.details;
    auth.handleAgreementRequired(error);
    throw error;
  }
  return body.data || body;
}

function uploadOne(file, folder, index) {
  const tempFilePath = file.tempFilePath || file.path || file.src;
  if (!tempFilePath) return Promise.reject(new Error("图片路径为空"));
  if (/^https?:\/\//i.test(tempFilePath)) {
    return Promise.resolve({
      src: tempFilePath,
      size: file.size || 0,
      source: "http",
    });
  }
  if (typeof wx === "undefined" || typeof wx.uploadFile !== "function") {
    return Promise.reject(new Error("当前微信基础库不支持上传文件"));
  }
  const accessToken = auth.getAccessToken();
  if (!accessToken) return Promise.reject(new Error("请先登录后再上传图片"));
  const globalData = getGlobalData();
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: httpBackendUrl("/api/upload"),
      filePath: tempFilePath,
      name: "file",
      header: auth.authorizationHeader(),
      formData: {
        folder: sanitizePathPart(folder || `media-${index}`),
        circleId: globalData.currentCircleId || "",
      },
      success(response) {
        try {
          const data = parseUploadResponse(response, "图片上传失败");
          resolve({
            src: data.url || data.src,
            fileId: "",
            path: data.path || "",
            size: file.size || data.size || 0,
            source: "http",
          });
        } catch (error) {
          reject(error);
        }
      },
      fail(error) {
        reject(new Error(normalizeUploadError(error, "图片上传失败")));
      },
    });
  });
}

function prepareImages(files, folder) {
  return Promise.all((files || []).map((file, index) => uploadOne(file, folder, index)));
}

function isCancel(error) {
  return !!(error && error.errMsg && error.errMsg.indexOf("cancel") !== -1);
}

module.exports = {
  chooseImages,
  prepareImages,
  isCancel,
};
