const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const sharp = require("sharp");

const { bearerToken, verifyAccessToken } = require("../auth");
const { AppError } = require("../errors");
const { exchangeWechatLoginCode } = require("../services/wechat");

const AVATAR_EXTENSIONS = ["jpg", "png", "webp", "gif"];
const AVATAR_OUTPUT_MAX_BYTES = 700 * 1024;
const UPLOAD_WINDOW_MS = 60 * 1000;
const UPLOAD_LIMIT_PER_WINDOW = 20;
const uploadWindows = new Map();

function sanitizePart(value, fallback) {
  return String(value || fallback || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || fallback || "";
}

function publicUrl(config, relativePath, request) {
  const normalized = `/${relativePath.replace(/\\/g, "/").replace(/^\/+/, "")}`;
  if (config.publicBaseUrl) return `${config.publicBaseUrl}${normalized}`;
  const headers = (request && request.headers) || {};
  const protocol = headers["x-forwarded-proto"] || (request && request.protocol) || "http";
  const host = headers["x-forwarded-host"] || headers.host || `127.0.0.1:${config.port}`;
  return `${protocol}://${host}${normalized}`;
}

function fieldValue(fields, name) {
  const field = fields && fields[name];
  if (!field) return "";
  return String(typeof field.value === "undefined" ? field : field.value || "");
}

function imageExtension(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "png";
  }
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return "gif";
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }
  return "";
}

function removeAvatarVariants(targetDir, avatarKey) {
  AVATAR_EXTENSIONS.forEach((extension) => {
    const target = path.join(targetDir, `${avatarKey}.${extension}`);
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
  });
}

function uploadFolder(value) {
  const raw = sanitizePart(value, "media");
  if (raw.startsWith("activities")) return "activities";
  if (raw.startsWith("checkins")) return "checkins";
  if (raw.startsWith("docs")) return "docs";
  return "media";
}

function enforceUploadRate(identity) {
  const key = String(identity.openid || identity.userId || "unknown");
  const now = Date.now();
  const current = uploadWindows.get(key);
  if (!current || current.expiresAt <= now) {
    uploadWindows.set(key, { count: 1, expiresAt: now + UPLOAD_WINDOW_MS });
    return;
  }
  current.count += 1;
  if (current.count > UPLOAD_LIMIT_PER_WINDOW) {
    throw new AppError("上传过于频繁，请稍后再试", { statusCode: 429, errCode: "UPLOAD_RATE_LIMITED" });
  }
}

async function authenticateUpload(fastify, request, fields, isAvatar) {
  const token = bearerToken(request);
  const code = fieldValue(fields, "wechatLoginCode");
  let identity;
  if (token) identity = verifyAccessToken(fastify.config, token);
  else if (code) identity = await exchangeWechatLoginCode(fastify.config, code);
  else throw new AppError("请先登录后再上传图片", { statusCode: 401, errCode: "AUTH_REQUIRED" });

  const userResult = await fastify.db.query("SELECT * FROM incircle_users WHERE openid = $1 LIMIT 1", [identity.openid]);
  const user = userResult.rows[0] || null;
  if (identity.userId && (!user || String(user.id) !== String(identity.userId))) {
    throw new AppError("登录凭证与账号不匹配，请重新登录", { statusCode: 401, errCode: "TOKEN_SUBJECT_MISMATCH" });
  }
  if (user && user.status === "blocked") {
    throw new AppError(user.blocked_reason || "账号已被封禁，请联系平台处理", {
      statusCode: 403,
      errCode: "ACCOUNT_BLOCKED",
    });
  }
  if (user && user.status === "deleted") {
    throw new AppError("账号已经注销，不能继续上传", { statusCode: 410, errCode: "ACCOUNT_DELETED" });
  }
  if (token && identity.authVersion && Number(identity.authVersion) !== Number((user && user.auth_version) || 1)) {
    throw new AppError("登录状态已失效，请重新登录", { statusCode: 401, errCode: "TOKEN_REVOKED" });
  }
  if (token && (!user || user.status !== "active" || !user.logged_in)) {
    throw new AppError("请先登录后再上传图片", { statusCode: 401, errCode: "LOGIN_REQUIRED" });
  }
  const hasBoundAccount = !!(user && user.account_key && (user.password_hash || user.password_digest));
  if (!token && (!isAvatar || hasBoundAccount)) {
    throw new AppError("请先登录后再上传图片", { statusCode: 401, errCode: "AUTH_REQUIRED" });
  }

  const circleId = fieldValue(fields, "circleId");
  if (circleId) {
    if (!user) throw new AppError("请先完成账号注册", { statusCode: 401, errCode: "ACCOUNT_REQUIRED" });
    if (user.status !== "active" || !user.logged_in) {
      throw new AppError("请先登录后再上传图片", { statusCode: 401, errCode: "LOGIN_REQUIRED" });
    }
    const membership = await fastify.db.query(
      "SELECT id FROM incircle_circle_members WHERE circle_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1",
      [circleId, user.id]
    );
    if (!membership.rows.length) {
      throw new AppError("你不是这个圈子的成员", { statusCode: 403, errCode: "NOT_IN_CIRCLE" });
    }
  } else if (!isAvatar) {
    throw new AppError("缺少圈子信息，无法上传业务图片", { statusCode: 400, errCode: "CIRCLE_REQUIRED" });
  }

  enforceUploadRate(identity);
  return { identity, user, circleId };
}

