require("dotenv").config();

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function listFromEnv(name, fallback) {
  const raw = process.env[name] || fallback || "";
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function booleanFromEnv(name, fallback) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (!value) return !!fallback;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function validEncryptionKey(value) {
  const raw = String(value || "").trim();
  if (/^[a-f0-9]{64}$/i.test(raw)) return true;
  try {
    return Buffer.from(raw, "base64").length === 32;
  } catch (error) {
    return false;
  }
}

function loadConfig() {
  const nodeEnv = process.env.NODE_ENV || "development";
  const uploadDir = process.env.UPLOAD_DIR || "/app/uploads";
  const config = {
    nodeEnv,
    host: process.env.HOST || "0.0.0.0",
    port: numberFromEnv("PORT", 3000),
    databaseUrl:
      process.env.DATABASE_URL ||
      "postgres://incircle:change-this-password@localhost:5432/incircle",
    corsOrigins: listFromEnv("CORS_ORIGINS", nodeEnv === "production" ? "" : "*"),
    requestTimeoutMs: numberFromEnv("REQUEST_TIMEOUT_MS", 8000),
    wechatAppId: process.env.WECHAT_APP_ID || "",
    wechatAppSecret: process.env.WECHAT_APP_SECRET || "",
    wechatQrEnvVersion: process.env.WECHAT_QRCODE_ENV_VERSION || "release",
    tencentMapKey: process.env.TENCENT_MAP_KEY || "",
    superAdminOpenids: listFromEnv(
      "INCIRCLE_SUPER_ADMIN_OPENIDS",
      process.env.SUPER_ADMIN_OPENIDS || ""
    ),
    jwtSecret:
      process.env.JWT_SECRET ||
      (nodeEnv === "production" ? "" : "incircle-development-jwt-secret-change-before-production"),
    jwtTtlSeconds: numberFromEnv("JWT_TTL_SECONDS", 24 * 60 * 60),
    aiCredentialsEncryptionKey: process.env.AI_CREDENTIALS_ENCRYPTION_KEY || "",
    aiProviderTimeoutMs: numberFromEnv("AI_PROVIDER_TIMEOUT_MS", 300000),
    aiContentSecurityEnabled: booleanFromEnv("AI_CONTENT_SECURITY_ENABLED", nodeEnv === "production"),
    searxngEnabled: booleanFromEnv("SEARXNG_ENABLED", false),
    searxngBaseUrl: String(process.env.SEARXNG_BASE_URL || "https://search.incircle.asia").replace(/\/+$/, ""),
    searxngTimeoutMs: numberFromEnv("SEARXNG_TIMEOUT_MS", 8000),
    searxngMaxRounds: numberFromEnv("SEARXNG_MAX_ROUNDS", 2),
    searxngMaxQueriesPerRound: numberFromEnv("SEARXNG_MAX_QUERIES_PER_ROUND", 3),
    searxngMaxResultsPerQuery: numberFromEnv("SEARXNG_MAX_RESULTS_PER_QUERY", 8),
    searxngLanguage: String(process.env.SEARXNG_LANGUAGE || "zh-CN").trim(),
    searxngSafesearch: numberFromEnv("SEARXNG_SAFESEARCH", 1),
    legalOperatorType: String(process.env.LEGAL_OPERATOR_TYPE || "individual").trim().toLowerCase(),
    legalOperatorName: String(process.env.LEGAL_OPERATOR_NAME || "").trim(),
    legalContactEmail: String(process.env.LEGAL_CONTACT_EMAIL || "").trim(),
    legalTermsVersion: String(process.env.LEGAL_TERMS_VERSION || "").trim(),
    legalPrivacyVersion: String(process.env.LEGAL_PRIVACY_VERSION || "").trim(),
    legalEffectiveDate: String(process.env.LEGAL_EFFECTIVE_DATE || "").trim(),
    uploadDir,
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, ""),
  };
  validateConfig(config);
  return config;
}

function validateConfig(config) {
  const legalOperatorType = String(config.legalOperatorType || "individual").trim().toLowerCase();
  if (!["individual", "enterprise"].includes(legalOperatorType)) {
    throw new Error("LEGAL_OPERATOR_TYPE must be individual or enterprise.");
  }
  if (config.nodeEnv !== "production") return;
  if (!config.databaseUrl || /change-this-password/i.test(config.databaseUrl)) {
    throw new Error("Production DATABASE_URL must use a non-default password.");
  }
  if (!config.jwtSecret || config.jwtSecret.length < 32 || /replace-with-a-long-random-secret/i.test(config.jwtSecret)) {
    throw new Error("Production JWT_SECRET must be a random value of at least 32 characters.");
  }
  if (!config.wechatAppId || !config.wechatAppSecret) {
    throw new Error("Production WECHAT_APP_ID and WECHAT_APP_SECRET are required.");
  }
  if (!/^https:\/\//i.test(config.publicBaseUrl)) {
    throw new Error("Production PUBLIC_BASE_URL must be an HTTPS URL.");
  }
  if (!validEncryptionKey(config.aiCredentialsEncryptionKey)) {
    throw new Error("Production AI_CREDENTIALS_ENCRYPTION_KEY must be 32 random bytes (64 hex characters or base64)." );
  }
  if (!config.aiContentSecurityEnabled) {
    throw new Error("Production AI_CONTENT_SECURITY_ENABLED must remain enabled.");
  }
}

module.exports = {
  loadConfig,
  validateConfig,
  validEncryptionKey,
};
