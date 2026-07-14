const crypto = require("crypto");

const { AppError } = require("../../errors");

function encryptionKey(config) {
  const value = String((config && config.aiCredentialsEncryptionKey) || "").trim();
  let key;
  if (/^[a-f0-9]{64}$/i.test(value)) key = Buffer.from(value, "hex");
  else {
    try {
      key = Buffer.from(value, "base64");
    } catch (error) {
      key = null;
    }
  }
  if (!key || key.length !== 32) {
    throw new AppError("AI 凭据加密密钥未正确配置", {
      statusCode: 503,
      errCode: "AI_ENCRYPTION_KEY_REQUIRED",
    });
  }
  return key;
}

function encryptCredential(config, secret) {
  const value = String(secret || "").trim();
  if (!value) throw new AppError("请填写 API Key", { statusCode: 400, errCode: "AI_API_KEY_REQUIRED" });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(config), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decryptCredential(config, payload) {
  const parts = String(payload || "").split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new AppError("AI 凭据已损坏，请重新填写 API Key", {
      statusCode: 503,
      errCode: "AI_CREDENTIAL_INVALID",
    });
  }
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      encryptionKey(config),
      Buffer.from(parts[1], "base64url")
    );
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8");
  } catch (error) {
    throw new AppError("AI 凭据无法解密，请重新填写 API Key", {
      statusCode: 503,
      errCode: "AI_CREDENTIAL_DECRYPT_FAILED",
    });
  }
}

function credentialLastFour(secret) {
  const value = String(secret || "").trim();
  return value.slice(-4);
}

function maskedCredential(lastFour) {
  return lastFour ? `••••••••${String(lastFour).slice(-4)}` : "未配置";
}

module.exports = {
  credentialLastFour,
  decryptCredential,
  encryptCredential,
  maskedCredential,
};