function avatarKeyFor(uploadAuth) {
  if (uploadAuth.circleId && uploadAuth.user) return `${uploadAuth.circleId}-${uploadAuth.user.id}`;
  return `profile-${crypto.createHash("sha256").update(uploadAuth.identity.openid).digest("hex").slice(0, 32)}`;
}

async function processAvatar(sourcePath, targetPath) {
  await sharp(sourcePath)
    .rotate()
    .resize(512, 512, { fit: "cover", position: "centre", withoutEnlargement: true })
    .webp({ quality: 78, effort: 4 })
    .toFile(targetPath);
  let size = fs.statSync(targetPath).size;
  if (size > AVATAR_OUTPUT_MAX_BYTES) {
    const retryPath = `${targetPath}.retry`;
    await sharp(sourcePath)
      .rotate()
      .resize(512, 512, { fit: "cover", position: "centre", withoutEnlargement: true })
      .webp({ quality: 60, effort: 5 })
      .toFile(retryPath);
    fs.rmSync(targetPath, { force: true });
    fs.renameSync(retryPath, targetPath);
    size = fs.statSync(targetPath).size;
  }
  return size;
}

async function mediaRoutes(fastify) {
  fastify.post("/upload", async (request) => {
    const file = await request.file();
    if (!file) throw new AppError("请选择要上传的图片", { statusCode: 400, errCode: "FILE_REQUIRED" });

    const isAvatar = fieldValue(file.fields, "folder") === "avatars" || fieldValue(file.fields, "kind") === "avatar";
    const uploadAuth = await authenticateUpload(fastify, request, file.fields, isAvatar);
    const folder = isAvatar ? "avatars" : uploadFolder(fieldValue(file.fields, "folder"));
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const relativeDir = isAvatar ? path.join("uploads", "avatars") : path.join("uploads", folder, today);
    const targetDir = isAvatar
      ? path.join(fastify.config.uploadDir, "avatars")
      : path.join(fastify.config.uploadDir, folder, today);
    fs.mkdirSync(targetDir, { recursive: true });

    const tempPath = path.join(targetDir, `.${Date.now()}-${crypto.randomBytes(6).toString("hex")}.tmp`);
    let absolutePath = "";
    try {
      await pipeline(file.file, fs.createWriteStream(tempPath, { flags: "wx" }));
      const header = Buffer.alloc(16);
      const descriptor = fs.openSync(tempPath, "r");
      const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
      fs.closeSync(descriptor);
      const detectedExtension = imageExtension(header.subarray(0, bytesRead));
      if (!detectedExtension) {
        throw new AppError("上传内容不是有效图片", { statusCode: 400, errCode: "INVALID_IMAGE_CONTENT" });
      }

      let filename;
      let size;
      if (isAvatar) {
        const avatarKey = avatarKeyFor(uploadAuth);
        filename = `${avatarKey}.webp`;
        absolutePath = path.join(targetDir, filename);
        const processedPath = `${absolutePath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
        size = await processAvatar(tempPath, processedPath);
        removeAvatarVariants(targetDir, avatarKey);
        fs.renameSync(processedPath, absolutePath);
      } else {
        filename = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${detectedExtension}`;
        absolutePath = path.join(targetDir, filename);
        fs.renameSync(tempPath, absolutePath);
        size = fs.statSync(absolutePath).size;
      }

      const relativePath = path.join(relativeDir, filename);
      const baseUrl = publicUrl(fastify.config, relativePath, request);
      const url = isAvatar ? `${baseUrl}?v=${Date.now()}` : baseUrl;
      return {
        url,
        src: url,
        fileId: "",
        path: relativePath.replace(/\\/g, "/"),
        source: "http",
        size,
      };
    } finally {
      if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
    }
  });
}

module.exports = {
  mediaRoutes,
  publicUrl,
};
