const { AppError } = require("../errors");

let accessTokenCache = {
  key: "",
  token: "",
  expiresAtMs: 0,
};

async function exchangeWechatLoginCode(config, code) {
  const loginCode = String(code || "").trim();
  if (!loginCode) {
    throw new AppError("缺少微信登录 code，请重新打开小程序", {
      statusCode: 401,
      errCode: "WECHAT_CODE_REQUIRED",
    });
  }
  if (!config.wechatAppId || !config.wechatAppSecret) {
    throw new AppError("自建后端未配置 WECHAT_APP_ID / WECHAT_APP_SECRET", {
      statusCode: 503,
      errCode: "WECHAT_CONFIG_REQUIRED",
    });
  }

  const url =
    "https://api.weixin.qq.com/sns/jscode2session" +
    `?appid=${encodeURIComponent(config.wechatAppId)}` +
    `&secret=${encodeURIComponent(config.wechatAppSecret)}` +
    `&js_code=${encodeURIComponent(loginCode)}` +
    "&grant_type=authorization_code";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let response;
  let data;
  try {
    response = await fetch(url, { signal: controller.signal });
    data = await response.json();
  } catch (error) {
    throw new AppError("微信登录校验服务暂时不可用，请稍后重试", {
      statusCode: 502,
      errCode: "WECHAT_LOGIN_UNAVAILABLE",
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok || data.errcode || !data.openid) {
    throw new AppError(data.errmsg || "微信登录校验失败", {
      statusCode: 401,
      errCode: "WECHAT_CODE_INVALID",
      details: data,
    });
  }

  return {
    openid: data.openid,
    unionid: data.unionid || "",
    sessionKey: data.session_key || "",
  };
}

async function getWechatAccessToken(config) {
  if (!config.wechatAppId || !config.wechatAppSecret) {
    throw new AppError("自建后端未配置 WECHAT_APP_ID / WECHAT_APP_SECRET，无法生成微信小程序码", {
      statusCode: 503,
      errCode: "WECHAT_CONFIG_REQUIRED",
    });
  }

  const cacheKey = `${config.wechatAppId}:${config.wechatAppSecret}`;
  const now = Date.now();
  if (accessTokenCache.key === cacheKey && accessTokenCache.token && accessTokenCache.expiresAtMs - now > 60000) {
    return accessTokenCache.token;
  }

  const url =
    "https://api.weixin.qq.com/cgi-bin/token" +
    "?grant_type=client_credential" +
    `&appid=${encodeURIComponent(config.wechatAppId)}` +
    `&secret=${encodeURIComponent(config.wechatAppSecret)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let response;
  let data;
  try {
    response = await fetch(url, { signal: controller.signal });
    data = await response.json();
  } catch (error) {
    throw new AppError("微信 access_token 服务暂时不可用", {
      statusCode: 502,
      errCode: "WECHAT_ACCESS_TOKEN_UNAVAILABLE",
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok || data.errcode || !data.access_token) {
    throw new AppError(data.errmsg || "微信 access_token 获取失败", {
      statusCode: 502,
      errCode: "WECHAT_ACCESS_TOKEN_FAILED",
      details: data,
    });
  }

  accessTokenCache = {
    key: cacheKey,
    token: data.access_token,
    expiresAtMs: now + Math.max(Number(data.expires_in || 7200) - 300, 60) * 1000,
  };
  return accessTokenCache.token;
}

function imageExtensionFromBuffer(buffer) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpg";
  }
  return "png";
}

function normalizeQrEnvVersion(value, fallback) {
  const raw = String(value || fallback || "release").trim();
  return raw === "develop" || raw === "trial" || raw === "release" ? raw : "release";
}

async function createMiniProgramCode(config, options) {
  const scene = String((options && options.scene) || "").trim();
  const page = String((options && options.page) || "").replace(/^\/+/, "");
  if (!scene) throw new AppError("缺少入圈码参数", { statusCode: 400, errCode: "QRCODE_SCENE_REQUIRED" });
  if (!page) throw new AppError("缺少小程序页面路径", { statusCode: 400, errCode: "QRCODE_PAGE_REQUIRED" });

  const accessToken = await getWechatAccessToken(config);
  const normalizedScene = scene.slice(0, 32);
  const envVersion = normalizeQrEnvVersion(options && options.envVersion, config.wechatQrEnvVersion);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let response;
  let arrayBuffer;
  try {
    response = await fetch(
      `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${encodeURIComponent(accessToken)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scene: normalizedScene,
          page,
          check_path: false,
          env_version: envVersion,
          width: 430,
          auto_color: false,
          line_color: { r: 34, g: 91, b: 77 },
          is_hyaline: false,
        }),
        signal: controller.signal,
      }
    );
    arrayBuffer = await response.arrayBuffer();
  } catch (error) {
    throw new AppError("微信小程序码服务暂时不可用，请稍后重试", {
      statusCode: 502,
      errCode: "WECHAT_MINI_CODE_UNAVAILABLE",
    });
  } finally {
    clearTimeout(timer);
  }
  const buffer = Buffer.from(arrayBuffer);
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json") || buffer[0] === 0x7b) {
    let data = {};
    try {
      data = JSON.parse(buffer.toString("utf8"));
    } catch (error) {
      data = { errmsg: buffer.toString("utf8") };
    }
    throw new AppError(data.errmsg || "微信小程序码生成失败", {
      statusCode: 502,
      errCode: "WECHAT_MINI_CODE_FAILED",
      details: data,
    });
  }
  if (!response.ok || buffer.length < 100) {
    throw new AppError("微信小程序码生成失败", {
      statusCode: 502,
      errCode: "WECHAT_MINI_CODE_FAILED",
    });
  }
  return {
    buffer,
    extension: imageExtensionFromBuffer(buffer),
    envVersion,
    page,
    scene: normalizedScene,
  };
}

