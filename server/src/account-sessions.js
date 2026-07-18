const crypto = require("crypto");

const { AppError } = require("./errors");

const MAX_DEVICE_SESSIONS = 50;
const PUBLIC_DEVICE_SESSIONS = MAX_DEVICE_SESSIONS;
const LOGIN_LOCATION_RETENTION_DAYS = 90;

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function cleanText(value, maximum) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function loginAddressFromRequest(request) {
  const address = cleanText((request && request.ip) || "", 128).replace(/^::ffff:/i, "");
  return address || "未知地址";
}

function deviceContextFromBody(body, identity, request) {
  const source = body && body.deviceContext && typeof body.deviceContext === "object"
    ? body.deviceContext
    : {};
  const suppliedKey = cleanText(source.deviceKey, 160);
  const fallbackKey = [
    "legacy",
    identity && identity.openid,
    loginAddressFromRequest(request),
    request && request.headers && request.headers["user-agent"],
  ].map((part) => cleanText(part, 160)).join(":");
  const deviceKey = suppliedKey.length >= 16 ? suppliedKey : fallbackKey;
  const brand = cleanText(source.brand, 80);
  const model = cleanText(source.model, 120);
  const platform = cleanText(source.platform, 40);
  const systemVersion = cleanText(source.system, 100);
  const wechatVersion = cleanText(source.wechatVersion, 40);
  const sdkVersion = cleanText(source.sdkVersion, 40);
  const environmentVersion = cleanText(
    source.environmentVersion || (request && request.headers && request.headers["x-incircle-env-version"]),
    40
  );
  const suppliedName = cleanText(source.deviceName, 160);
  return {
    deviceKeyHash: sha256(deviceKey),
    loginOpenidHash: identity && identity.openid ? sha256(identity.openid) : "",
    deviceName: suppliedName || cleanText([brand, model].filter(Boolean).join(" "), 160) || "未知设备",
    brand,
    model,
    platform,
    systemVersion,
    wechatVersion,
    sdkVersion,
    environmentVersion,
    loginAddress: loginAddressFromRequest(request),
  };
}

function expiryDate(config) {
  return new Date(Date.now() + Number(config.jwtTtlSeconds || 86400) * 1000);
}

async function establishAccountSession(db, config, request, user, identity, body) {
  const device = deviceContextFromBody(body, identity, request);
  const result = await db.query(
    `
    INSERT INTO incircle_account_sessions (
      user_id, device_key_hash, token_version, login_openid_hash,
      device_name, device_brand, device_model, platform, system_version,
      wechat_version, sdk_version, environment_version, login_address,
      last_login_at, expires_at, revoked_at, revoked_reason
    ) VALUES (
      $1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
      now(), $13, NULL, ''
    )
    ON CONFLICT (user_id, device_key_hash) DO UPDATE SET
      token_version = incircle_account_sessions.token_version + 1,
      login_openid_hash = EXCLUDED.login_openid_hash,
      device_name = EXCLUDED.device_name,
      device_brand = EXCLUDED.device_brand,
      device_model = EXCLUDED.device_model,
      platform = EXCLUDED.platform,
      system_version = EXCLUDED.system_version,
      wechat_version = EXCLUDED.wechat_version,
      sdk_version = EXCLUDED.sdk_version,
      environment_version = EXCLUDED.environment_version,
      login_address = EXCLUDED.login_address,
      login_location_source = '',
      login_latitude = NULL,
      login_longitude = NULL,
      login_accuracy_m = NULL,
      login_location_province = '',
      login_location_city = '',
      login_location_district = '',
      login_location_detail = '',
      login_location_captured_at = NULL,
      last_login_at = now(),
      expires_at = EXCLUDED.expires_at,
      revoked_at = NULL,
      revoked_reason = '',
      updated_at = now()
    RETURNING *
    `,
    [
      user.id,
      device.deviceKeyHash,
      device.loginOpenidHash,
      device.deviceName,
      device.brand,
      device.model,
      device.platform,
      device.systemVersion,
      device.wechatVersion,
      device.sdkVersion,
      device.environmentVersion,
      device.loginAddress,
      expiryDate(config),
    ]
  );
  const session = result.rows[0];
  if (!session) {
    throw new AppError("登录设备会话创建失败，请重试", {
      statusCode: 503,
      errCode: "ACCOUNT_SESSION_CREATE_FAILED",
    });
  }
  await db.query(
    `
    DELETE FROM incircle_account_sessions
    WHERE id IN (
      SELECT id
      FROM incircle_account_sessions
      WHERE user_id = $1 AND id <> $2
      ORDER BY last_login_at DESC, created_at DESC
      OFFSET $3
    )
    `,
    [user.id, session.id, MAX_DEVICE_SESSIONS - 1]
  );
  return session;
}

