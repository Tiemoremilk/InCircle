const crypto = require("crypto");

const { AppError } = require("./errors");

function encodeBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value) {
  return Buffer.from(String(value || ""), "base64url").toString("utf8");
}

function signatureFor(config, input) {
  return crypto.createHmac("sha256", config.jwtSecret).update(input).digest("base64url");
}

function requireJwtSecret(config) {
  if (!config.jwtSecret || config.jwtSecret.length < 32) {
    throw new AppError("服务端登录密钥未正确配置", {
      statusCode: 503,
      errCode: "AUTH_CONFIG_REQUIRED",
    });
  }
}

function issueAccessToken(config, user, session) {
  requireJwtSecret(config);
  if (!session || !session.id || !session.token_version) {
    throw new AppError("登录设备会话未建立", {
      statusCode: 500,
      errCode: "ACCOUNT_SESSION_REQUIRED",
    });
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const configuredExpiry = nowSeconds + config.jwtTtlSeconds;
  const sessionExpiry = Math.floor(new Date(session.expires_at).getTime() / 1000);
  const expiresAtSeconds = Number.isFinite(sessionExpiry)
    ? Math.min(configuredExpiry, sessionExpiry)
    : configuredExpiry;
  const header = encodeBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = encodeBase64Url(
    JSON.stringify({
      sub: String(user.id),
      openid: String(user.openid || ""),
      sid: String(session.id),
      sessionVersion: Number(session.token_version),
      iat: nowSeconds,
      exp: expiresAtSeconds,
      version: 2,
      authVersion: Number(user.auth_version || 1),
    })
  );
  const input = `${header}.${payload}`;
  return {
    token: `${input}.${signatureFor(config, input)}`,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
  };
}

function verifyAccessToken(config, token) {
  requireJwtSecret(config);
  const parts = String(token || "").split(".");
  if (parts.length !== 3) {
    throw new AppError("登录凭证无效，请重新登录", { statusCode: 401, errCode: "TOKEN_INVALID" });
  }
  const input = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(signatureFor(config, input));
  const actual = Buffer.from(parts[2]);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new AppError("登录凭证无效，请重新登录", { statusCode: 401, errCode: "TOKEN_INVALID" });
  }

  let payload;
  try {
    payload = JSON.parse(decodeBase64Url(parts[1]));
  } catch (error) {
    throw new AppError("登录凭证无效，请重新登录", { statusCode: 401, errCode: "TOKEN_INVALID" });
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp <= nowSeconds) {
    throw new AppError("登录状态已过期，请重新登录", { statusCode: 401, errCode: "TOKEN_EXPIRED" });
  }
  if (!payload.sub || ![1, 2].includes(payload.version)) {
    throw new AppError("登录凭证无效，请重新登录", { statusCode: 401, errCode: "TOKEN_INVALID" });
  }
  if (payload.version === 2 && (!payload.sid || !payload.sessionVersion)) {
    throw new AppError("登录凭证无效，请重新登录", { statusCode: 401, errCode: "TOKEN_INVALID" });
  }
  return {
    userId: String(payload.sub),
    openid: String(payload.openid || ""),
    authVersion: Number(payload.authVersion || 1),
    sessionId: String(payload.sid || ""),
    sessionVersion: Number(payload.sessionVersion || 0),
    tokenVersion: Number(payload.version || 1),
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    source: "token",
  };
}

function bearerToken(request) {
  const value = String((request && request.headers && request.headers.authorization) || "");
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

module.exports = {
  bearerToken,
  issueAccessToken,
  verifyAccessToken,
};