async function checkTextSecurity(config, options) {
  if (!config.aiContentSecurityEnabled) return { safe: true, skipped: true };
  const content = String((options && options.content) || "").trim();
  if (!content) return { safe: true };
  if (content.length > 2000) {
    for (let index = 0; index < content.length; index += 2000) {
      await checkTextSecurity(config, Object.assign({}, options, { content: content.slice(index, index + 2000) }));
    }
    return { safe: true };
  }
  const openid = String((options && options.openid) || "").trim();
  if (!openid) {
    throw new AppError("无法确认内容安全检查用户", {
      statusCode: 503,
      errCode: "CONTENT_SECURITY_IDENTITY_REQUIRED",
    });
  }
  const accessToken = await getWechatAccessToken(config);
  let response;
  let data;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    response = await fetch(
      `https://api.weixin.qq.com/wxa/msg_sec_check?access_token=${encodeURIComponent(accessToken)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: content.slice(0, 2500), version: 2, scene: 2, openid }),
        signal: controller.signal,
      }
    );
    data = await response.json();
  } catch (error) {
    throw new AppError("内容安全服务暂时不可用，请稍后再试", {
      statusCode: 503,
      errCode: "CONTENT_SECURITY_UNAVAILABLE",
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok || data.errcode) {
    throw new AppError("内容安全服务暂时不可用，请稍后再试", {
      statusCode: 503,
      errCode: "CONTENT_SECURITY_UNAVAILABLE",
      details: { wechatErrCode: data.errcode || response.status },
    });
  }
  const suggest = data.result && data.result.suggest;
  if (suggest && suggest !== "pass") {
    throw new AppError("这段内容未通过安全检查，请修改后再试", {
      statusCode: 400,
      errCode: "CONTENT_SECURITY_BLOCKED",
    });
  }
  return { safe: true };
}

module.exports = {
  checkTextSecurity,
  createMiniProgramCode,
  exchangeWechatLoginCode,
};