async function requireActiveAccountSession(db, identity, userId) {
  const sessionId = String((identity && identity.sessionId) || "");
  if (!sessionId) {
    throw new AppError("登录状态需要更新，请重新登录", {
      statusCode: 401,
      errCode: "TOKEN_SESSION_REQUIRED",
    });
  }
  const result = await db.query(
    "SELECT * FROM incircle_account_sessions WHERE id = $1 AND user_id = $2 LIMIT 1",
    [sessionId, userId]
  );
  const session = result.rows[0];
  if (!session || session.revoked_at || Number(session.token_version) !== Number(identity.sessionVersion || 0)) {
    throw new AppError("该设备已退出登录，请重新登录", {
      statusCode: 401,
      errCode: "ACCOUNT_SESSION_REVOKED",
    });
  }
  if (!session.expires_at || new Date(session.expires_at).getTime() <= Date.now()) {
    throw new AppError("登录状态已过期，请重新登录", {
      statusCode: 401,
      errCode: "ACCOUNT_SESSION_EXPIRED",
    });
  }
  return session;
}

async function rotateCurrentAccountSession(db, config, identity, userId) {
  const sessionId = String((identity && identity.sessionId) || "");
  if (!sessionId) return null;
  const result = await db.query(
    `
    UPDATE incircle_account_sessions
    SET token_version = token_version + 1,
        expires_at = $3,
        revoked_at = NULL,
        revoked_reason = '',
        last_login_at = now(),
        updated_at = now()
    WHERE id = $1 AND user_id = $2
    RETURNING *
    `,
    [sessionId, userId, expiryDate(config)]
  );
  return result.rows[0] || null;
}

async function revokeAllAccountSessions(db, userId, reason, exceptSessionId) {
  await db.query(
    `
    UPDATE incircle_account_sessions
    SET revoked_at = COALESCE(revoked_at, now()),
        revoked_reason = $2,
        updated_at = now()
    WHERE user_id = $1
      AND ($3::uuid IS NULL OR id <> $3::uuid)
      AND revoked_at IS NULL
    `,
    [userId, cleanText(reason || "账号安全状态已变化", 120), exceptSessionId || null]
  );
}

function publicAccountSession(row, currentSessionId) {
  const current = String(row.id) === String(currentSessionId || "");
  const expired = !row.expires_at || new Date(row.expires_at).getTime() <= Date.now();
  const active = !row.revoked_at && !expired;
  const environment = [
    row.platform,
    row.system_version,
    row.wechat_version ? `微信 ${row.wechat_version}` : "",
    row.environment_version ? `${row.environment_version} 版` : "",
  ].filter(Boolean).join(" · ");
  const hasLocation = row.login_latitude !== null
    && typeof row.login_latitude !== "undefined"
    && row.login_longitude !== null
    && typeof row.login_longitude !== "undefined"
    && Number.isFinite(Number(row.login_latitude))
    && Number.isFinite(Number(row.login_longitude))
    && !!row.login_location_captured_at;
  return {
    id: row.id,
    deviceName: row.device_name || row.device_model || row.device_brand || "未知设备",
    deviceBrand: row.device_brand || "",
    deviceModel: row.device_model || "",
    environment: environment || "环境信息暂不可用",
    loginAddress: row.login_address || "未知地址",
    loginLocation: {
      available: hasLocation,
      source: hasLocation ? row.login_location_source || "wx.getLocation" : "",
      latitude: hasLocation ? Number(row.login_latitude) : null,
      longitude: hasLocation ? Number(row.login_longitude) : null,
      accuracyMeters: hasLocation && row.login_accuracy_m !== null
        ? Number(row.login_accuracy_m)
        : null,
      province: hasLocation ? row.login_location_province || "" : "",
      city: hasLocation ? row.login_location_city || "" : "",
      district: hasLocation ? row.login_location_district || "" : "",
      detail: hasLocation ? row.login_location_detail || "" : "",
      capturedAt: hasLocation ? row.login_location_captured_at : null,
    },
    lastLoginAt: row.last_login_at || null,
    expiresAt: row.expires_at || null,
    status: current ? "current" : active ? "active" : row.revoked_at ? "revoked" : "expired",
    statusText: current ? "当前设备" : active ? "已登录" : row.revoked_at ? "已退出" : "已过期",
    current,
    canRevoke: active && !current,
    canDelete: !active && !current,
  };
}

async function clearExpiredAccountSessionLocations(db, userId) {
  const userFilter = userId ? "AND user_id = $2" : "";
  const result = await db.query(
    `
    UPDATE incircle_account_sessions
    SET login_location_source = '',
        login_latitude = NULL,
        login_longitude = NULL,
        login_accuracy_m = NULL,
        login_location_province = '',
        login_location_city = '',
        login_location_district = '',
        login_location_detail = '',
        login_location_captured_at = NULL,
        updated_at = now()
    WHERE login_location_captured_at < now() - ($1::text || ' days')::interval
      ${userFilter}
    `,
    userId ? [LOGIN_LOCATION_RETENTION_DAYS, userId] : [LOGIN_LOCATION_RETENTION_DAYS]
  );
  return Number(result.rowCount || 0);
}

async function clearAccountSessionLocations(db, userId) {
  await db.query(
    `
    UPDATE incircle_account_sessions
    SET login_location_source = '',
        login_latitude = NULL,
        login_longitude = NULL,
        login_accuracy_m = NULL,
        login_location_province = '',
        login_location_city = '',
        login_location_district = '',
        login_location_detail = '',
        login_location_captured_at = NULL,
        updated_at = now()
    WHERE user_id = $1
      AND login_location_captured_at IS NOT NULL
    `,
    [userId]
  );
}

async function updateCurrentAccountSessionLocation(db, userId, sessionId, location) {
  const result = await db.query(
    `
    UPDATE incircle_account_sessions
    SET login_location_source = $3,
        login_latitude = $4,
        login_longitude = $5,
        login_accuracy_m = $6,
        login_location_province = $7,
        login_location_city = $8,
        login_location_district = $9,
        login_location_detail = $10,
        login_location_captured_at = now(),
        updated_at = now()
    WHERE id = $1
      AND user_id = $2
      AND revoked_at IS NULL
      AND expires_at > now()
    RETURNING *
    `,
    [
      sessionId,
      userId,
      location.source,
      location.latitude,
      location.longitude,
      location.accuracy,
      location.province || "",
      location.city || "",
      location.district || "",
      location.detail || "",
    ]
  );
  if (!result.rows[0]) {
    throw new AppError("当前登录设备已失效，请重新登录", {
      statusCode: 401,
      errCode: "ACCOUNT_SESSION_REVOKED",
    });
  }
  return result.rows[0];
}

function accountSessionLimit(value) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return PUBLIC_DEVICE_SESSIONS;
  return Math.min(PUBLIC_DEVICE_SESSIONS, parsed);
}

async function readAccountSessionCollection(db, userId, currentSessionId, options) {
  await clearExpiredAccountSessionLocations(db, userId);
  const limit = accountSessionLimit(options && options.limit);
  const result = await db.query(
    `
    SELECT *,
      count(*) OVER()::integer AS session_total,
      count(*) FILTER (
        WHERE revoked_at IS NULL AND expires_at > now()
      ) OVER()::integer AS active_session_count
    FROM incircle_account_sessions
    WHERE user_id = $1
    ORDER BY last_login_at DESC, created_at DESC, id DESC
    LIMIT $2
    `,
    [userId, limit]
  );
  const rows = result.rows || [];
  const total = rows.length ? Number(rows[0].session_total || rows.length) : 0;
  const activeSessionCount = rows.length
    ? Number(rows[0].active_session_count || 0)
    : 0;
  const sessions = rows.map((row) => publicAccountSession(row, currentSessionId));
  return {
    sessions,
    total,
    activeSessionCount,
    hasMore: total > sessions.length,
  };
}

async function listAccountSessions(db, userId, currentSessionId, options) {
  const collection = await readAccountSessionCollection(
    db,
    userId,
    currentSessionId,
    options
  );
  return collection.sessions;
}

async function revokeAccountSession(db, userId, currentSessionId, targetSessionId) {
  if (String(currentSessionId || "") === String(targetSessionId || "")) {
    throw new AppError("当前登录设备不能在这里退出", {
      statusCode: 409,
      errCode: "CURRENT_SESSION_CANNOT_REVOKE",
    });
  }
  const result = await db.query(
    `
    UPDATE incircle_account_sessions
    SET revoked_at = COALESCE(revoked_at, now()),
        revoked_reason = '用户主动退出设备',
        updated_at = now()
    WHERE id = $1 AND user_id = $2
    RETURNING id
    `,
    [targetSessionId, userId]
  );
  if (!result.rows[0]) {
    throw new AppError("登录设备不存在或已被清理", {
      statusCode: 404,
      errCode: "ACCOUNT_SESSION_NOT_FOUND",
    });
  }
  return result.rows[0];
}

async function deleteAccountSession(db, userId, currentSessionId, targetSessionId) {
  if (String(currentSessionId || "") === String(targetSessionId || "")) {
    throw new AppError("当前登录设备不能删除", {
      statusCode: 409,
      errCode: "CURRENT_SESSION_CANNOT_DELETE",
    });
  }
  const selected = await db.query(
    `
    SELECT id, revoked_at, expires_at
    FROM incircle_account_sessions
    WHERE id = $1 AND user_id = $2
    LIMIT 1
    FOR UPDATE
    `,
    [targetSessionId, userId]
  );
  const session = selected.rows[0];
  if (!session) {
    throw new AppError("登录记录不存在或已被清理", {
      statusCode: 404,
      errCode: "ACCOUNT_SESSION_NOT_FOUND",
    });
  }
  const expired = !session.expires_at || new Date(session.expires_at).getTime() <= Date.now();
  if (!session.revoked_at && !expired) {
    throw new AppError("请先退出这台设备，再删除登录记录", {
      statusCode: 409,
      errCode: "ACTIVE_SESSION_CANNOT_DELETE",
    });
  }
  const removed = await db.query(
    "DELETE FROM incircle_account_sessions WHERE id = $1 AND user_id = $2 RETURNING id",
    [targetSessionId, userId]
  );
  if (!removed.rows[0]) {
    throw new AppError("登录记录不存在或已被清理", {
      statusCode: 404,
      errCode: "ACCOUNT_SESSION_NOT_FOUND",
    });
  }
  return removed.rows[0];
}

function sessionMatchesBoundWechat(session, user) {
  if (!session || !user || !user.openid || !session.login_openid_hash) return false;
  return session.login_openid_hash === sha256(user.openid);
}

module.exports = {
  LOGIN_LOCATION_RETENTION_DAYS,
  clearAccountSessionLocations,
  clearExpiredAccountSessionLocations,
  deleteAccountSession,
  establishAccountSession,
  listAccountSessions,
  loginAddressFromRequest,
  readAccountSessionCollection,
  requireActiveAccountSession,
  revokeAccountSession,
  revokeAllAccountSessions,
  rotateCurrentAccountSession,
  sessionMatchesBoundWechat,
  sha256,
  updateCurrentAccountSessionLocation,
};
