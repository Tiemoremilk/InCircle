const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { AppError } = require("../errors");
const { bearerToken, issueAccessToken, verifyAccessToken } = require("../auth");
const {
  clearAccountSessionLocations,
  deleteAccountSession,
  establishAccountSession,
  readAccountSessionCollection,
  requireActiveAccountSession,
  revokeAccountSession,
  revokeAllAccountSessions,
  rotateCurrentAccountSession,
  sessionMatchesBoundWechat,
  updateCurrentAccountSessionLocation,
} = require("../account-sessions");
const { resolveLoginLocation } = require("../location");
const { publicUrl } = require("../routes/media");
const {
  MEMBER_ROLES,
  canManageCircleRole,
  isOwnerRole,
  normalizeMemberRole,
} = require("../member-role");
const { reserveCircleMemberNumber } = require("../member-number");
const { agreementStatus, requireAgreementAcceptance } = require("../legal");
const { readAgreementAcceptanceState, recordAgreementAcceptance } = require("../agreement-store");
const { readPublicLegalProfile } = require("../legal-profile");
const { DEFAULT_CUSTOM_THEME_RGBA, DEFAULT_THEME_KEY, normalizeCustomThemeRgba, normalizeThemeKey } = require("../theme");
const { beijingDateKey, beijingParts, dateFromBeijingParts, formatBeijingDateTime, parseBeijingDateTime } = require("../time");
const { ensureDefaultSystemDocsForCircle, funBadgeRules } = require("../system-docs");
const { createMiniProgramCode, exchangeWechatLoginCode } = require("./wechat");

const PASSWORD_ITERATIONS = 310000;
const PASSWORD_KEY_LENGTH = 32;
const PASSWORD_DIGEST = "sha256";
const JOIN_CODE_ALPHABET = Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#￥%&");
const JOIN_CODE_LENGTH = 8;
const JOIN_CODE_PATTERN = /^[A-Za-z0-9@#￥%&]{8}$/;
const INVITE_TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const MAX_OWNED_CIRCLES_PER_USER = 10;
const ACCOUNT_SETTINGS_SESSION_LIMIT = 3;
const FRIENDLY_TAG_THRESHOLD = 2;
const FRIENDLY_TAG_SCORE = 1;
const FRIENDLY_TAG_PROMOTION_SCORE = 2;
const FRIENDLY_TAG_PRESETS = ["好约", "靠谱", "会组织", "气氛担当", "守时", "会照顾人", "资料达人", "AA清爽"];
const DEFAULT_SCORE_RULES = [
  { key: "create_activity", title: "发起约局", score: 5 },
  { key: "activity_response", title: "首次表态活动", score: 2 },
  { key: "create_vote", title: "发起投票", score: 3 },
  { key: "vote_ballot", title: "参与投票", score: 1 },
  { key: "create_checkin", title: "发起打卡挑战", score: 3 },
  { key: "daily_checkin", title: "完成每日打卡", score: 2 },
  { key: "create_bill", title: "发起 AA", score: 3 },
  { key: "settle_bill", title: "完成结算", score: 2 },
  { key: "create_doc", title: "沉淀圈内资料", score: 3 },
  { key: "profile_complete", title: "完善身份卡", score: 5 },
  { key: "friendly_impression", title: "收到友好印象", score: 1 },
  { key: "friendly_promotion", title: "友好标签上墙", score: 2 },
];
const AUTH_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const AUTH_ATTEMPT_LIMIT = 8;
const authAttemptWindows = new Map();

function nowIso() {
  return new Date().toISOString();
}

function shiftDateKey(dateKey, days) {
  const matched = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matched) return "";
  const date = new Date(Date.UTC(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3])));
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function beijingWeekKey(value) {
  const dateKey = beijingDateKey(value);
  const matched = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matched) return "";
  const date = new Date(Date.UTC(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3])));
  const day = date.getUTCDay() || 7;
  return shiftDateKey(dateKey, 1 - day);
}

function normalizeAccountName(value) {
  return String(value || "").trim();
}

function accountKeyOf(value) {
  return normalizeAccountName(value).toLowerCase().replace(/\s/g, "");
}

function validateAccountName(value) {
  const accountKey = accountKeyOf(value);
  if (accountKey.length < 4 || accountKey.length > 32) return "账号需要 4-32 位";
  if (!/^[a-z0-9_.@-]+$/.test(accountKey)) return "账号只支持手机号、邮箱或英文数字组合";
  return "";
}

function validatePassword(value) {
  const password = String(value || "");
  if (password.length < 8 || password.length > 64) return "密码需要 8-64 位";
  if (/\s/.test(password)) return "密码不能包含空格";
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "密码至少包含一个字母和一个数字";
  return "";
}

function normalizePhone(value) {
  return String(value || "").replace(/[^\d]/g, "").slice(0, 11);
}

function validateRegistrationProfile(profile) {
  const nickName = String((profile && profile.nickName) || "").trim();
  const phone = normalizePhone(profile && profile.phone);
  if (!nickName || nickName.length < 2) return "请填写至少 2 个字的昵称";
  if (!/^1\d{10}$/.test(phone)) return "请填写 11 位手机号";
  return "";
}

function safeAvatarUrl(value, fallback) {
  const src = String(value || "").trim();
  if (!src || src.indexOf("wxfile://") === 0 || src.indexOf("cloud://") === 0) return fallback || "/images/avatar.png";
  return src;
}

function derivePassword(password, salt, iterations, digest) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(String(password), salt, iterations, PASSWORD_KEY_LENGTH, digest, (error, key) => {
      if (error) reject(error);
      else resolve(key.toString("hex"));
    });
  });
}

async function createPasswordCredentials(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await derivePassword(password, salt, PASSWORD_ITERATIONS, PASSWORD_DIGEST);
  return {
    passwordHash: hash,
    passwordSalt: salt,
    passwordIterations: PASSWORD_ITERATIONS,
    passwordDigest: PASSWORD_DIGEST,
  };
}

async function verifyPassword(user, password) {
  if (!user || !user.password_hash || !user.password_salt) return false;
  const iterations = user.password_iterations || PASSWORD_ITERATIONS;
  const digest = user.password_digest || PASSWORD_DIGEST;
  const actual = await derivePassword(password, user.password_salt, iterations, digest);
  try {
    return crypto.timingSafeEqual(Buffer.from(user.password_hash, "hex"), Buffer.from(actual, "hex"));
  } catch (error) {
    return false;
  }
}

function hasPasswordAccount(user) {
  return !!(user && user.account_key && user.password_hash && user.password_salt);
}

function roleClass(role) {
  const normalizedRole = normalizeMemberRole(role);
  if (normalizedRole === MEMBER_ROLES.OWNER) return "pill-green";
  return "pill-blue";
}

function statusText(status) {
  if (status === "frozen") return "冻结";
  if (status === "closed") return "停用";
  return "正常";
}

function statusClass(status) {
  if (status === "frozen" || status === "closed") return "pill-red";
  return "pill-green";
}

function circleStatusAction(status) {
  const currentStatus = status || "active";
  if (currentStatus === "active") {
    return {
      actionText: "冻结圈子",
      nextStatus: "frozen",
      actionType: "freeze",
    };
  }
  return {
    actionText: "解冻圈子",
    nextStatus: "active",
    actionType: "unfreeze",
  };
}

function canManageRole(role) {
  return canManageCircleRole(role);
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    openid: row.openid,
    accountName: row.account_name || "",
    nickName: row.nickname || "微信用户",
    wechatNickName: row.wechat_nickname || "",
    phone: row.phone || "",
    title: row.title || "",
    profileNote: row.profile_note || "",
    profileCompleted: !!row.profile_completed,
    themeKey: normalizeThemeKey(row.theme_key, DEFAULT_THEME_KEY),
    customTheme: normalizeCustomThemeRgba(row.custom_theme_rgba, DEFAULT_CUSTOM_THEME_RGBA),
    avatarUrl: safeAvatarUrl(row.avatar_url, "/images/avatar.png"),
    currentCircleId: row.current_circle_id || "",
    loggedIn: !!row.logged_in,
    isSuperAdmin: !!row.is_super_admin,
    preciseLoginLocationEnabled: row.precise_login_location_enabled === true,
  };
}

async function lockLoginLocationPreference(db, userId) {
  const result = await db.query(
    `
    SELECT precise_login_location_enabled
    FROM incircle_users
    WHERE id = $1
    FOR UPDATE
    `,
    [userId]
  );
  if (!result.rows[0]) {
    throw new AppError("账号不存在或已删除", {
      statusCode: 404,
      errCode: "USER_NOT_FOUND",
    });
  }
  return result.rows[0].precise_login_location_enabled === true;
}

async function accountSessionSummary(db, userId, currentSessionId) {
  const collection = await readAccountSessionCollection(db, userId, currentSessionId, {
    limit: ACCOUNT_SETTINGS_SESSION_LIMIT,
  });
  return {
    sessions: collection.sessions,
    sessionCount: collection.total,
    activeSessionCount: collection.activeSessionCount,
    hasMoreSessions: collection.hasMore,
  };
}

function circleStats(circle) {
  return [
    { label: "成员", value: String(circle.member_count || 0) },
    { label: "本月约局", value: String(circle.monthly_activity_count || 0) },
    { label: "待结清", value: String(circle.unsettled_count || 0) },
  ];
}

function publicCircle(row, membership, currentCircleId, options) {
  if (!row) return null;
  const source = options || {};
  const id = row.id;
  const role = membership ? normalizeMemberRole(membership.role) : "未加入";
  const isCurrent = currentCircleId === id;
  const status = row.status || "active";
  const statusAction = circleStatusAction(status);
  return {
    id,
    memberCardId: id,
    name: row.name || "新的熟人圈",
    slogan: row.slogan || "",
    notice: row.notice || "",
    joinCode: row.join_code || "",
    status,
    ownerName: row.raw_data && row.raw_data.ownerName ? row.raw_data.ownerName : "",
    memberCount: row.member_count || 0,
    monthlyActivityCount: row.monthly_activity_count || 0,
    unsettledCount: row.unsettled_count || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stats: circleStats(row),
    role,
    roleClass: roleClass(role),
    statusText: statusText(status),
    displayStatusText: isCurrent ? "当前" : statusText(status),
    statusClass: statusClass(status),
    actionText: statusAction.actionText,
    nextStatus: statusAction.nextStatus,
    actionType: statusAction.actionType,
    isCurrent,
    currentText: isCurrent ? "当前" : "",
    currentClass: isCurrent ? "active" : "",
    disabledClass: status === "active" ? "" : "disabled",
    canEnter: !!membership && status === "active",
    canManage: source.isSuperAdmin === true || canManageRole(role),
    memberText: `${row.member_count || 0} 人`,
    activityText: `本月 ${row.monthly_activity_count || 0} 局`,
    debtText: `${row.unsettled_count || 0} 笔待结清`,
    lastEnteredAt: membership ? membership.last_entered_at || membership.joined_at || "" : "",
  };
}

function publicMembership(row) {
  if (!row) return null;
  return {
    id: row.id,
    circleId: row.circle_id,
    userId: row.user_id,
    memberName: row.member_name,
    memberId: row.member_id_text,
    role: normalizeMemberRole(row.role),
    status: row.status,
    joinedAt: row.joined_at,
    lastEnteredAt: row.last_entered_at || row.joined_at,
  };
}

function publicMember(row) {
  if (!row) return null;
  const role = normalizeMemberRole(row.role);
  return {
    id: row.id,
    name: row.member_name || row.nickname || "微信用户",
    role,
    roleClass: roleClass(role),
    avatar: safeAvatarUrl(row.avatar_url, "/images/avatar.png"),
    title: row.card_title || row.title || "",
    profileNote: row.card_profile_note || row.profile_note || "",
    memberId: row.member_id_text || "",
    status: row.status || "active",
    statusText: row.status === "active" ? "正常" : "已退出",
    joinedAt: row.joined_at,
    isOwner: isOwnerRole(role),
  };
}

function maskAccount(value) {
  const text = String(value || "").trim();
  if (!text) return "未设置";
  if (text.length <= 4) return `${text.slice(0, 1)}***`;
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}

function maskPhone(value) {
  const text = String(value || "").trim();
  if (!text) return "未填写";
  if (/^\d{11}$/.test(text)) return `${text.slice(0, 3)}****${text.slice(-4)}`;
  if (text.length <= 5) return `${text.slice(0, 1)}***`;
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}

function adminUserStatusText(status) {
  if (status === "blocked") return "已封禁";
  if (status === "deleted") return "已注销";
  return "正常";
}

function publicAdminUser(row, options) {
  if (!row) return null;
  const detailed = !!(options && options.detailed);
  const status = row.status || "active";
  const result = {
    id: String(row.id),
    nickName: row.nickname || (status === "deleted" ? "已注销用户" : "微信用户"),
    avatar: safeAvatarUrl(row.avatar_url, "/images/avatar.png"),
    accountMasked: maskAccount(row.account_name),
    phoneMasked: maskPhone(row.phone),
    wechatBound: !!row.wechat_bound && !!row.openid,
    status,
    statusText: adminUserStatusText(status),
    circleCount: Number(row.circle_count || 0),
    ownedCircleCount: Number(row.owned_circle_count || 0),
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    blockedAt: row.blocked_at,
    blockedReason: row.blocked_reason || "",
    wechatUnboundAt: row.wechat_unbound_at,
    protected: !!row.is_super_admin,
  };
  if (detailed) {
    result.accountName = row.account_name || "";
    result.phone = row.phone || "";
    result.title = row.title || "";
    result.profileNote = row.profile_note || "";
    result.wechatNickName = row.wechat_nickname || "";
  }
  return result;
}

function createJoinCode() {
  let code = "";
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
    code += JOIN_CODE_ALPHABET[crypto.randomInt(0, JOIN_CODE_ALPHABET.length)];
  }
  return code;
}

function normalizeJoinCode(value) {
  return String(value || "").trim();
}

function isValidJoinCode(value) {
  return JOIN_CODE_PATTERN.test(normalizeJoinCode(value));
}

function createInviteToken() {
  return crypto.randomBytes(16).toString("hex");
}

function normalizeInviteToken(value) {
  return String(value || "").trim();
}

function isValidInviteToken(value) {
  return INVITE_TOKEN_PATTERN.test(normalizeInviteToken(value));
}

function invitePagePath(inviteToken, pageValue) {
  const page = `/${String(pageValue || "pages/circle-join/index").replace(/^\/+/, "")}`;
  if (isValidInviteToken(inviteToken)) return `${page}?token=${encodeURIComponent(inviteToken)}`;
  return page;
}

function safeFilePart(value, fallback) {
  return String(value || fallback || "file")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || fallback || "file";
}

function normalizeQrEnvVersion(value) {
  const envVersion = String(value || "release").trim();
  return ["develop", "trial", "release"].includes(envVersion) ? envVersion : "release";
}

function managedUploadRelativePath(value) {
  const normalized = String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!normalized || normalized.split("/").includes("..")) return "";
  return normalized;
}

function qrCodeAbsolutePath(config, relativePath) {
  const normalized = managedUploadRelativePath(relativePath);
  if (!/^qrcodes\/[a-zA-Z0-9_-]+\.(?:png|jpg)$/.test(normalized)) return "";
  const uploadRoot = path.resolve(config.uploadDir);
  const absolutePath = path.resolve(uploadRoot, ...normalized.split("/"));
  if (!absolutePath.startsWith(`${uploadRoot}${path.sep}`)) return "";
  return absolutePath;
}

function qrImageExtension(buffer) {
  if (!Buffer.isBuffer(buffer)) return "";
  if (
    buffer.length >= 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a
  ) return "png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  return "";
}

function usableQrCodeFile(config, relativePath) {
  const absolutePath = qrCodeAbsolutePath(config, relativePath);
  if (!absolutePath) return false;
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile() || stat.size < 100) return false;
    const handle = fs.openSync(absolutePath, "r");
    const header = Buffer.alloc(8);
    try {
      fs.readSync(handle, header, 0, header.length, 0);
    } finally {
      fs.closeSync(handle);
    }
    return absolutePath.endsWith(`.${qrImageExtension(header)}`);
  } catch (error) {
    return false;
  }
}

function writeQrCodeFile(config, relativePath, buffer) {
  const absolutePath = qrCodeAbsolutePath(config, relativePath);
  if (!absolutePath) throw new AppError("二维码存储路径无效", { statusCode: 500, errCode: "QRCODE_PATH_INVALID" });
  if (!Buffer.isBuffer(buffer) || buffer.length < 100 || !absolutePath.endsWith(`.${qrImageExtension(buffer)}`)) {
    throw new AppError("微信返回的二维码图片无效", { statusCode: 502, errCode: "WECHAT_MINI_CODE_INVALID" });
  }
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, buffer, { flag: "wx" });
    try {
      fs.renameSync(temporaryPath, absolutePath);
    } catch (error) {
      if (!["EEXIST", "EPERM"].includes(error.code)) throw error;
      fs.rmSync(absolutePath, { force: true });
      fs.renameSync(temporaryPath, absolutePath);
    }
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  }
}

function cleanupOtherCircleQrFiles(config, circleId, keepRelativePath) {
  const folder = path.join(config.uploadDir, "qrcodes");
  const prefix = `${safeFilePart(circleId, "circle")}-`;
  const keepPath = qrCodeAbsolutePath(config, keepRelativePath);
  const failed = [];
  try {
    if (!fs.existsSync(folder)) return { failed };
    fs.readdirSync(folder).forEach((filename) => {
      if (!filename.startsWith(prefix)) return;
      const absolutePath = path.resolve(folder, filename);
      if (keepPath && absolutePath === keepPath) return;
      try {
        if (fs.statSync(absolutePath).isFile()) fs.rmSync(absolutePath, { force: true });
      } catch (error) {
        failed.push({ path: absolutePath, error: error.message });
      }
    });
  } catch (error) {
    failed.push({ path: folder, error: error.message });
  }
  return { failed };
}

function publicInviteQrCode(config, request, circle, row, reused) {
  const relativePath = managedUploadRelativePath(row.relative_path);
  const imageUrl = publicUrl(config, path.posix.join("uploads", relativePath), request);
  const page = row.page || "pages/circle-join/index";
  const joinCode = row.join_code || circle.join_code || "";
  const inviteToken = row.invite_token || circle.invite_token || "";
  return {
    joinCode,
    page,
    path: invitePagePath(inviteToken, page),
    fileID: "",
    imageUrl,
    url: imageUrl,
    scene: inviteToken,
    envVersion: row.env_version || "release",
    kind: "wechat-miniprogram-code",
    reused: !!reused,
    createdAt: row.created_at,
  };
}

function uploadPathFromUrl(config, value) {
  const raw = String(value || "").split("?")[0];
  if (!raw || raw === "/images/avatar.png") return "";
  let pathname = "";
  if (raw.indexOf("/uploads/") === 0) {
    pathname = raw;
  } else {
    try {
      pathname = new URL(raw).pathname;
    } catch (error) {
      return "";
    }
  }
  if (pathname.indexOf("/uploads/") !== 0) return "";
  const relative = pathname.replace(/^\/uploads\/+/, "");
  const root = path.resolve(config.uploadDir);
  const absolutePath = path.resolve(root, relative);
  return absolutePath.indexOf(root) === 0 ? absolutePath : "";
}

function removeUploadUrl(config, value, nextValue) {
  const oldPath = uploadPathFromUrl(config, value);
  if (!oldPath) return;
  const nextPath = uploadPathFromUrl(config, nextValue);
  if (nextPath && nextPath === oldPath) return;
  try {
    if (fs.existsSync(oldPath)) fs.rmSync(oldPath, { force: true });
  } catch (error) {
    // Best-effort cleanup only; never fail profile saving because of an old file.
  }
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function nameOfPerson(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  return String(value.memberName || value.name || value.nickname || value.from || value.to || value.label || "").trim();
}

function uniqueNames(values) {
  const seen = new Set();
  return normalizeArray(values).reduce((list, value) => {
    const name = nameOfPerson(value);
    if (!name || seen.has(name)) return list;
    seen.add(name);
    list.push(name);
    return list;
  }, []);
}

function memberNameSet(members) {
  return new Set(
    normalizeArray(members)
      .map((member) => nameOfPerson(member))
      .filter(Boolean)
  );
}

function scoreLeaderboard(members, limit) {
  const items = normalizeArray(members);
  const scoreOf = (member) => {
    const score = Number(member && member.score ? member.score : 0);
    return Number.isFinite(score) ? score : 0;
  };
  const scores = items.map(scoreOf);
  const hasComparableData = items.length > 1 && Math.max(...scores, 0) > 0 && new Set(scores).size > 1;
  if (!hasComparableData) return [];
  const ranked = items
    .slice()
    .sort((left, right) => scoreOf(right) - scoreOf(left))
    .slice(0, Math.max(1, Number(limit || 3)));
  let previousScore = null;
  let previousRank = 0;
  return ranked.map((member, index) => {
    const score = scoreOf(member);
    const rank = index > 0 && score === previousScore ? previousRank : index + 1;
    previousScore = score;
    previousRank = rank;
    return Object.assign({}, member, { score, rank });
  });
}

function toMoney(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100) / 100;
}

function amountFromText(value) {
  if (typeof value === "number") return toMoney(value);
  const matched = String(value || "").replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  return matched ? toMoney(matched[1]) : 0;
}

function parseActivityFee(activity, participantCount) {
  const raw = String((activity && (activity.fee || activity.amount)) || "");
  const amount = amountFromText(activity && (activity.amount || activity.fee));
  const isPerPerson = /\/\s*人|每人|人均|每位|每个/.test(raw);
  const count = Math.max(1, Number(participantCount || 0));
  return {
    amount: isPerPerson ? toMoney(amount * count) : amount,
    perPerson: isPerPerson ? amount : count ? toMoney(amount / count) : 0,
  };
}

function sanitizeTimelineText(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/今日已完成/g, "已完成")
    .replace(/今日已更新/g, "已更新")
    .replace(/今天已更新/g, "已更新")
    .replace(/提交今日打卡记录/g, "提交打卡记录")
    .replace(/今日打卡/g, "打卡")
    .replace(/今日记录/g, "打卡记录")
    .replace(/今日未打卡/g, "未打卡")
    .replace(/等待今日记录/g, "等待记录")
    .replace(/今天还没人抢第一/g, "还没人抢第一")
    .replace(/今天全员很稳/g, "全员很稳")
    .replace(/今天全员在线/g, "全员在线")
    .replace(/今天全员完成/g, "全员完成")
    .replace(/今日可约/g, "近期可约")
    .replace(/今日/g, "本次")
    .replace(/今天/g, "当前")
    .replace(/刚刚/g, "已记录");
}

function sanitizeTimelineValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeTimelineValue);
  if (!value || typeof value !== "object") return sanitizeTimelineText(value);
  return Object.keys(value).reduce((next, key) => {
    next[key] = sanitizeTimelineValue(value[key]);
    return next;
  }, {});
}

function sanitizeTimelineArray(value) {
  return normalizeArray(sanitizeTimelineValue(value));
}

function sanitizeCheckinPayload(checkin) {
  if (!checkin) return checkin;
  return Object.assign({}, checkin, {
    records: normalizeArray(checkin.records).map((record) =>
      Object.assign({}, record, {
        value: sanitizeTimelineText(record.value),
        note: sanitizeTimelineText(record.note),
      })
    ),
    rankings: sanitizeTimelineValue(checkin.rankings || {}),
    weeklySummary: sanitizeTimelineText(checkin.weeklySummary),
    punishmentResult: sanitizeTimelineValue(checkin.punishmentResult),
  });
}

function normalizeCheckinMedia(value, fallback) {
  const candidates = normalizeArray(value).concat(fallback && typeof fallback === "object" ? [fallback] : []);
  const seen = new Set();
  return candidates
    .map((item) => (typeof item === "string" ? { src: item } : item))
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const src = String(item.src || item.url || "").trim().slice(0, 2000);
      if (!src || (!/^https?:\/\//i.test(src) && !src.startsWith("/"))) return null;
      return {
        src,
        fileId: String(item.fileId || "").trim().slice(0, 500),
        path: String(item.path || "").trim().replace(/\\/g, "/").slice(0, 1000),
        source: String(item.source || "http").trim().slice(0, 30),
      };
    })
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item.src)) return false;
      seen.add(item.src);
      return true;
    })
    .slice(0, 9);
}

function businessId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

function publicBusinessRow(row, fallback, kind) {
  if (!row) return null;
  const result = Object.assign({}, fallback || {}, row.payload || {}, {
    id: String(row.id),
    circleId: String(row.circle_id),
    title: row.title || (row.payload && row.payload.title) || (fallback && fallback.title) || "",
    status: row.status || (row.payload && row.payload.status) || (fallback && fallback.status) || "active",
    createdAt: (row.payload && row.payload.createdAt) || row.created_at,
    updatedAt: (row.payload && row.payload.updatedAt) || row.updated_at,
  });
  return kind === "checkins" ? sanitizeCheckinPayload(result) : result;
}

function businessKindLabel(kind) {
  const map = {
    activities: "活动",
    bills: "AA",
    votes: "投票",
    checkins: "打卡挑战",
    docs: "资料",
    decisions: "决策器",
  };
  return map[kind] || "业务数据";
}

function businessTargetType(kind) {
  const map = {
    activities: "activity",
    bills: "bill",
    votes: "vote",
    checkins: "checkin",
    docs: "doc",
    decisions: "decision",
  };
  return map[kind] || "business";
}

function valueListContains(list, value) {
  const target = String(value || "").trim();
  if (!target) return false;
  return normalizeArray(list).some((item) => String(item || "").trim() === target);
}

function businessOwnerOpenids(payload) {
  if (!payload || typeof payload !== "object") return [];
  return [
    payload.creatorOpenid,
    payload.createdByOpenid,
    payload.hostOpenid,
    payload.ownerOpenid,
    payload.authorOpenid,
    payload.userOpenid,
    payload.memberOpenid,
    payload.openid,
    payload._openid,
  ].filter(Boolean);
}

function businessOwnerNames(kind, payload) {
  if (!payload || typeof payload !== "object") return [];
  const names = [payload.creatorName, payload.createdByName, payload.ownerName, payload.authorName];
  if (kind === "activities") names.push(payload.hostName);
  if (kind === "docs") names.push(payload.owner);
  return names.filter(Boolean);
}

function stripBusinessTransientFields(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value || {};
  const next = Object.assign({}, value);
  delete next.canDelete;
  delete next.deleteText;
  delete next.canEdit;
  delete next.editText;
  delete next.editDisabledReason;
  return next;
}

const BUSINESS_INPUT_FIELDS = {
  activities: [
    "title", "type", "time", "startsAt", "startsAtMs", "location", "locationName", "locationAddress",
    "latitude", "longitude", "hasMapLocation", "capacity", "fee", "tags", "highlight",
  ],
  bills: [
    "title", "amount", "payerName", "payerMemberId", "perPerson", "splitMode", "participants",
    "participantIds", "expenseItems", "debtors", "transfers", "punchline",
  ],
  votes: [
    "title", "deadline", "deadlineAt", "deadlineAtMs", "deadlineDisplay", "deadlineText", "type",
    "visibility", "choiceMode", "allowVeto", "organizerWeighted", "weightValue", "locationText",
    "locationName", "locationAddress", "latitude", "longitude", "rule", "options",
  ],
  checkins: ["title", "total", "type", "reward", "punishmentPool"],
  docs: ["title", "category", "summary", "pinned", "readTime", "body", "checklist", "related"],
  decisions: ["title", "type", "options"],
};

function pickFields(value, allowed) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return (allowed || []).reduce((next, key) => {
    if (Object.prototype.hasOwnProperty.call(source, key)) next[key] = source[key];
    return next;
  }, {});
}

function businessInput(kind, value) {
  return pickFields(stripBusinessTransientFields(value), BUSINESS_INPUT_FIELDS[kind] || []);
}

function publicScoreRule(row) {
  if (!row) return null;
  const payload = row.payload || {};
  const score = row.score || 0;
  return Object.assign({}, row.payload || {}, {
    id: String(row.id),
    circleId: row.circle_id ? String(row.circle_id) : "",
    key: row.key || "",
    title: row.title || "",
    label: payload.label || row.title || "积分规则",
    value: payload.value || `${score >= 0 ? "+" : ""}${score}`,
    score,
    enabled: !!row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function publicScoreLog(row) {
  if (!row) return null;
  return Object.assign({}, row.payload || {}, {
    id: String(row.id),
    circleId: row.circle_id ? String(row.circle_id) : "",
    memberId: row.member_card_id ? String(row.member_card_id) : "",
    delta: row.delta || 0,
    reason: sanitizeTimelineText(row.reason || ""),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function publicOperationLog(row) {
  if (!row) return null;
  return Object.assign({}, row.payload || {}, {
    id: String(row.id),
    circleId: row.circle_id ? String(row.circle_id) : "",
    action: row.action || "",
    targetType: row.target_type || "",
    targetId: row.target_id || "",
    actorName: row.actor_name || (row.payload && row.payload.actorName) || "系统",
    createdAt: row.created_at,
  });
}

function normalizeLimit(value, fallback) {
  const number = Number(value || fallback || 20);
  if (!Number.isFinite(number)) return fallback || 20;
  return Math.min(50, Math.max(1, Math.floor(number)));
}

function normalizeOffset(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.floor(number));
}

function normalizeKeyword(value) {
  return String(value || "").trim().slice(0, 80);
}

async function totalFromWindowPage(db, pageResult, offset, countSql, params) {
  if (pageResult.rows[0]) return Number(pageResult.rows[0].filtered_total || 0);
  if (!offset) return 0;
  const countResult = await db.query(countSql, params);
  return Number((countResult.rows[0] && countResult.rows[0].total) || 0);
}

function collectUploadRelativePaths(value, output) {
  const target = output || new Set();
  if (Array.isArray(value)) {
    value.forEach((item) => collectUploadRelativePaths(item, target));
    return target;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectUploadRelativePaths(item, target));
    return target;
  }
  if (typeof value !== "string") return target;
  const normalized = value.replace(/\\/g, "/");
  const match = normalized.match(/(?:^|\/)uploads\/([^?#]+)/i);
  if (!match) return target;
  const relative = match[1].replace(/^\/+/, "");
  if (relative && !relative.split("/").includes("..")) target.add(relative);
  return target;
}

function cleanupManagedUploads(config, options) {
  const uploadRoot = path.resolve(config.uploadDir);
  const relativePaths = new Set((options && options.relativePaths) || []);
  const circleIds = new Set(((options && options.circleIds) || []).map(String));
  const userId = String((options && options.userId) || "");
  const profileKey = options && options.openid
    ? `profile-${crypto.createHash("sha256").update(String(options.openid)).digest("hex").slice(0, 32)}`
    : "";
  const failed = [];

  function removeAbsolute(target) {
    try {
      const resolved = path.resolve(target);
      if (resolved !== uploadRoot && !resolved.startsWith(`${uploadRoot}${path.sep}`)) return;
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) fs.rmSync(resolved, { force: true });
    } catch (error) {
      failed.push({ path: target, error: error.message });
    }
  }

  relativePaths.forEach((relative) => removeAbsolute(path.join(uploadRoot, relative)));
  ["avatars", "qrcodes"].forEach((folder) => {
    const directory = path.join(uploadRoot, folder);
    try {
      if (!fs.existsSync(directory)) return;
      fs.readdirSync(directory).forEach((filename) => {
        const ownedByCircle = Array.from(circleIds).some((circleId) => filename.startsWith(`${circleId}-`));
        const ownedByUser = folder === "avatars" && userId && filename.includes(`-${userId}.`);
        const profileAvatar = folder === "avatars" && profileKey && filename.startsWith(`${profileKey}.`);
        if (ownedByCircle || ownedByUser || profileAvatar) removeAbsolute(path.join(directory, filename));
      });
    } catch (error) {
      failed.push({ path: directory, error: error.message });
    }
  });
  return { failed };
}

function bestEffortCleanupManagedUploads(config, options) {
  try {
    return cleanupManagedUploads(config, options);
  } catch (error) {
    return { failed: [{ path: String((config && config.uploadDir) || ""), error: error.message }] };
  }
}

function friendlyTagPresets() {
  return FRIENDLY_TAG_PRESETS.map((tag) => ({ tag, threshold: FRIENDLY_TAG_THRESHOLD }));
}

function normalizeFriendlyTag(value) {
  return sanitizeTimelineText(String(value || ""))
    .trim()
    .replace(/\s+/g, "")
    .replace(/[<>]/g, "")
    .slice(0, 12);
}

function friendlyTagWallState(tagsValue, autoTagsValue, tagValue, countValue) {
  const tag = normalizeFriendlyTag(tagValue);
  const count = Math.max(0, Number(countValue || 0));
  const tags = uniqueNames(normalizeArray(tagsValue).map(normalizeFriendlyTag).filter(Boolean));
  const autoTags = uniqueNames(normalizeArray(autoTagsValue).map(normalizeFriendlyTag).filter(Boolean));
  const wasPromoted = !!tag && autoTags.includes(tag);
  const promoted = !!tag && count >= FRIENDLY_TAG_THRESHOLD;
  const nextAutoTags = promoted ? uniqueNames([tag].concat(autoTags)) : autoTags.filter((item) => item !== tag);
  const nextTags = promoted
    ? uniqueNames([tag].concat(tags))
    : wasPromoted
      ? tags.filter((item) => item !== tag)
      : tags;
  return {
    tag,
    count,
    promoted,
    wasPromoted,
    becamePromoted: promoted && !wasPromoted,
    tags: nextTags,
    autoTags: nextAutoTags,
  };
}

function friendlyVoterFromCtx(ctx) {
  const member = (ctx && ctx.memberCard) || {};
  const user = ctx && ctx.auth && ctx.auth.user ? ctx.auth.user : {};
  const now = nowIso();
  return {
    memberId: String(member.id || ""),
    userId: String(user.id || ""),
    name: member.name || user.nickname || "圈友",
    avatar: safeAvatarUrl(member.avatar || user.avatar_url, "/images/avatar.png"),
    createdAt: now,
    createdAtMs: Date.now(),
  };
}

function normalizeFriendlyVoter(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const name = value.trim();
    return name ? { memberId: "", userId: "", name, avatar: "/images/avatar.png", createdAt: "", createdAtMs: 0 } : null;
  }
  if (typeof value !== "object") return null;
  const name = String(value.name || value.memberName || value.nickname || "圈友").trim();
  return {
    memberId: String(value.memberId || value.member_card_id || ""),
    userId: String(value.userId || value.user_id || ""),
    name: name || "圈友",
    avatar: safeAvatarUrl(value.avatar || value.avatarUrl, "/images/avatar.png"),
    createdAt: value.createdAt || "",
    createdAtMs: Number(value.createdAtMs || 0),
  };
}

function voterKey(value) {
  const voter = normalizeFriendlyVoter(value);
  if (!voter) return "";
  return voter.memberId || voter.userId || voter.name;
}

function sameVoter(left, right) {
  const leftKey = voterKey(left);
  const rightKey = voterKey(right);
  return !!leftKey && !!rightKey && leftKey === rightKey;
}

function normalizeFriendlyVoters(value) {
  const seen = new Set();
  return normalizeArray(value)
    .map(normalizeFriendlyVoter)
    .filter(Boolean)
    .filter((voter) => {
      const key = voterKey(voter);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeFriendlyTags(value) {
  return normalizeArray(value)
    .map((item) => {
      const source = typeof item === "object" && item ? item : { tag: item };
      const tag = normalizeFriendlyTag(source.tag || source.name);
      if (!tag) return null;
      const voters = normalizeFriendlyVoters(source.voters);
      const count = Math.max(Number(source.count || 0), voters.length);
      return {
        tag,
        count,
        voters,
        voterNames: voters.slice(0, 3).map((voter) => voter.name).filter(Boolean),
        threshold: Number(source.threshold || FRIENDLY_TAG_THRESHOLD),
        lastAt: source.lastAt || (voters[0] && voters[0].createdAt) || "",
        lastAtMs: Number(source.lastAtMs || (voters[0] && voters[0].createdAtMs) || 0),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.count - a.count || b.lastAtMs - a.lastAtMs);
}

function upsertFriendlyTag(friendlyTags, tag, voter) {
  let added = false;
  const normalized = normalizeFriendlyTags(friendlyTags);
  const now = nowIso();
  const nowMs = Date.now();
  const next = normalized.map((item) => {
    if (item.tag !== tag) return item;
    if (normalizeFriendlyVoters(item.voters).some((existed) => sameVoter(existed, voter))) return item;
    added = true;
    const voters = [Object.assign({}, voter, { createdAt: now, createdAtMs: nowMs })].concat(item.voters || []);
    return Object.assign({}, item, {
      voters,
      count: Math.max(Number(item.count || 0), voters.length),
      voterNames: voters.slice(0, 3).map((entry) => entry.name).filter(Boolean),
      lastAt: now,
      lastAtMs: nowMs,
    });
  });
  if (!next.some((item) => item.tag === tag)) {
    added = true;
    next.unshift({
      tag,
      count: 1,
      voters: [Object.assign({}, voter, { createdAt: now, createdAtMs: nowMs })],
      voterNames: [voter.name].filter(Boolean),
      threshold: FRIENDLY_TAG_THRESHOLD,
      lastAt: now,
      lastAtMs: nowMs,
    });
  }
  return { friendlyTags: normalizeFriendlyTags(next), added };
}

function toggleFriendlyTag(friendlyTags, tag, voter) {
  let added = false;
  let removed = false;
  const normalized = normalizeFriendlyTags(friendlyTags);
  const now = nowIso();
  const nowMs = Date.now();
  const next = [];
  normalized.forEach((item) => {
    if (item.tag !== tag) {
      next.push(item);
      return;
    }
    const existed = normalizeFriendlyVoters(item.voters).some((entry) => sameVoter(entry, voter));
    if (existed) {
      removed = true;
      const voters = normalizeFriendlyVoters(item.voters).filter((entry) => !sameVoter(entry, voter));
      if (!voters.length) return;
      next.push(Object.assign({}, item, {
        voters,
        count: voters.length,
        voterNames: voters.slice(0, 3).map((entry) => entry.name).filter(Boolean),
        lastAt: voters[0].createdAt || item.lastAt || "",
        lastAtMs: Number(voters[0].createdAtMs || item.lastAtMs || 0),
      }));
      return;
    }
    added = true;
    const voters = [Object.assign({}, voter, { createdAt: now, createdAtMs: nowMs })].concat(item.voters || []);
    next.push(Object.assign({}, item, {
      voters,
      count: voters.length,
      voterNames: voters.slice(0, 3).map((entry) => entry.name).filter(Boolean),
      lastAt: now,
      lastAtMs: nowMs,
    }));
  });
  if (!added && !removed && !next.some((item) => item.tag === tag)) {
    added = true;
    next.unshift({
      tag,
      count: 1,
      voters: [Object.assign({}, voter, { createdAt: now, createdAtMs: nowMs })],
      voterNames: [voter.name].filter(Boolean),
      threshold: FRIENDLY_TAG_THRESHOLD,
      lastAt: now,
      lastAtMs: nowMs,
    });
  }
  return { friendlyTags: normalizeFriendlyTags(next), added, removed };
}

function normalizeTagProposals(value) {
  return normalizeArray(value)
    .map((proposal) => {
      if (!proposal || typeof proposal !== "object") return null;
      const tag = normalizeFriendlyTag(proposal.tag);
      if (!tag) return null;
      const voters = normalizeFriendlyVoters(proposal.voters);
      const threshold = Math.max(2, Number(proposal.threshold || FRIENDLY_TAG_THRESHOLD));
      const votes = Math.max(Number(proposal.votes || 0), voters.length);
      const status = proposal.status === "已上墙" || votes >= threshold ? "已上墙" : "投票中";
      return {
        id: String(proposal.id || businessId("tag-proposal")),
        tag,
        proposerName: String(proposal.proposerName || (voters[0] && voters[0].name) || "圈友"),
        votes,
        voters,
        voterNames: voters.slice(0, 3).map((voter) => voter.name).filter(Boolean),
        threshold,
        status,
        createdAt: proposal.createdAt || "",
        createdAtMs: Number(proposal.createdAtMs || 0),
        approvedAt: proposal.approvedAt || "",
        approvedAtMs: Number(proposal.approvedAtMs || 0),
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "投票中" ? -1 : 1;
      return (b.createdAtMs || 0) - (a.createdAtMs || 0);
    });
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function operationLogDetail(row) {
  const payload = row && row.payload ? row.payload : {};
  if (payload.detail) return sanitizeTimelineText(payload.detail);
  if (payload.reason) return sanitizeTimelineText(payload.reason);
  if (payload.status) return `状态：${statusText(payload.status)}`;
  if (Array.isArray(payload.fields) && payload.fields.length) return `变更字段：${payload.fields.join("、")}`;
  if (payload.circleName) return `圈子：${payload.circleName}`;
  if (payload.memberName) return `成员：${payload.memberName}`;
  return sanitizeTimelineText(row && row.target_type ? `${row.target_type} · ${row.target_id || ""}` : "");
}

function publicAdminOperationLog(row) {
  const base = publicOperationLog(row);
  if (!base) return null;
  const payload = row.payload || {};
  const targetName = payload.targetName || payload.circleName || payload.memberName || row.circle_name || base.targetId || "";
  return Object.assign(base, {
    actionText: sanitizeTimelineText(base.action || payload.actionText || "操作记录"),
    targetName: sanitizeTimelineText(targetName),
    circleName: sanitizeTimelineText(row.circle_name || payload.circleName || ""),
    detail: operationLogDetail(row),
    createdAtText: formatBeijingDateTime(row.created_at),
  });
}

function normalizeBadgeName(value) {
  const text = sanitizeTimelineText(value);
  if (!text) return "";
  if (text === "已更新" || text === "已更新资料" || text === "资料已更新" || text === "身份卡已更新") {
    return "身份卡装修师";
  }
  return text;
}

function pushUniqueBadge(list, value) {
  const badge = normalizeBadgeName(value);
  if (badge && !list.includes(badge)) list.push(badge);
}

function rowColumnOrLegacyPayload(row, column, payloadValue) {
  if (
    row &&
    Object.prototype.hasOwnProperty.call(row, column) &&
    typeof row[column] !== "undefined" &&
    row[column] !== null
  ) {
    return row[column];
  }
  return payloadValue;
}

function buildMemberBadges(payload, row, role) {
  const badges = [];
  sanitizeTimelineArray(rowColumnOrLegacyPayload(row, "badges", payload && payload.badges)).forEach((badge) =>
    pushUniqueBadge(badges, badge)
  );

  const score = Number(rowColumnOrLegacyPayload(row, "score", payload && payload.score) || 0);
  const weeklyScore = Number(rowColumnOrLegacyPayload(row, "weekly_score", payload && payload.weeklyScore) || 0);
  const tags = sanitizeTimelineArray(rowColumnOrLegacyPayload(row, "tags", payload && payload.tags));
  const skills = sanitizeTimelineArray(payload && payload.skills);
  const interests = sanitizeTimelineArray(payload && payload.interests);
  const taboos = sanitizeTimelineArray(payload && payload.taboos);
  const friendlyTags = normalizeFriendlyTags(payload && payload.friendlyTags);
  const friendlyVoteCount = friendlyTags.reduce((total, item) => total + Number(item.count || 0), 0);
  const friendlyWallCount = friendlyTags.filter((item) => item.count >= (item.threshold || FRIENDLY_TAG_THRESHOLD)).length;
  const activityCount = Number((payload && (payload.activityCount || payload.monthActivityCount)) || 0);
  const checkinDays = Number((payload && payload.checkinDays) || 0);
  const organizerCount = Number((payload && payload.organizerCount) || 0);
  const punctualCount = Number((payload && payload.punctualCount) || 0);
  const noShowCount = Number((payload && payload.noShowCount) || 0);
  const avatarUrl = safeAvatarUrl((row && row.avatar_url) || (payload && (payload.avatar || payload.avatarUrl)), "");
  const hasAvatar = !!avatarUrl && avatarUrl !== "/images/avatar.png";
  const hasProfileText = !!String((row && row.profile_note) || (payload && (payload.note || payload.profileNote)) || "").trim();
  const hasTitle = !!String((row && row.title) || (payload && payload.title) || "").trim();

  if (isOwnerRole(role)) pushUniqueBadge(badges, "圈主驾驶员");
  if (hasTitle && hasProfileText) pushUniqueBadge(badges, "身份卡装修师");
  if (hasAvatar) pushUniqueBadge(badges, "头像营业中");
  if (tags.length >= 3) pushUniqueBadge(badges, "标签批发商");
  if (tags.length >= 6) pushUniqueBadge(badges, "标签策展人");
  if (skills.length >= 2) pushUniqueBadge(badges, "技能工具箱");
  if (skills.length >= 4) pushUniqueBadge(badges, "万能搭子");
  if (interests.length >= 3) pushUniqueBadge(badges, "兴趣雷达");
  if (taboos.length >= 1) pushUniqueBadge(badges, "边界感大师");
  if (friendlyVoteCount >= 3) pushUniqueBadge(badges, "好感收集器");
  if (friendlyWallCount >= 2) pushUniqueBadge(badges, "口碑上墙");
  if (score >= 100) pushUniqueBadge(badges, "圈内发电站");
  else if (score >= 50) pushUniqueBadge(badges, "积分冒泡王");
  if (weeklyScore >= 20) pushUniqueBadge(badges, "本周小太阳");
  if (activityCount >= 8) pushUniqueBadge(badges, "局王预备役");
  else if (activityCount >= 3) pushUniqueBadge(badges, "约局常客");
  if (organizerCount >= 3) pushUniqueBadge(badges, "排局导演");
  else if (organizerCount >= 1) pushUniqueBadge(badges, "局子发动机");
  if (checkinDays >= 21) pushUniqueBadge(badges, "自律上头");
  else if (checkinDays >= 7) pushUniqueBadge(badges, "七日打卡怪");
  if (punctualCount >= 5) pushUniqueBadge(badges, "准点到达术");
  if (activityCount >= 3 && noShowCount === 0) pushUniqueBadge(badges, "不鸽认证");

  return badges;
}

function memberCardFromRow(row, userRow, membershipRow) {
  if (!row && !userRow) return null;
  const payload = sanitizeTimelineValue((row && row.payload) || {});
  const id = row ? String(row.id) : "";
  const role = normalizeMemberRole((membershipRow && membershipRow.role) || (row && row.role));
  return Object.assign({}, payload, {
    id,
    circleId: row && row.circle_id ? String(row.circle_id) : "",
    userId: userRow && userRow.id,
    openid: (row && row.openid) || (userRow && userRow.openid) || "",
    name: (row && row.name) || (userRow && userRow.nickname) || payload.name || "微信用户",
    avatar: safeAvatarUrl((row && row.avatar_url) || (userRow && userRow.avatar_url) || payload.avatar, "/images/avatar.png"),
    avatarUrl: safeAvatarUrl((row && row.avatar_url) || (userRow && userRow.avatar_url) || payload.avatarUrl, "/images/avatar.png"),
    title: sanitizeTimelineText((row && row.title) || (userRow && userRow.title) || payload.title || role),
    role,
    roleClass: roleClass(role),
    score: row && typeof row.score !== "undefined" ? Number(row.score || 0) : Number(payload.score || 0),
    weeklyScore: row && typeof row.weekly_score !== "undefined" ? Number(row.weekly_score || 0) : Number(payload.weeklyScore || 0),
    tags: sanitizeTimelineArray(rowColumnOrLegacyPayload(row, "tags", payload.tags)),
    friendlyTags: normalizeFriendlyTags(payload.friendlyTags),
    tagProposals: normalizeTagProposals(payload.tagProposals),
    safetyNote:
      sanitizeTimelineText(payload.safetyNote) ||
      "友好印象来自圈友背书，满 2 人认可会自动上墙；不合适可以随时删除或申诉。",
    badges: buildMemberBadges(payload, row, role),
  });
}

const CLOSED_VOTE_STATUSES = new Set(["已截止", "已出结果", "已关闭", "closed", "completed", "ended"]);
const CLOSED_ACTIVITY_STATUSES = new Set(["已完成", "已结束", "已取消", "已关闭", "closed", "completed", "ended", "cancelled", "canceled"]);
const CLOSED_BILL_STATUSES = new Set(["已结清", "已完成", "已关闭", "settled", "closed", "completed"]);
const CLOSED_CHECKIN_STATUSES = new Set(["已完成", "已结束", "已关闭", "closed", "completed", "ended"]);
const CLOSED_DOC_STATUSES = new Set(["已归档", "已关闭", "archived", "closed"]);

function defaultVoteDeadlineDate(reference) {
  const parts = beijingParts(reference) || beijingParts();
  if (!parts) return new Date(Date.now() + 2 * 60 * 60 * 1000);
  let deadline = dateFromBeijingParts(parts.year, parts.month, parts.day, 22, 0, 0);
  const referenceTime = reference ? new Date(reference).getTime() : Date.now();
  if (!deadline || deadline.getTime() <= referenceTime) {
    deadline = new Date((deadline ? deadline.getTime() : Date.now()) + 24 * 60 * 60 * 1000);
  }
  return deadline;
}

function normalizeVoteDeadline(vote) {
  const reference = vote.createdAt || vote.createdAtMs || vote.created_at || null;
  const deadlineDate =
    parseBeijingDateTime(vote.deadlineAtMs, reference) ||
    parseBeijingDateTime(vote.deadlineAt || vote.deadlineTime || vote.deadlineText || vote.deadline, reference) ||
    defaultVoteDeadlineDate(reference);
  const display = formatBeijingDateTime(deadlineDate);
  return {
    deadlineAt: deadlineDate.toISOString(),
    deadlineAtMs: deadlineDate.getTime(),
    deadlineDisplay: display,
    deadlineText: `${display} 截止`,
    deadline: `${display} 截止`,
    deadlinePassed: deadlineDate.getTime() <= Date.now(),
  };
}

function voteStatusIsClosed(vote) {
  return CLOSED_VOTE_STATUSES.has(String((vote && vote.status) || ""));
}

function voteOptionScore(option, vote) {
  return vote && vote.organizerWeighted ? option.weightedCount || option.count || 0 : option.count || 0;
}

function optionResultLine(option, vote) {
  const countText = `${option.count || 0}票`;
  const weightText =
    vote && vote.organizerWeighted && (option.weightedCount || 0) !== (option.count || 0)
      ? ` / 权重${option.weightedCount || 0}`
      : "";
  const vetoText = option.vetoed ? " / 已否决" : "";
  return `${option.name} ${countText}${weightText} (${option.percent || 0}%)${vetoText}`;
}

function buildVoteResultPayload(vote, options) {
  const opts = options || {};
  const generatedAt = opts.generatedAt || vote.resultGeneratedAt || nowIso();
  const closedAt = opts.closedAt || vote.closedAt || generatedAt;
  const closedReason = opts.closedReason || vote.closedReason || "到点截止";
  const optionsList = normalizeArray(vote.options);
  const availableOptions = optionsList
    .filter((option) => !option.vetoed)
    .slice()
    .sort((a, b) => voteOptionScore(b, vote) - voteOptionScore(a, vote));
  const winner = availableOptions[0] || {};
  const winnerScore = winner.name ? voteOptionScore(winner, vote) : 0;
  const tieOptions = winner.name
    ? availableOptions.filter((option) => voteOptionScore(option, vote) === winnerScore).map((option) => option.name)
    : [];
  const totalVotes = normalizeArray(vote.records).length;
  const totalWeightedVotes = optionsList.reduce((sum, option) => sum + (option.weightedCount || option.count || 0), 0);
  const silentMembers = normalizeArray(vote.silent).filter(Boolean);
  const vetoedOptions = optionsList.filter((option) => option.vetoed).map((option) => option.name);
  const conclusion = winner.name
    ? tieOptions.length > 1
      ? `并列领先：${tieOptions.join("、")}`
      : `${winner.name} 胜出`
    : "暂无有效投票";
  const resultText = winner.name
    ? `${conclusion}，${winner.count || 0} 票${vote.organizerWeighted ? `，权重票 ${winnerScore}` : ""}。`
    : "投票已截止，但暂无有效票数。";
  const optionLines = optionsList.map((option) => optionResultLine(option, vote));
  const resultSummary = [
    `【${vote.title || "投票"}】摘要分析`,
    `状态：已截止（${closedReason}）`,
    `截止：${vote.deadlineDisplay || formatBeijingDateTime(vote.deadlineAt)}`,
    `结论：${conclusion}`,
    `参与：${totalVotes} 票${silentMembers.length ? `，未投：${silentMembers.join("、")}` : "，全员已投"}`,
    `明细：${optionLines.join("；") || "暂无选项"}`,
    vetoedOptions.length ? `否决：${vetoedOptions.join("、")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    status: "已截止",
    isClosed: true,
    canVote: false,
    closedAt,
    closedAtText: formatBeijingDateTime(closedAt),
    closedReason,
    winner: winner.name || "",
    resultText,
    resultSummary,
    resultGeneratedAt: generatedAt,
    resultGeneratedAtText: formatBeijingDateTime(generatedAt),
    resultAnalysis: {
      conclusion,
      winner: winner.name || "",
      totalVotes,
      totalWeightedVotes,
      silentMembers,
      vetoedOptions,
      closedReason,
      closedAtText: formatBeijingDateTime(closedAt),
      generatedAtText: formatBeijingDateTime(generatedAt),
      options: optionsList.map((option) => ({
        name: option.name,
        count: option.count || 0,
        weightedCount: option.weightedCount || option.count || 0,
        percent: option.percent || 0,
        vetoed: !!option.vetoed,
      })),
    },
  };
}

function prepareVotePayload(vote, options) {
  if (!vote) return { vote, shouldPersist: false };
  const opts = options || {};
  const deadline = normalizeVoteDeadline(vote);
  let next = recalcVote(Object.assign({}, vote, deadline));
  const manuallyClosed = voteStatusIsClosed(next) && !deadline.deadlinePassed && next.closedReason !== "到点截止";
  const shouldClose = opts.forceClose || deadline.deadlinePassed || manuallyClosed;
  if (shouldClose) {
    next = Object.assign(
      {},
      next,
      buildVoteResultPayload(next, {
        closedReason:
          opts.closedReason ||
          next.closedReason ||
          (opts.forceClose || (voteStatusIsClosed(next) && !deadline.deadlinePassed) ? "提前截止" : "到点截止"),
        closedAt: opts.closedAt || next.closedAt || (deadline.deadlinePassed ? next.deadlineAt : nowIso()),
        generatedAt: opts.generatedAt || next.resultGeneratedAt || nowIso(),
      })
    );
  } else {
    next = Object.assign({}, next, {
      status: "投票中",
      isClosed: false,
      canVote: true,
      resultText: `${next.winner || "暂无选项"} 暂时领先，截止后会生成摘要分析。`,
    });
  }
  const shouldPersist = [
    "deadline",
    "deadlineAt",
    "deadlineAtMs",
    "deadlineText",
    "deadlineDisplay",
    "status",
    "resultText",
    "resultSummary",
    "resultGeneratedAt",
    "closedAt",
    "closedReason",
  ].some((key) => String(vote[key] || "") !== String(next[key] || ""));
  return { vote: next, shouldPersist };
}

function recalcVote(vote) {
  const next = Object.assign({}, vote);
  const options = normalizeArray(next.options).map((option) => Object.assign({}, option, { count: 0, weightedCount: 0 }));
  const optionMap = options.reduce((map, option) => {
    map[option.name] = option;
    return map;
  }, {});
  const votedMembers = new Set();
  normalizeArray(next.records).forEach((record) => {
    const option = optionMap[record.optionName];
    if (!option) return;
    option.count += 1;
    option.weightedCount += record.weight || 1;
    if (record.memberName) votedMembers.add(record.memberName);
  });
  const totalScore = options.reduce((sum, option) => sum + voteOptionScore(option, next), 0);
  options.forEach((option) => {
    option.percent = totalScore ? Math.round((voteOptionScore(option, next) / totalScore) * 100) : 0;
  });
  next.options = options;
  next.silent = normalizeArray(next.silent).filter((name) => !votedMembers.has(name));
  const winner = options
    .filter((option) => !option.vetoed)
    .filter((option) => (option.weightedCount || option.count || 0) > 0)
    .slice()
    .sort((a, b) => (b.weightedCount || b.count || 0) - (a.weightedCount || a.count || 0))[0];
  next.winner = winner ? winner.name : "";
  return next;
}

function enrichVoteWithVoters(vote, members) {
  if (!vote) return vote;
  if (vote.visibility === "匿名") {
    const myVoteOptionNames = normalizeArray(vote.records)
      .filter((record) => String(record.userId || "") === String(vote.currentUserId || ""))
      .map((record) => record.optionName);
    return Object.assign({}, vote, {
      showVoterAvatars: false,
      records: [],
      myVoteOptionNames,
      hasMyVote: myVoteOptionNames.length > 0,
      silent: [],
      options: normalizeArray(vote.options).map((option) => Object.assign({}, option, { voters: [], hasVoters: false })),
    });
  }
  const byKey = normalizeArray(members).reduce((map, member) => {
    if (member.id) map[member.id] = member;
    if (member.openid) map[member.openid] = member;
    if (member.name) map[member.name] = member;
    return map;
  }, {});
  const records = normalizeArray(vote.records).map((record) => {
    const member = byKey[record.memberId] || byKey[record.openid] || byKey[record.memberName] || {};
    return Object.assign({}, record, {
      memberName: record.memberName || member.name || "圈友",
      avatar: record.avatar || member.avatar || "/images/avatar.png",
    });
  });
  return Object.assign({}, vote, {
    records,
    showVoterAvatars: true,
    options: normalizeArray(vote.options).map((option) => {
      const voters = records.filter((record) => record.optionName === option.name);
      return Object.assign({}, option, { voters, hasVoters: voters.length > 0 });
    }),
  });
}

function timestampFromRecordId(id) {
  const matched = String(id || "").match(/-(\d{13})(?:-|$)/);
  return matched ? Number(matched[1]) : 0;
}

function recordDateKey(record) {
  if (!record) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(record.checkinDate || ""))) return record.checkinDate;
  if (record.createdAtMs) return beijingDateKey(Number(record.createdAtMs));
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(String(record.createdAt || ""))) {
    return String(record.createdAt).slice(0, 10);
  }
  if (record.createdAt) return beijingDateKey(record.createdAt);
  const idMs = timestampFromRecordId(record.id);
  return idMs ? beijingDateKey(idMs) : "";
}

function recordMemberKey(record) {
  if (!record) return "";
  return String(record.memberId || record.userId || record.openid || record.memberName || "");
}

function recordBelongsToMember(record, member) {
  if (!record || !member) return false;
  return (
    (member.id && String(record.memberId || "") === String(member.id)) ||
    (member.userId && String(record.userId || "") === String(member.userId)) ||
    (member.openid && String(record.openid || "") === String(member.openid)) ||
    (member.name && String(record.memberName || "") === String(member.name))
  );
}

function memberCheckedInToday(checkin, member, todayKey) {
  if (!checkin || !member || !todayKey) return false;
  return normalizeArray(checkin.records).some((record) => {
    return recordBelongsToMember(record, member) && recordDateKey(record) === todayKey;
  });
}

function checkinDoneCountForDate(checkin, todayKey) {
  if (!checkin || !todayKey) return 0;
  const uniqueMembers = new Set();
  normalizeArray(checkin.records).forEach((record) => {
    if (recordDateKey(record) !== todayKey) return;
    const memberKey = recordMemberKey(record);
    if (memberKey) uniqueMembers.add(memberKey);
  });
  return uniqueMembers.size;
}

function checkinRuntimeMetrics(checkin, todayKey) {
  const dateKey = todayKey || beijingDateKey();
  const yesterdayKey = shiftDateKey(dateKey, -1);
  const weekStartKey = beijingWeekKey(dateKey);
  const records = normalizeArray(checkin && checkin.records);
  const members = new Map();

  records.forEach((record) => {
    const key = recordMemberKey(record) || `record:${record.id || members.size}`;
    const nameValue = sanitizeTimelineText(record.memberName || "圈友");
    const name = nameValue && !/^(undefined|null)$/i.test(nameValue) ? nameValue : "圈友";
    const entry = members.get(key) || { key, name, dates: new Set(), records: [] };
    const recordKey = recordDateKey(record);
    if (recordKey) entry.dates.add(recordKey);
    entry.records.push(record);
    members.set(key, entry);
  });

  const rankedMembers = Array.from(members.values()).map((entry) => {
    let cursor = entry.dates.has(dateKey) ? dateKey : entry.dates.has(yesterdayKey) ? yesterdayKey : "";
    let streak = 0;
    while (cursor && entry.dates.has(cursor)) {
      streak += 1;
      cursor = shiftDateKey(cursor, -1);
    }
    return Object.assign(entry, { streak });
  });
  const streakEntries = rankedMembers
    .filter((entry) => entry.streak > 0)
    .sort((left, right) => right.streak - left.streak || right.records.length - left.records.length || left.name.localeCompare(right.name));
  const recordEntries = rankedMembers
    .slice()
    .sort((left, right) => right.records.length - left.records.length || right.streak - left.streak || left.name.localeCompare(right.name));
  const champion = streakEntries[0] || null;
  const streakChampion = champion ? champion.name : "";
  const streakDays = champion ? champion.streak : 0;
  const streakLabel = champion
    ? streakDays > 1
      ? `${streakChampion} · 连续 ${streakDays} 天`
      : `${streakChampion} · 已记录 1 天`
    : "连续榜待开启";

  const weeklyRecords = records.filter((record) => {
    const key = recordDateKey(record);
    return !!key && key >= weekStartKey && key <= dateKey;
  });
  const weeklyMembers = new Set(weeklyRecords.map(recordMemberKey).filter(Boolean));
  let weeklySummary = "本周还没有打卡记录。";
  if (weeklyRecords.length) {
    const leaderText = champion
      ? streakDays > 1
        ? `，${streakChampion} 以连续 ${streakDays} 天领跑`
        : `，${streakChampion} 率先完成记录`
      : "";
    weeklySummary = `本周 ${weeklyMembers.size || 1} 人留下 ${weeklyRecords.length} 条打卡记录${leaderText}。`;
  }

  const earliest = records
    .filter((record) => recordDateKey(record) === dateKey)
    .slice()
    .sort((left, right) => Number(left.createdAtMs || new Date(left.createdAt || 0).getTime()) - Number(right.createdAtMs || new Date(right.createdAt || 0).getTime()))
    .slice(0, 3)
    .map((record) => {
      const formatted = formatBeijingDateTime(record.createdAt || record.createdAtMs);
      return {
        name: sanitizeTimelineText(record.memberName || "圈友") || "圈友",
        label: "较早完成记录",
        value: formatted ? formatted.slice(11, 16) : "已记录",
      };
    });
  const rankings = Object.assign({}, (checkin && checkin.rankings) || {}, {
    rollKing: recordEntries.slice(0, 3).map((entry) => ({
      name: entry.name,
      label: `${entry.records.length} 条历史记录`,
      value: `${entry.records.length} 次`,
    })),
    streakKing: streakEntries.slice(0, 3).map((entry) => ({
      name: entry.name,
      label: entry.streak > 1 ? "连续保持中" : "已开始记录",
      value: `${entry.streak} 天`,
    })),
    earliest,
  });

  return { streakChampion, streakDays, streakLabel, weeklySummary, rankings };
}

function decorateCheckinForMember(checkin, member, todayKey) {
  if (!checkin) return checkin;
  const dateKey = todayKey || beijingDateKey();
  const hasRecords = normalizeArray(checkin.records).length > 0;
  const hasCardUsage = Number(checkin.leaveCardsUsed || 0) > 0 || Number(checkin.makeupCardsUsed || 0) > 0;
  const isClosed = CLOSED_CHECKIN_STATUSES.has(String(checkin.status || ""));
  const metrics = checkinRuntimeMetrics(checkin, dateKey);
  const runtimeEditReason = isClosed
    ? "打卡挑战已经结束，内容已锁定"
    : hasRecords || hasCardUsage
      ? "已有成员参与挑战，不能再修改挑战规则"
      : checkin.editDisabledReason || "";
  return Object.assign({}, checkin, metrics, {
    checked: memberCheckedInToday(checkin, member, dateKey),
    done: checkinDoneCountForDate(checkin, dateKey),
    checkinDate: dateKey,
    canEdit: !!checkin.canEdit && !runtimeEditReason,
    editDisabledReason: runtimeEditReason,
  });
}

class InCircleService {
  constructor(app, options) {
    this.app = app;
    this.db = app.db;
    this.config = app.config;
    this.request = options && options.request;
    this.identityCache = new Map();
    this.createMiniProgramCode = app.createMiniProgramCode || createMiniProgramCode;
  }

  currentLegalProfile() {
    if (!this.legalProfilePromise) {
      this.legalProfilePromise = readPublicLegalProfile(this.db);
    }
    return this.legalProfilePromise;
  }

  enforceAuthRateLimit(action, identity, account) {
    const identityKey = identity && identity.openid ? identity.openid : (this.request && this.request.ip) || "unknown";
    const key = `${action}:${identityKey}:${accountKeyOf(account)}`;
    const now = Date.now();
    const current = authAttemptWindows.get(key);
    if (!current || current.expiresAt <= now) {
      authAttemptWindows.set(key, { count: 1, expiresAt: now + AUTH_ATTEMPT_WINDOW_MS });
      return;
    }
    current.count += 1;
    if (current.count > AUTH_ATTEMPT_LIMIT) {
      throw new AppError("尝试次数过多，请稍后再试", {
        statusCode: 429,
        errCode: "AUTH_RATE_LIMITED",
      });
    }
  }

  async resolveIdentity(body, options) {
    const required = !!(options && options.required);
    const code = body && (body.wechatLoginCode || body.code);
    if (code) {
      if (this.identityCache.has(code)) return this.identityCache.get(code);
      const identity = Object.assign(await exchangeWechatLoginCode(this.config, code), { source: "wechat" });
      this.identityCache.set(code, identity);
      return identity;
    }

    const token = bearerToken(this.request);
    if (token) return verifyAccessToken(this.config, token);

    if (!code) {
      if (required) {
        throw new AppError("缺少登录凭证，请重新登录", {
          statusCode: 401,
          errCode: "AUTH_REQUIRED",
        });
      }
      return null;
    }
  }

  isSuperAdmin(openid, row) {
    return !!(
      (row && row.is_super_admin) ||
      (openid && this.config.superAdminOpenids && this.config.superAdminOpenids.includes(openid))
    );
  }

  canManageCircle(auth, membership) {
    if (!auth || !auth.user) return false;
    return !!(
      this.isSuperAdmin(auth.identity && auth.identity.openid, auth.user) ||
      (membership && canManageRole(membership.role))
    );
  }

  async getUserByOpenid(openid) {
    const result = await this.db.query("SELECT * FROM incircle_users WHERE openid = $1 LIMIT 1", [openid]);
    return result.rows[0] || null;
  }

  async getUserById(userId) {
    const result = await this.db.query("SELECT * FROM incircle_users WHERE id = $1 LIMIT 1", [userId]);
    return result.rows[0] || null;
  }

  async getUserByAccount(account) {
    const accountKey = accountKeyOf(account);
    if (!accountKey) return null;
    const result = await this.db.query("SELECT * FROM incircle_users WHERE account_key = $1 LIMIT 1", [accountKey]);
    return result.rows[0] || null;
  }

  async establishLoginSession(user, identity, body) {
    const session = await establishAccountSession(
      this.db,
      this.config,
      this.request,
      user,
      identity,
      body || {}
    );
    this.activeAccountSession = session;
    this.activeIdentity = Object.assign({}, identity, {
      userId: String(user.id),
      sessionId: String(session.id),
      sessionVersion: Number(session.token_version),
    });
    return session;
  }

  async syncClientThemePreference(user, body) {
    const explicit = !!(body && body.themePreferenceExplicit === true);
    if (!user || (user.theme_key && !explicit)) return user;
    const clientThemeKey = normalizeThemeKey(
      (body && (body.clientThemeKey || body.themeKey)) || (body && body.profile && body.profile.themeKey),
      ""
    );
    if (!clientThemeKey) return user;
    const result = await this.db.query(
      `
      UPDATE incircle_users
      SET theme_key = $2, updated_at = now()
      WHERE id = $1 AND (theme_key IS NULL OR $3 = true)
      RETURNING *
      `,
      [user.id, clientThemeKey, explicit]
    );
    return result.rows[0] || user;
  }

  async assertAccountAvailable(account, openid) {
    const existed = await this.getUserByAccount(account);
    if (existed && existed.openid !== openid) {
      throw new AppError("这个账号已被其他微信绑定，请换一个账号", {
        statusCode: 409,
        errCode: "ACCOUNT_BOUND",
      });
    }
  }

  async upsertWechatUser(identity, profile) {
    const existed = await this.getUserByOpenid(identity.openid);
    const nickName = String((profile && profile.nickName) || (existed && existed.nickname) || "微信用户").trim();
    const phone = normalizePhone((profile && profile.phone) || (existed && existed.phone) || "");
    const themeKey = normalizeThemeKey(
      (profile && profile.themeKey) || (existed && existed.theme_key),
      DEFAULT_THEME_KEY
    );
    const isSuperAdmin = this.isSuperAdmin(identity.openid, existed);
    const result = await this.db.query(
      `
      INSERT INTO incircle_users (
        openid, unionid, nickname, wechat_nickname, phone, title, profile_note, profile_completed,
        theme_key, avatar_url, wechat_bound, wechat_bound_at, is_super_admin, status, raw_data
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, now(), $11, 'active', '{}'::jsonb)
      ON CONFLICT (openid) DO UPDATE SET
        unionid = COALESCE(NULLIF(EXCLUDED.unionid, ''), incircle_users.unionid),
        nickname = EXCLUDED.nickname,
        wechat_nickname = EXCLUDED.wechat_nickname,
        phone = EXCLUDED.phone,
        title = EXCLUDED.title,
        profile_note = EXCLUDED.profile_note,
        profile_completed = EXCLUDED.profile_completed,
        theme_key = COALESCE(NULLIF(incircle_users.theme_key, ''), EXCLUDED.theme_key),
        avatar_url = EXCLUDED.avatar_url,
        wechat_bound = true,
        wechat_bound_at = COALESCE(incircle_users.wechat_bound_at, now()),
        is_super_admin = EXCLUDED.is_super_admin OR incircle_users.is_super_admin,
        status = CASE
          WHEN incircle_users.status IN ('blocked', 'deleted') THEN incircle_users.status
          ELSE 'active'
        END,
        updated_at = now()
      RETURNING *
      `,
      [
        identity.openid,
        identity.unionid || "",
        nickName || "微信用户",
        String((profile && profile.wechatNickName) || (existed && existed.wechat_nickname) || "").trim(),
        phone,
        String((profile && profile.title) || (existed && existed.title) || "").trim(),
        String((profile && profile.profileNote) || (existed && existed.profile_note) || "").trim(),
        !!(nickName && phone),
        themeKey,
        safeAvatarUrl((profile && profile.avatarUrl) || (existed && existed.avatar_url), "/images/avatar.png"),
        isSuperAdmin,
      ]
    );
    return result.rows[0];
  }

  async saveAccountCredentials(openid, accountName, password, patch) {
    const credentials = await createPasswordCredentials(password);
    const agreement = patch && patch.agreement ? patch.agreement : null;
    return this.db.withTransaction(async () => {
      const result = await this.db.query(
        `
        UPDATE incircle_users SET
          account_name = $2,
          account_key = $3,
          password_hash = $4,
          password_salt = $5,
          password_iterations = $6,
          password_digest = $7,
          auth_version = auth_version + 1,
          logged_in = true,
          status = CASE WHEN status = 'blocked' THEN 'blocked' ELSE 'active' END,
          account_bound_at = COALESCE(account_bound_at, now()),
          wechat_bound_at = COALESCE(wechat_bound_at, now()),
          password_updated_at = now(),
          last_login_at = COALESCE($8::timestamptz, last_login_at),
          updated_at = now()
        WHERE openid = $1
        RETURNING *
        `,
        [
          openid,
          normalizeAccountName(accountName),
          accountKeyOf(accountName),
          credentials.passwordHash,
          credentials.passwordSalt,
          credentials.passwordIterations,
          credentials.passwordDigest,
          patch && patch.lastLoginAt ? patch.lastLoginAt : null,
        ]
      );
      const user = result.rows[0];
      if (!user || !agreement) return user;
      const recorded = await recordAgreementAcceptance(this.db, user.id, agreement);
      return recorded.user;
    });
  }

  async getActiveMemberships(userId) {
    const result = await this.db.query(
      `
      SELECT m.*, c.name AS circle_name
      FROM incircle_circle_members m
      JOIN incircle_circles c ON c.id = m.circle_id
      WHERE m.user_id = $1 AND m.status = 'active'
      ORDER BY COALESCE(m.last_entered_at, m.joined_at) DESC, m.joined_at DESC
      `,
      [userId]
    );
    return result.rows;
  }

  async getCirclesByMemberships(memberships) {
    if (!memberships.length) return [];
    const result = await this.db.query(
      "SELECT * FROM incircle_circles WHERE id = ANY($1::uuid[]) ORDER BY created_at ASC",
      [memberships.map((membership) => membership.circle_id)]
    );
    return result.rows;
  }

  async buildSession(userRow) {
    const legalProfile = await this.currentLegalProfile();
    if (!userRow || userRow.status === "deleted") {
      return this.emptySession(null, legalProfile);
    }
    if (userRow.status === "blocked") {
      return Object.assign(this.emptySession(
        publicUser(Object.assign({}, userRow, { logged_in: false })),
        legalProfile
      ), {
        accountBlocked: true,
        blockedReason: userRow.blocked_reason || "账号已被封禁，请联系平台处理",
      });
    }
    if (!userRow.logged_in) return this.emptySession(publicUser(userRow), legalProfile);
    const acceptanceState = await readAgreementAcceptanceState(this.db, userRow, legalProfile);
    const agreements = agreementStatus(userRow, legalProfile, acceptanceState);
    const hasActiveAccount = !!(userRow.logged_in && hasPasswordAccount(userRow));
    const accountSession = this.activeAccountSession || null;
    const hasActiveSession = !!(hasActiveAccount && accountSession);
    const access = hasActiveSession ? issueAccessToken(this.config, userRow, accountSession) : null;
    if (hasActiveAccount && !agreements.accepted) {
      return {
        user: publicUser(userRow),
        circles: [],
        myCircles: [],
        circleMemberships: [],
        memberships: [],
        currentCircleId: "",
        currentCircle: null,
        loggedIn: hasActiveSession,
        hasCircle: false,
        hasCircles: false,
        isSuperAdmin: false,
        needsAccountBinding: false,
        agreementsAccepted: false,
        agreements,
        accessToken: access ? access.token : "",
        accessTokenExpiresAt: access ? access.expiresAt : "",
        backend: { provider: "self-hosted", mode: "http", migrated: true },
      };
    }
    const memberships = await this.getActiveMemberships(userRow.id);
    const circles = await this.getCirclesByMemberships(memberships);
    const membershipByCircle = memberships.reduce((map, membership) => {
      map[String(membership.circle_id)] = membership;
      return map;
    }, {});
    const storedCurrentCircleId = String(userRow.current_circle_id || "");
    const currentCircleRow = storedCurrentCircleId
      ? circles.find((circle) => String(circle.id) === storedCurrentCircleId && circle.status === "active")
      : null;
    const currentCircleId = currentCircleRow ? storedCurrentCircleId : "";
    if (storedCurrentCircleId && !currentCircleId) {
      const updated = await this.db.query(
        "UPDATE incircle_users SET current_circle_id = NULL, updated_at = now() WHERE id = $1 RETURNING *",
        [userRow.id]
      );
      userRow = updated.rows[0] || userRow;
    }
    if (currentCircleId) {
      const touched = await this.db.query(
        `
        UPDATE incircle_circle_members
        SET last_entered_at = now(), updated_at = now()
        WHERE user_id = $1 AND circle_id = $2 AND status = 'active'
        RETURNING last_entered_at
        `,
        [userRow.id, currentCircleId]
      );
      if (touched.rows[0] && membershipByCircle[currentCircleId]) {
        membershipByCircle[currentCircleId].last_entered_at = touched.rows[0].last_entered_at;
      }
    }
    const isSuperAdmin = this.isSuperAdmin(userRow.openid, userRow);
    const decoratedCircles = circles
      .map((circle) => publicCircle(circle, membershipByCircle[String(circle.id)], currentCircleId, { isSuperAdmin }))
      .sort((left, right) => {
        const leftTime = Date.parse(left.lastEnteredAt || left.createdAt || 0) || 0;
        const rightTime = Date.parse(right.lastEnteredAt || right.createdAt || 0) || 0;
        return rightTime - leftTime;
      });
    return {
      user: publicUser(userRow),
      circles: decoratedCircles,
      myCircles: decoratedCircles,
      circleMemberships: memberships.map(publicMembership),
      memberships: memberships.map(publicMembership),
      currentCircleId,
      currentCircle: currentCircleId ? decoratedCircles.find((circle) => circle.id === currentCircleId) || null : null,
      loggedIn: hasActiveSession,
      hasCircle: !!currentCircleId,
      hasCircles: decoratedCircles.length > 0,
      isSuperAdmin,
      needsAccountBinding: !hasPasswordAccount(userRow),
      agreementsAccepted: agreements.accepted,
      agreements,
      accessToken: access ? access.token : "",
      accessTokenExpiresAt: access ? access.expiresAt : "",
      backend: { provider: "self-hosted", mode: "http", migrated: true },
    };
  }

  emptySession(user, legalProfile) {
    const agreements = agreementStatus(null, legalProfile);
    return {
      user,
      loggedIn: false,
      hasCircle: false,
      hasCircles: false,
      currentCircleId: "",
      currentCircle: null,
      circles: [],
      myCircles: [],
      circleMemberships: [],
      memberships: [],
      isSuperAdmin: !!(user && user.isSuperAdmin),
      needsAccountBinding: false,
      agreementsAccepted: false,
      agreements,
      backend: { provider: "self-hosted", mode: "http", migrated: true },
    };
  }

  async requireUser(body, options) {
    const identity = await this.resolveIdentity(body, { required: true });
    if (identity.source !== "token" || !identity.userId) {
      throw new AppError("请使用账号密码重新登录", {
        statusCode: 401,
        errCode: "AUTH_REQUIRED",
      });
    }
    const user = await this.getUserById(identity.userId);
    if (user && user.status === "blocked") {
      throw new AppError(user.blocked_reason || "账号已被封禁，请联系平台处理", {
        statusCode: 403,
        errCode: "ACCOUNT_BLOCKED",
      });
    }
    if (!user || user.status !== "active" || !user.logged_in) {
      throw new AppError("请先登录", { statusCode: 401, errCode: "LOGIN_REQUIRED" });
    }
    if (!hasPasswordAccount(user)) {
      throw new AppError("请先绑定账号密码", { statusCode: 401, errCode: "ACCOUNT_BINDING_REQUIRED" });
    }
    if (identity.userId && String(identity.userId) !== String(user.id)) {
      throw new AppError("登录凭证与账号不匹配，请重新登录", { statusCode: 401, errCode: "TOKEN_SUBJECT_MISMATCH" });
    }
    if (identity.authVersion && Number(identity.authVersion) !== Number(user.auth_version || 1)) {
      throw new AppError("登录状态已失效，请重新登录", { statusCode: 401, errCode: "TOKEN_REVOKED" });
    }
    this.activeAccountSession = await requireActiveAccountSession(this.db, identity, user.id);
    this.activeIdentity = identity;
    if (!(options && options.allowPendingAgreement)) {
      const legalProfile = await this.currentLegalProfile();
      const acceptanceState = await readAgreementAcceptanceState(this.db, user, legalProfile);
      const agreements = agreementStatus(user, legalProfile, acceptanceState);
      if (!agreements.accepted) {
        throw new AppError("请确认当前用户服务协议和隐私政策后继续", {
          statusCode: 428,
          errCode: "AGREEMENT_ACCEPTANCE_REQUIRED",
          details: agreements,
        });
      }
    }
    return { identity, user };
  }

  async publicLegalProfile() {
    return this.currentLegalProfile();
  }

  async session(body) {
    const legalProfile = await this.currentLegalProfile();
    if (!bearerToken(this.request)) {
      return this.emptySession(null, legalProfile);
    }
    const auth = await this.requireUser(body, { allowPendingAgreement: true });
    let user = auth.user;
    user = await this.syncClientThemePreference(user, body);
    return this.buildSession(user);
  }

  async registerAccount(body) {
    const identity = await this.resolveIdentity(body, { required: true });
    const agreement = requireAgreementAcceptance(body, "register", await this.currentLegalProfile());
    const accountName = normalizeAccountName(body.account);
    this.enforceAuthRateLimit("register", identity, accountName);
    const password = String(body.password || "");
    const accountError = validateAccountName(accountName);
    if (accountError) throw new AppError(accountError, { statusCode: 400, errCode: "INVALID_ACCOUNT" });
    const passwordError = validatePassword(password);
    if (passwordError) throw new AppError(passwordError, { statusCode: 400, errCode: "INVALID_PASSWORD" });
    const profileError = validateRegistrationProfile(body.profile || {});
    if (profileError) throw new AppError(profileError, { statusCode: 400, errCode: "INVALID_PROFILE" });
    await this.assertAccountAvailable(accountName, identity.openid);
    const existed = await this.getUserByOpenid(identity.openid);
    if (existed && existed.status === "deleted") {
      throw new AppError("该微信绑定的账号已经注销，无法重新注册", {
        statusCode: 410,
        errCode: "ACCOUNT_PERMANENTLY_DELETED",
      });
    }
    if (existed && existed.status === "blocked") {
      throw new AppError(existed.blocked_reason || "账号已被封禁，请联系平台处理", {
        statusCode: 403,
        errCode: "ACCOUNT_BLOCKED",
      });
    }
    if (existed && hasPasswordAccount(existed)) {
      throw new AppError("当前微信已经绑定账号，请直接登录或修改密码", {
        statusCode: 409,
        errCode: "WECHAT_ALREADY_BOUND",
      });
    }
    let user = await this.upsertWechatUser(
      identity,
      Object.assign({}, body.profile || {}, { themeKey: body.clientThemeKey || (body.profile && body.profile.themeKey) })
    );
    user = await this.syncClientThemePreference(user, body);
    user = await this.saveAccountCredentials(identity.openid, accountName, password, { lastLoginAt: nowIso(), agreement });
    await this.establishLoginSession(user, identity, body);
    return this.buildSession(user);
  }

  async accountLogin(body) {
    const identity = await this.resolveIdentity(body, { required: true });
    const agreement = requireAgreementAcceptance(body, "login", await this.currentLegalProfile());
    const accountName = normalizeAccountName(body.account);
    this.enforceAuthRateLimit("login", identity, accountName);
    const password = String(body.password || "");
    const accountError = validateAccountName(accountName);
    if (accountError) throw new AppError(accountError, { statusCode: 400, errCode: "INVALID_ACCOUNT" });
    if (!password) throw new AppError("请输入密码", { statusCode: 400, errCode: "PASSWORD_REQUIRED" });
    let user = await this.getUserByAccount(accountName);
    if (!user || user.status === "deleted" || !hasPasswordAccount(user)) {
      throw new AppError("账号或密码不正确", { statusCode: 401, errCode: "INVALID_CREDENTIALS" });
    }
    if (!(await verifyPassword(user, password))) {
      throw new AppError("账号或密码不正确", { statusCode: 401, errCode: "INVALID_CREDENTIALS" });
    }
    if (user.status === "blocked") {
      throw new AppError(user.blocked_reason || "账号已被封禁，请联系平台处理", {
        statusCode: 403,
        errCode: "ACCOUNT_BLOCKED",
      });
    }
    if (!user.openid && !user.wechat_bound) {
      if (body.confirmWechatRebind !== true) {
        throw new AppError("该账号已解绑微信，确认后可绑定到当前微信", {
          statusCode: 409,
          errCode: "WECHAT_REBIND_CONFIRM_REQUIRED",
          details: { accountMasked: maskAccount(user.account_name), nickName: user.nickname || "微信用户" },
        });
      }
      user = await this.db.withTransaction(async () => {
        const occupied = await this.db.query(
          "SELECT id FROM incircle_users WHERE openid = $1 AND id <> $2 LIMIT 1",
          [identity.openid, user.id]
        );
        if (occupied.rows.length) {
          throw new AppError("当前微信已经绑定其他账号", { statusCode: 409, errCode: "WECHAT_ALREADY_BOUND" });
        }
        const rebound = await this.db.query(
          `
          UPDATE incircle_users
          SET openid = $2,
              unionid = $3,
              wechat_bound = true,
              wechat_bound_at = now(),
              logged_in = true,
              auth_version = auth_version + 1,
              last_login_at = now(),
              updated_at = now()
          WHERE id = $1 AND status = 'active' AND openid IS NULL AND wechat_bound = false
          RETURNING *
          `,
          [user.id, identity.openid, identity.unionid || ""]
        );
        if (!rebound.rows[0]) {
          throw new AppError("账号绑定状态已变化，请重新登录", { statusCode: 409, errCode: "WECHAT_REBIND_STALE" });
        }
        await this.db.query("UPDATE incircle_circle_members SET openid = $2, updated_at = now() WHERE user_id = $1", [user.id, identity.openid]);
        await this.db.query("UPDATE incircle_member_cards SET openid = $2, updated_at = now() WHERE user_id = $1", [user.id, identity.openid]);
        await revokeAllAccountSessions(this.db, user.id, "微信绑定已更新");
        const recorded = await recordAgreementAcceptance(this.db, user.id, agreement);
        return recorded.user;
      });
      await this.establishLoginSession(user, identity, body);
      return this.buildSession(user);
    }
    if (user.verify_wechat_on_login !== false && user.openid !== identity.openid) {
      throw new AppError("该账号已绑定其他微信，请使用绑定的微信打开小程序", {
        statusCode: 403,
        errCode: "WECHAT_MISMATCH",
      });
    }
    user = await this.syncClientThemePreference(user, body);
    user = await this.db.withTransaction(async () => {
      const result = await this.db.query(
        `
        UPDATE incircle_users SET
          logged_in = true,
          last_login_at = now(),
          updated_at = now()
        WHERE id = $1
        RETURNING *
        `,
        [user.id]
      );
      const recorded = await recordAgreementAcceptance(this.db, result.rows[0].id, agreement);
      return recorded.user;
    });
    await this.establishLoginSession(user, identity, body);
    return this.buildSession(user);
  }

  async bindAccount(body) {
    const identity = await this.resolveIdentity(body, { required: true });
    const agreement = requireAgreementAcceptance(body, "bind", await this.currentLegalProfile());
    const accountName = normalizeAccountName(body.account);
    this.enforceAuthRateLimit("bind", identity, accountName);
    const password = String(body.password || "");
    const accountError = validateAccountName(accountName);
    if (accountError) throw new AppError(accountError, { statusCode: 400, errCode: "INVALID_ACCOUNT" });
    const passwordError = validatePassword(password);
    if (passwordError) throw new AppError(passwordError, { statusCode: 400, errCode: "INVALID_PASSWORD" });
    await this.assertAccountAvailable(accountName, identity.openid);
    const existed = await this.getUserByOpenid(identity.openid);
    if (existed && existed.status === "deleted") {
      throw new AppError("该微信绑定的账号已经注销，无法重新绑定", {
        statusCode: 410,
        errCode: "ACCOUNT_PERMANENTLY_DELETED",
      });
    }
    if (existed && existed.status === "blocked") {
      throw new AppError(existed.blocked_reason || "账号已被封禁，请联系平台处理", {
        statusCode: 403,
        errCode: "ACCOUNT_BLOCKED",
      });
    }
    if (existed && hasPasswordAccount(existed)) {
      throw new AppError("当前微信已经绑定账号", { statusCode: 409, errCode: "WECHAT_ALREADY_BOUND" });
    }
    let user = await this.upsertWechatUser(
      identity,
      Object.assign({}, body.profile || existed || {}, {
        themeKey: body.clientThemeKey || (body.profile && body.profile.themeKey),
      })
    );
    user = await this.syncClientThemePreference(user, body);
    user = await this.saveAccountCredentials(identity.openid, accountName, password, { lastLoginAt: nowIso(), agreement });
    await this.establishLoginSession(user, identity, body);
    return this.buildSession(user);
  }

  async resetPassword(body) {
    const identity = await this.resolveIdentity(body, { required: true });
    const agreement = requireAgreementAcceptance(body, "reset", await this.currentLegalProfile());
    const accountName = normalizeAccountName(body.account);
    this.enforceAuthRateLimit("reset", identity, accountName);
    const password = String(body.password || "");
    const accountError = validateAccountName(accountName);
    if (accountError) throw new AppError(accountError, { statusCode: 400, errCode: "INVALID_ACCOUNT" });
    const passwordError = validatePassword(password);
    if (passwordError) throw new AppError(passwordError, { statusCode: 400, errCode: "INVALID_PASSWORD" });
    let user = await this.getUserByAccount(accountName);
    if (!user || user.status === "deleted" || !hasPasswordAccount(user)) {
      throw new AppError("账号信息或绑定微信不匹配", { statusCode: 404, errCode: "ACCOUNT_RECOVERY_MISMATCH" });
    }
    if (user.status === "blocked") {
      throw new AppError(user.blocked_reason || "账号已被封禁，请联系平台处理", {
        statusCode: 403,
        errCode: "ACCOUNT_BLOCKED",
      });
    }
    if (user.openid !== identity.openid) {
      throw new AppError("当前微信不是该账号绑定的微信，不能重置密码", {
        statusCode: 403,
        errCode: "WECHAT_MISMATCH",
      });
    }
    user = await this.syncClientThemePreference(user, body);
    const nextUser = await this.saveAccountCredentials(identity.openid, user.account_name || accountName, password, {
      lastLoginAt: nowIso(),
      agreement,
    });
    await revokeAllAccountSessions(this.db, nextUser.id, "密码已重置");
    await this.establishLoginSession(nextUser, identity, body);
    return this.buildSession(nextUser);
  }

  async acceptAgreements(body) {
    const auth = await this.requireUser(body, { allowPendingAgreement: true });
    const agreement = requireAgreementAcceptance(body, "session", await this.currentLegalProfile());
    const recorded = await recordAgreementAcceptance(this.db, auth.user.id, agreement);
    return this.buildSession(recorded.user || auth.user);
  }

  async changePassword(body) {
    const auth = await this.requireUser(body);
    const currentPassword = String(body.currentPassword || "");
    const nextPassword = String(body.newPassword || body.password || "");
    const passwordError = validatePassword(nextPassword);
    if (passwordError) throw new AppError(passwordError, { statusCode: 400, errCode: "INVALID_PASSWORD" });
    this.enforceAuthRateLimit("change-password", auth.identity, auth.user.account_key);
    if (!(await verifyPassword(auth.user, currentPassword))) {
      throw new AppError("当前密码不正确", { statusCode: 401, errCode: "INVALID_CURRENT_PASSWORD" });
    }
    const nextUser = await this.saveAccountCredentials(
      auth.identity.openid,
      auth.user.account_name || auth.user.account_key,
      nextPassword,
      {}
    );
    await revokeAllAccountSessions(this.db, nextUser.id, "密码已修改", auth.identity.sessionId);
    this.activeAccountSession = await rotateCurrentAccountSession(
      this.db,
      this.config,
      auth.identity,
      nextUser.id
    );
    return this.buildSession(nextUser);
  }

  async accountSettings(body) {
    const auth = await this.requireUser(body);
    const sessionSummary = await accountSessionSummary(
      this.db,
      auth.user.id,
      auth.identity.sessionId
    );
    return {
      user: publicUser(auth.user),
      isSuperAdmin: this.isSuperAdmin(auth.user.openid, auth.user),
      verifyWechatOnLogin: auth.user.verify_wechat_on_login !== false,
      preciseLoginLocationEnabled: auth.user.precise_login_location_enabled === true,
      ...sessionSummary,
    };
  }

  async loginSessions(body) {
    const auth = await this.requireUser(body);
    const collection = await readAccountSessionCollection(
      this.db,
      auth.user.id,
      auth.identity.sessionId
    );
    return {
      sessions: collection.sessions,
      sessionCount: collection.total,
      activeSessionCount: collection.activeSessionCount,
    };
  }

  async enablePreciseLoginLocation(body) {
    const auth = await this.requireUser(body);
    this.enforceAuthRateLimit("login-location", auth.identity, auth.user.id);
    const location = await resolveLoginLocation(body.location, this.config);
    let wasEnabled = false;
    await this.db.withTransaction(async () => {
      wasEnabled = await lockLoginLocationPreference(this.db, auth.user.id);
      if (!wasEnabled) {
        await this.db.query(
          `
          UPDATE incircle_users
          SET precise_login_location_enabled = true, updated_at = now()
          WHERE id = $1
          `,
          [auth.user.id]
        );
      }
      await updateCurrentAccountSessionLocation(
        this.db,
        auth.user.id,
        auth.identity.sessionId,
        location
      );
      await this.logOperation(
        null,
        auth,
        wasEnabled ? "更新当前设备登录位置" : "开启精确登录定位",
        "user",
        auth.user.id,
        { addressResolved: location.resolved === true }
      );
    });
    return {
      updated: true,
      preciseLoginLocationEnabled: true,
      addressResolved: location.resolved === true,
      ...(await accountSessionSummary(this.db, auth.user.id, auth.identity.sessionId)),
    };
  }

  async updatePreciseLoginLocationPreference(body) {
    const auth = await this.requireUser(body);
    if (body.enabled === true) {
      throw new AppError("开启精确登录定位时必须同时提交当前位置", {
        statusCode: 409,
        errCode: "LOGIN_LOCATION_INITIAL_CAPTURE_REQUIRED",
      });
    }
    if (body.enabled !== false) {
      throw new AppError("登录定位设置无效", {
        statusCode: 400,
        errCode: "INVALID_LOGIN_LOCATION_PREFERENCE",
      });
    }
    let wasEnabled = false;
    await this.db.withTransaction(async () => {
      wasEnabled = await lockLoginLocationPreference(this.db, auth.user.id);
      if (wasEnabled) {
        await this.db.query(
          `
          UPDATE incircle_users
          SET precise_login_location_enabled = false, updated_at = now()
          WHERE id = $1
          `,
          [auth.user.id]
        );
      }
      await clearAccountSessionLocations(this.db, auth.user.id);
      if (wasEnabled) {
        await this.logOperation(
          null,
          auth,
          "关闭精确登录定位",
          "user",
          auth.user.id,
          { storedLocationsCleared: true }
        );
      }
    });
    return {
      preciseLoginLocationEnabled: false,
      ...(await accountSessionSummary(this.db, auth.user.id, auth.identity.sessionId)),
    };
  }

  async updateCurrentLoginLocation(body) {
    const auth = await this.requireUser(body);
    if (auth.user.precise_login_location_enabled !== true) {
      throw new AppError("精确登录定位已关闭", {
        statusCode: 409,
        errCode: "LOGIN_LOCATION_DISABLED",
      });
    }
    this.enforceAuthRateLimit("login-location", auth.identity, auth.user.id);
    const location = await resolveLoginLocation(body.location, this.config);
    await this.db.withTransaction(async () => {
      const enabled = await lockLoginLocationPreference(this.db, auth.user.id);
      if (!enabled) {
        throw new AppError("精确登录定位已关闭", {
          statusCode: 409,
          errCode: "LOGIN_LOCATION_DISABLED",
        });
      }
      await updateCurrentAccountSessionLocation(
        this.db,
        auth.user.id,
        auth.identity.sessionId,
        location
      );
      await this.logOperation(null, auth, "更新当前设备登录位置", "user", auth.user.id, {
        addressResolved: location.resolved === true,
      });
    });
    return {
      updated: true,
      addressResolved: location.resolved === true,
    };
  }

  async updateWechatLoginVerification(body) {
    const auth = await this.requireUser(body);
    if (typeof body.enabled !== "boolean") {
      throw new AppError("登录校验设置无效", {
        statusCode: 400,
        errCode: "INVALID_WECHAT_LOGIN_VERIFICATION",
      });
    }
    const enabled = body.enabled;
    const current = auth.user.verify_wechat_on_login !== false;
    if (enabled === current) {
      return { verifyWechatOnLogin: current };
    }
    if (!enabled) {
      const password = String(body.currentPassword || "");
      this.enforceAuthRateLimit("disable-wechat-login-verification", auth.identity, auth.user.account_key);
      if (!password || !(await verifyPassword(auth.user, password))) {
        throw new AppError("当前密码不正确", {
          statusCode: 401,
          errCode: "INVALID_CURRENT_PASSWORD",
        });
      }
    } else if (!sessionMatchesBoundWechat(this.activeAccountSession, auth.user)) {
      throw new AppError("请使用账号原绑定的微信登录后再开启校验", {
        statusCode: 403,
        errCode: "BOUND_WECHAT_REQUIRED",
      });
    }
    await this.db.withTransaction(async () => {
      await this.db.query(
        `
        UPDATE incircle_users
        SET verify_wechat_on_login = $2, updated_at = now()
        WHERE id = $1
        `,
        [auth.user.id, enabled]
      );
      await this.logOperation(
        null,
        auth,
        enabled ? "开启登录微信校验" : "关闭登录微信校验",
        "user",
        auth.user.id,
        {}
      );
    });
    return { verifyWechatOnLogin: enabled };
  }

  async revokeLoginSession(body) {
    const auth = await this.requireUser(body);
    const sessionId = String(body.sessionId || "");
    if (!isUuid(sessionId)) {
      throw new AppError("登录设备参数无效", {
        statusCode: 400,
        errCode: "INVALID_ACCOUNT_SESSION_ID",
      });
    }
    await this.db.withTransaction(async () => {
      await revokeAccountSession(this.db, auth.user.id, auth.identity.sessionId, sessionId);
      await this.logOperation(null, auth, "退出其他登录设备", "user", auth.user.id, {});
    });
    return {
      ...(await accountSessionSummary(this.db, auth.user.id, auth.identity.sessionId)),
    };
  }

  async deleteLoginSession(body) {
    const auth = await this.requireUser(body);
    const sessionId = String(body.sessionId || "");
    if (!isUuid(sessionId)) {
      throw new AppError("登录记录参数无效", {
        statusCode: 400,
        errCode: "INVALID_ACCOUNT_SESSION_ID",
      });
    }
    await this.db.withTransaction(async () => {
      await deleteAccountSession(this.db, auth.user.id, auth.identity.sessionId, sessionId);
      await this.logOperation(null, auth, "删除已退出登录记录", "user", auth.user.id, {});
    });
    return { deletedSessionId: sessionId };
  }

  async updateTheme(body) {
    const auth = await this.requireUser(body);
    const themeKey = normalizeThemeKey(body.themeKey, "");
    if (!themeKey) {
      throw new AppError("主题不存在或已下线", { statusCode: 400, errCode: "INVALID_THEME" });
    }
    const customTheme = themeKey === "custom"
      ? normalizeCustomThemeRgba(body.customTheme || body.customThemeRgba, null)
      : normalizeCustomThemeRgba(auth.user.custom_theme_rgba, DEFAULT_CUSTOM_THEME_RGBA);
    if (themeKey === "custom" && !customTheme) {
      throw new AppError("自定义主题颜色无效", { statusCode: 400, errCode: "INVALID_CUSTOM_THEME" });
    }
    const result = await this.db.query(
      `
      UPDATE incircle_users
      SET theme_key = $2,
          custom_theme_rgba = CASE WHEN $2 = 'custom' THEN $3::jsonb ELSE custom_theme_rgba END,
          updated_at = now()
      WHERE id = $1
      RETURNING theme_key, custom_theme_rgba
      `,
      [auth.user.id, themeKey, JSON.stringify(customTheme)]
    );
    const row = result.rows[0] || {};
    return {
      themeKey: normalizeThemeKey(row.theme_key, themeKey),
      customTheme: normalizeCustomThemeRgba(row.custom_theme_rgba, customTheme),
    };
  }

  async logout(body) {
    const auth = await this.requireUser(body, { allowPendingAgreement: true });
    const legalProfile = await this.currentLegalProfile();
    await this.db.withTransaction(async () => {
      await this.db.query(
        `
        UPDATE incircle_account_sessions
        SET revoked_at = COALESCE(revoked_at, now()),
            revoked_reason = '用户退出当前设备',
            updated_at = now()
        WHERE id = $1 AND user_id = $2
        `,
        [auth.identity.sessionId, auth.user.id]
      );
      await this.db.query(
        `
        UPDATE incircle_users
        SET logged_in = EXISTS (
          SELECT 1 FROM incircle_account_sessions
          WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
        ), updated_at = now()
        WHERE id = $1
        `,
        [auth.user.id]
      );
    });
    return this.emptySession(null, legalProfile);
  }

  async deleteAccount(body) {
    const auth = await this.requireUser(body);
    const legalProfile = await this.currentLegalProfile();
    const owned = await this.db.query(
      "SELECT id, name FROM incircle_circles WHERE owner_user_id = $1 AND status <> 'closed' ORDER BY created_at",
      [auth.user.id]
    );
    if (owned.rows.length) {
      throw new AppError("你仍是圈主，请先解散名下圈子再注销账号", {
        statusCode: 409,
        errCode: "OWNED_CIRCLES_EXIST",
        details: { circles: owned.rows.map((circle) => ({ id: circle.id, name: circle.name })) },
      });
    }
    await this.db.withTransaction(async () => {
      await this.db.query("DELETE FROM incircle_account_sessions WHERE user_id = $1", [auth.user.id]);
      await this.db.query("DELETE FROM incircle_ai_reports WHERE user_id = $1", [auth.user.id]);
      await this.db.query("DELETE FROM incircle_ai_consents WHERE user_id = $1", [auth.user.id]);
      await this.db.query("DELETE FROM incircle_ai_conversations WHERE user_id = $1", [auth.user.id]);
      await this.db.query(
        "UPDATE incircle_ai_usage_events SET user_id = NULL, conversation_id = NULL WHERE user_id = $1",
        [auth.user.id]
      );
      await this.db.query(
        `
        UPDATE incircle_circle_members
        SET status = 'exited', exited_at = now(), updated_at = now()
        WHERE user_id = $1 AND status = 'active'
        `,
        [auth.user.id]
      );
      await this.db.query(
        `
        UPDATE incircle_member_cards
        SET name = '已注销用户', avatar_url = '/images/avatar.png', title = '账号已注销',
            profile_note = '该账号已注销，历史活动和账单仅保留必要引用。', tags = '[]'::jsonb,
            updated_at = now()
        WHERE user_id = $1
        `,
        [auth.user.id]
      );
      await this.db.query(
        `
        UPDATE incircle_users SET
          account_name = '',
          account_key = NULL,
          password_hash = NULL,
          password_salt = NULL,
          password_iterations = 0,
          password_digest = '',
          nickname = '已注销用户',
          wechat_nickname = '',
          phone = '',
          title = '',
          profile_note = '',
          avatar_url = '/images/avatar.png',
          profile_completed = false,
          logged_in = false,
          status = 'deleted',
          deleted_at = now(),
          current_circle_id = NULL,
          updated_at = now()
        WHERE id = $1
        `,
        [auth.user.id]
      );
    });
    return this.emptySession(null, legalProfile);
  }

  async createUniqueJoinCode() {
    for (let i = 0; i < 20; i++) {
      const code = createJoinCode();
      const existed = await this.db.query(
        'SELECT id FROM incircle_circles WHERE (join_code COLLATE "C") = ($1::text COLLATE "C") LIMIT 1',
        [code]
      );
      if (!existed.rows.length) return code;
    }
    throw new AppError("邀请码生成失败，请重试", { statusCode: 500, errCode: "JOIN_CODE_FAILED" });
  }

  async createUniqueInviteToken() {
    for (let i = 0; i < 20; i++) {
      const token = createInviteToken();
      const existed = await this.db.query("SELECT id FROM incircle_circles WHERE invite_token = $1 LIMIT 1", [token]);
      if (!existed.rows.length) return token;
    }
    throw new AppError("邀请入口生成失败，请重试", { statusCode: 500, errCode: "INVITE_TOKEN_FAILED" });
  }

  async updateCircleInviteCredentials(circleId) {
    const savepoint = "incircle_invite_rotation_attempt";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const joinCode = await this.createUniqueJoinCode();
      const inviteToken = await this.createUniqueInviteToken();
      await this.db.query(`SAVEPOINT ${savepoint}`);
      try {
        const result = await this.db.query(
          `
          UPDATE incircle_circles
          SET join_code = $2, invite_token = $3, updated_at = now()
          WHERE id = $1
          RETURNING join_code, invite_token
          `,
          [circleId, joinCode, inviteToken]
        );
        await this.db.query(`RELEASE SAVEPOINT ${savepoint}`);
        if (!result.rows.length) {
          throw new AppError("圈子不存在", { statusCode: 404, errCode: "CIRCLE_NOT_FOUND" });
        }
        return result.rows[0];
      } catch (error) {
        await this.db.query(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => {});
        await this.db.query(`RELEASE SAVEPOINT ${savepoint}`).catch(() => {});
        if (error && error.code === "23505") continue;
        throw error;
      }
    }
    throw new AppError("邀请码生成失败，请重试", { statusCode: 500, errCode: "JOIN_CODE_FAILED" });
  }

  async logOperation(circleId, auth, action, targetType, targetId, payload) {
    const actor = auth && auth.user ? auth.user : null;
    await this.db.query(
      `
      INSERT INTO incircle_operation_logs (
        circle_id, actor_user_id, action, target_type, target_id, payload
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      `,
      [
        circleId || null,
        actor ? actor.id : null,
        action,
        targetType || "",
        String(targetId || ""),
        JSON.stringify(
          Object.assign(
            {
              actorName: actor ? actor.nickname || actor.account_name || "用户" : "系统",
            },
            payload || {}
          )
        ),
      ]
    );
  }

  async listMyCircles(body) {
    const auth = await this.requireUser(body);
    const isSuperAdmin = this.isSuperAdmin(auth.identity.openid, auth.user);
    const keyword = normalizeKeyword(body.keyword || body.search);
    const limit = normalizeLimit(body.limit, 3);
    const offset = normalizeOffset(body.offset);
    const params = [auth.user.id];
    const conditions = ["membership.user_id = $1", "membership.status = 'active'"];
    if (keyword) {
      params.push(`%${keyword}%`);
      const index = params.length;
      conditions.push(`(circle.name ILIKE $${index} OR circle.slogan ILIKE $${index} OR circle.notice ILIKE $${index})`);
    }
    const listParams = params.concat([limit, offset]);
    const [listResult, totalsResult, currentResult] = await Promise.all([
      this.db.query(
        `
        SELECT circle.*, membership.id AS membership_id, membership.user_id, membership.role,
               membership.status AS membership_status, membership.joined_at, membership.last_entered_at,
               count(*) OVER()::int AS filtered_total
        FROM incircle_circle_members membership
        JOIN incircle_circles circle ON circle.id = membership.circle_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY COALESCE(membership.last_entered_at, membership.joined_at) DESC,
                 membership.joined_at DESC, circle.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `,
        listParams
      ),
      this.db.query(
        `
        SELECT count(*)::int AS joined_count,
               count(*) FILTER (WHERE role = '圈主')::int AS managed_count,
               (
                 SELECT count(*)::int
                 FROM incircle_circles owned_circle
                 WHERE owned_circle.owner_user_id = $1
               ) AS owned_circle_count
        FROM incircle_circle_members
        WHERE user_id = $1 AND status = 'active'
        `,
        [auth.user.id]
      ),
      auth.user.current_circle_id
        ? this.db.query(
            `
            SELECT circle.*, membership.id AS membership_id, membership.user_id, membership.role,
                   membership.status AS membership_status, membership.joined_at, membership.last_entered_at
            FROM incircle_circle_members membership
            JOIN incircle_circles circle ON circle.id = membership.circle_id
            WHERE membership.user_id = $1 AND membership.circle_id = $2
              AND membership.status = 'active' AND circle.status = 'active'
            LIMIT 1
            `,
            [auth.user.id, auth.user.current_circle_id]
          )
        : Promise.resolve({ rows: [] }),
    ]);
    const currentCircleId = currentResult.rows[0] ? String(currentResult.rows[0].id) : "";
    if (auth.user.current_circle_id && !currentCircleId) {
      await this.db.query("UPDATE incircle_users SET current_circle_id = NULL, updated_at = now() WHERE id = $1", [auth.user.id]);
    }
    const circles = listResult.rows.map((row) => publicCircle(row, row, currentCircleId, { isSuperAdmin }));
    const total = await totalFromWindowPage(
      this.db,
      listResult,
      offset,
      `
      SELECT count(*)::int AS total
      FROM incircle_circle_members membership
      JOIN incircle_circles circle ON circle.id = membership.circle_id
      WHERE ${conditions.join(" AND ")}
      `,
      params
    );
    const totals = totalsResult.rows[0] || {};
    const ownedCircleCount = Number(totals.owned_circle_count || 0);
    const currentCircle = currentResult.rows[0]
      ? publicCircle(currentResult.rows[0], currentResult.rows[0], currentCircleId, { isSuperAdmin })
      : null;
    return {
      user: publicUser(auth.user),
      circles,
      myCircles: circles,
      total,
      limit,
      offset,
      hasMore: offset + circles.length < total,
      joinedCount: Number(totals.joined_count || 0),
      managedCount: Number(totals.managed_count || 0),
      ownedCircleCount,
      circleCreateLimit: MAX_OWNED_CIRCLES_PER_USER,
      canCreateCircle: isSuperAdmin || ownedCircleCount < MAX_OWNED_CIRCLES_PER_USER,
      currentMemberCount: currentCircle ? Number(currentCircle.memberCount || 0) : 0,
      currentCircleId,
      currentCircle,
      hasCircle: !!currentCircleId,
      hasCircles: Number(totals.joined_count || 0) > 0,
      loggedIn: true,
      isSuperAdmin,
    };
  }

  async createCircle(body) {
    const auth = await this.requireUser(body);
    const incoming = body.circle || {};
    const isSuperAdmin = this.isSuperAdmin(auth.identity.openid, auth.user);
    return this.db.withTransaction(async () => {
      if (!isSuperAdmin) {
        await this.db.query("SELECT id FROM incircle_users WHERE id = $1 FOR UPDATE", [auth.user.id]);
        const ownedResult = await this.db.query(
          "SELECT count(*)::int AS total FROM incircle_circles WHERE owner_user_id = $1",
          [auth.user.id]
        );
        const ownedCount = Number((ownedResult.rows[0] && ownedResult.rows[0].total) || 0);
        if (ownedCount >= MAX_OWNED_CIRCLES_PER_USER) {
          throw new AppError("已达创建上限", {
            statusCode: 409,
            errCode: "CIRCLE_CREATE_LIMIT_REACHED",
            details: {
              limit: MAX_OWNED_CIRCLES_PER_USER,
              ownedCount,
            },
          });
        }
      }

      const circleName = String(incoming.name || "新的熟人圈").trim() || "新的熟人圈";
      const circleNotice = String(incoming.notice || "欢迎加入新圈子。").trim();
      const circleSlogan = String(incoming.slogan || "把活动、AA、投票和资料放回一个有秩序的地方。").trim();
      const circleMetadata = JSON.stringify({
        ownerOpenid: auth.identity.openid,
        ownerName: auth.user.nickname || "微信用户",
      });
      let circle = null;
      for (let attempt = 0; attempt < 20 && !circle; attempt += 1) {
        const joinCode = await this.createUniqueJoinCode();
        const inviteToken = await this.createUniqueInviteToken();
        const circleResult = await this.db.query(
          `
          INSERT INTO incircle_circles (
            owner_user_id, join_code, invite_token, name, notice, slogan, status, member_count, raw_data
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'active', 1, $7::jsonb)
          ON CONFLICT DO NOTHING
          RETURNING *
          `,
          [auth.user.id, joinCode, inviteToken, circleName, circleNotice, circleSlogan, circleMetadata]
        );
        circle = circleResult.rows[0] || null;
      }
      if (!circle) {
        throw new AppError("邀请码生成失败，请重试", { statusCode: 500, errCode: "JOIN_CODE_FAILED" });
      }
      const memberIdText = await reserveCircleMemberNumber(this.db, circle.id);
      const membership = await this.db.query(
        `
        INSERT INTO incircle_circle_members (
          circle_id, user_id, openid, member_name, member_id_text, role, status, joined_at, last_entered_at
        )
        VALUES ($1, $2, $3, $4, $5, '圈主', 'active', now(), now())
        ON CONFLICT (circle_id, user_id) DO UPDATE SET
          status = 'active', role = '圈主', member_name = EXCLUDED.member_name,
          member_id_text = CASE
            WHEN btrim(incircle_circle_members.member_id_text) = '' THEN EXCLUDED.member_id_text
            ELSE incircle_circle_members.member_id_text
          END,
          last_entered_at = now(), updated_at = now()
        RETURNING *
        `,
        [circle.id, auth.user.id, auth.identity.openid, auth.user.nickname || "微信用户", memberIdText]
      );
      await this.db.query(
        `
        INSERT INTO incircle_member_cards (
          circle_id, user_id, member_id, openid, role, name, avatar_url, title, profile_note
        )
        VALUES ($1, $2, $3, $4, '圈主', $5, $6, $7, $8)
        ON CONFLICT (circle_id, user_id) DO UPDATE SET
          role = '圈主', name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url, updated_at = now()
        `,
        [
          circle.id,
          auth.user.id,
          membership.rows[0].id,
          auth.identity.openid,
          auth.user.nickname || "微信用户",
          auth.user.avatar_url || "/images/avatar.png",
          auth.user.title || "圈主",
          auth.user.profile_note || "",
        ]
      );
      await this.ensureDefaultDocsForCircle(circle.id, auth.user.id);
      await this.ensureDefaultScoreRulesForCircle(circle.id);
      const userResult = await this.db.query(
        "UPDATE incircle_users SET current_circle_id = $2, updated_at = now() WHERE id = $1 RETURNING *",
        [auth.user.id, circle.id]
      );
      await this.logOperation(circle.id, auth, "创建圈子", "circle", circle.id, { circleName: circle.name });
      return this.buildSession(userResult.rows[0]);
    });
  }

  async switchCircle(body) {
    const auth = await this.requireUser(body);
    const circleId = String(body.circleId || "");
    const result = await this.db.query(
      `
      SELECT m.*, c.status AS circle_status
      FROM incircle_circle_members m
      JOIN incircle_circles c ON c.id = m.circle_id
      WHERE m.user_id = $1 AND m.circle_id = $2 AND m.status = 'active'
      LIMIT 1
      `,
      [auth.user.id, circleId]
    );
    const membership = result.rows[0];
    if (!membership) throw new AppError("你还没有加入这个圈子", { statusCode: 403, errCode: "NOT_IN_CIRCLE" });
    if (membership.circle_status !== "active") {
      throw new AppError("这个圈子暂不可进入", { statusCode: 403, errCode: "CIRCLE_DISABLED" });
    }
    return this.db.withTransaction(async () => {
      await this.db.query(
        "UPDATE incircle_circle_members SET last_entered_at = now(), updated_at = now() WHERE id = $1",
        [membership.id]
      );
      const updated = await this.db.query(
        "UPDATE incircle_users SET current_circle_id = $2, updated_at = now() WHERE id = $1 RETURNING *",
        [auth.user.id, circleId]
      );
      return this.buildSession(updated.rows[0]);
    });
  }

  async findCircleByInvite(body, options) {
    const inviteToken = normalizeInviteToken(body && body.inviteToken);
    const joinCode = normalizeJoinCode(body && body.joinCode);
    const required = !!(options && options.required);
    if (inviteToken) {
      if (!isValidInviteToken(inviteToken)) {
        throw new AppError("邀请入口格式无效", { statusCode: 400, errCode: "INVALID_INVITE_TOKEN" });
      }
      const result = await this.db.query("SELECT * FROM incircle_circles WHERE invite_token = $1 LIMIT 1", [inviteToken]);
      return { inviteToken, joinCode: result.rows[0] ? result.rows[0].join_code || "" : "", circle: result.rows[0] || null };
    }
    if (!joinCode) {
      if (required) throw new AppError("请输入邀请码", { statusCode: 400, errCode: "JOIN_CODE_REQUIRED" });
      return { inviteToken: "", joinCode: "", circle: null };
    }
    if (!isValidJoinCode(joinCode)) {
      throw new AppError("邀请码应为 8 位，并严格区分大小写", { statusCode: 400, errCode: "INVALID_JOIN_CODE" });
    }
    const result = await this.db.query(
      'SELECT * FROM incircle_circles WHERE (join_code COLLATE "C") = ($1::text COLLATE "C") LIMIT 1',
      [joinCode]
    );
    return { inviteToken: "", joinCode, circle: result.rows[0] || null };
  }

  async joinPreview(body) {
    const invite = await this.findCircleByInvite(body, { required: false });
    return {
      joinCode: invite.circle ? invite.circle.join_code || invite.joinCode : invite.joinCode,
      circle: invite.circle ? publicCircle(invite.circle, null, "") : null,
    };
  }

  async joinCircle(body) {
    const auth = await this.requireUser(body);
    const invite = await this.findCircleByInvite(body, { required: true });
    const circle = invite.circle;
    if (!circle) {
      throw new AppError(invite.inviteToken ? "邀请入口已失效" : "没有找到这个圈子", {
        statusCode: 404,
        errCode: "CIRCLE_NOT_FOUND",
      });
    }
    if (circle.status !== "active") throw new AppError("这个圈子暂时不能加入", { statusCode: 403, errCode: "CIRCLE_DISABLED" });
    return this.db.withTransaction(async () => {
      const existingMembership = await this.db.query(
        "SELECT member_id_text FROM incircle_circle_members WHERE circle_id = $1 AND user_id = $2 LIMIT 1",
        [circle.id, auth.user.id]
      );
      const memberIdText = existingMembership.rows[0] && String(existingMembership.rows[0].member_id_text || "").trim()
        ? existingMembership.rows[0].member_id_text
        : await reserveCircleMemberNumber(this.db, circle.id);
      const membership = await this.db.query(
        `
        INSERT INTO incircle_circle_members (
          circle_id, user_id, openid, member_name, member_id_text, role, status, joined_at, last_entered_at
        )
        VALUES ($1, $2, $3, $4, $5, '成员', 'active', now(), now())
        ON CONFLICT (circle_id, user_id) DO UPDATE SET
          status = 'active', role = incircle_circle_members.role, member_name = EXCLUDED.member_name,
          member_id_text = CASE
            WHEN btrim(incircle_circle_members.member_id_text) = '' THEN EXCLUDED.member_id_text
            ELSE incircle_circle_members.member_id_text
          END,
          last_entered_at = now(), updated_at = now()
        RETURNING *
        `,
        [circle.id, auth.user.id, auth.identity.openid, auth.user.nickname || "微信用户", memberIdText]
      );
      await this.db.query(
        `
        INSERT INTO incircle_member_cards (
          circle_id, user_id, member_id, openid, role, name, avatar_url, title, profile_note
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (circle_id, user_id) DO UPDATE SET
          role = EXCLUDED.role, name = EXCLUDED.name, avatar_url = EXCLUDED.avatar_url, updated_at = now()
        `,
        [
          circle.id,
          auth.user.id,
          membership.rows[0].id,
          auth.identity.openid,
          normalizeMemberRole(membership.rows[0].role),
          auth.user.nickname || "微信用户",
          auth.user.avatar_url || "/images/avatar.png",
          auth.user.title || "成员",
          auth.user.profile_note || "",
        ]
      );
      await this.db.query(
        `
        UPDATE incircle_circles SET
          member_count = (SELECT count(*) FROM incircle_circle_members WHERE circle_id = $1 AND status = 'active'),
          updated_at = now()
        WHERE id = $1
        `,
        [circle.id]
      );
      const userResult = await this.db.query(
        "UPDATE incircle_users SET current_circle_id = $2, updated_at = now() WHERE id = $1 RETURNING *",
        [auth.user.id, circle.id]
      );
      await this.logOperation(circle.id, auth, "加入圈子", "member", membership.rows[0].id, {
        circleName: circle.name,
      });
      return this.buildSession(userResult.rows[0]);
    });
  }

  async circleSettings(body) {
    const auth = await this.requireUser(body);
    const circleId = String(body.circleId || auth.user.current_circle_id || "");
    const circleResult = await this.db.query("SELECT * FROM incircle_circles WHERE id = $1 LIMIT 1", [circleId]);
    const circle = circleResult.rows[0];
    if (!circle) throw new AppError("圈子不存在", { statusCode: 404, errCode: "CIRCLE_NOT_FOUND" });
    const membershipResult = await this.db.query(
      "SELECT * FROM incircle_circle_members WHERE circle_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1",
      [circleId, auth.user.id]
    );
    const membership = membershipResult.rows[0];
    const isSuperAdmin = this.isSuperAdmin(auth.identity.openid, auth.user);
    if (!membership && !isSuperAdmin) {
      throw new AppError("你不是这个圈子的成员", { statusCode: 403, errCode: "NOT_IN_CIRCLE" });
    }
    const canManage = this.canManageCircle(auth, membership);
    const [membersResult, platformSettings] = await Promise.all([
      this.db.query(
        `
        SELECT m.*, u.nickname, u.avatar_url,
               card.title AS card_title, card.profile_note AS card_profile_note
        FROM incircle_circle_members m
        JOIN incircle_users u ON u.id = m.user_id
        LEFT JOIN incircle_member_cards card ON card.circle_id = m.circle_id AND card.user_id = m.user_id
        WHERE m.circle_id = $1 AND m.status = 'active'
        ORDER BY CASE WHEN m.role = '圈主' THEN 0 ELSE 1 END, m.joined_at ASC
        `,
        [circleId]
      ),
      this.platformSettings(),
    ]);
    return {
      circle: publicCircle(circle, membership, circleId, { isSuperAdmin }),
      members: membersResult.rows.map(publicMember),
      canManage,
      canExit: !!(membership && !isOwnerRole(membership.role)),
      canDissolve: !!(membership && isOwnerRole(membership.role)),
      inviteCode: circle.join_code || "",
      inviteToken: circle.invite_token || "",
      invitePath: invitePagePath(circle.invite_token),
      platformAiEnabled: platformSettings.circleAiEnabled,
    };
  }

  async circleMemberDetail(body) {
    const auth = await this.requireUser(body);
    const circleId = String(body.circleId || auth.user.current_circle_id || "");
    const membershipId = String(body.membershipId || body.id || "");
    if (!isUuid(circleId) || !isUuid(membershipId)) {
      throw new AppError("成员参数无效", { statusCode: 400, errCode: "INVALID_MEMBER_ID" });
    }
    const viewerResult = await this.db.query(
      "SELECT * FROM incircle_circle_members WHERE circle_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1",
      [circleId, auth.user.id]
    );
    const viewer = viewerResult.rows[0];
    const platformAdmin = this.isSuperAdmin(auth.identity.openid, auth.user);
    if (!viewer && !platformAdmin) {
      throw new AppError("成员不存在或无权查看", { statusCode: 404, errCode: "MEMBER_NOT_FOUND" });
    }
    const result = await this.db.query(
      `
      SELECT membership.*, circle.name AS circle_name,
             users.nickname, users.avatar_url,
             card.title AS card_title, card.profile_note AS card_profile_note,
             card.tags, card.payload AS card_payload
      FROM incircle_circle_members membership
      JOIN incircle_circles circle ON circle.id = membership.circle_id
      JOIN incircle_users users ON users.id = membership.user_id
      LEFT JOIN incircle_member_cards card
        ON card.circle_id = membership.circle_id AND card.user_id = membership.user_id
      WHERE membership.id = $1 AND membership.circle_id = $2 AND membership.status = 'active'
      LIMIT 1
      `,
      [membershipId, circleId]
    );
    const row = result.rows[0];
    if (!row) throw new AppError("成员不存在或无权查看", { statusCode: 404, errCode: "MEMBER_NOT_FOUND" });
    const payload = row.card_payload && typeof row.card_payload === "object" ? row.card_payload : {};
    const role = normalizeMemberRole(row.role);
    return {
      id: String(row.id),
      circle: { id: circleId, name: row.circle_name || "圈子" },
      name: row.member_name || row.nickname || "微信用户",
      avatar: safeAvatarUrl(row.avatar_url, "/images/avatar.png"),
      title: row.card_title || "",
      profileNote: row.card_profile_note || "",
      memberId: row.member_id_text || "",
      role,
      roleClass: roleClass(role),
      joinedAt: row.joined_at,
      tags: sanitizeTimelineArray(row.tags),
      skills: sanitizeTimelineArray(payload.skills),
      interests: sanitizeTimelineArray(payload.interests),
      canRemove: !!(
        (viewer && isOwnerRole(viewer.role))
        && !isOwnerRole(role)
        && String(row.user_id) !== String(auth.user.id)
      ),
    };
  }

  async updateCircleInfo(body) {
    const auth = await this.requireUser(body);
    const circleId = String(body.circleId || "");
    const settings = await this.circleSettings(Object.assign({}, body, { circleId }));
    if (!settings.canManage) throw new AppError("没有权限编辑这个圈子", { statusCode: 403, errCode: "FORBIDDEN" });
    const patch = body.patch || {};
    await this.db.query(
      `
      UPDATE incircle_circles SET
        name = COALESCE(NULLIF($2, ''), name),
        notice = $3,
        slogan = $4,
        updated_at = now()
      WHERE id = $1
      `,
      [
        circleId,
        String(patch.name || "").trim(),
        String(patch.notice || "").trim(),
        String(patch.slogan || "").trim(),
      ]
    );
    await this.logOperation(circleId, auth, "更新圈子资料", "circle", circleId, patch);
    return this.circleSettings(Object.assign({}, body, { circleId }));
  }

  async rotateInviteCode(body) {
    const auth = await this.requireUser(body);
    const circleId = String(body.circleId || "");
    if (!isUuid(circleId)) {
      throw new AppError("圈子参数无效", { statusCode: 400, errCode: "INVALID_CIRCLE_ID" });
    }
    const rotated = await this.db.withTransaction(async () => {
      const circleResult = await this.db.query(
        "SELECT id, name, join_code, invite_token FROM incircle_circles WHERE id = $1 FOR UPDATE",
        [circleId]
      );
      const circle = circleResult.rows[0];
      if (!circle) throw new AppError("圈子不存在", { statusCode: 404, errCode: "CIRCLE_NOT_FOUND" });
      const membershipResult = await this.db.query(
        "SELECT role FROM incircle_circle_members WHERE circle_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1",
        [circleId, auth.user.id]
      );
      const membership = membershipResult.rows[0];
      if (!this.canManageCircle(auth, membership)) {
        throw new AppError("只有圈主或超管可以更换邀请码", { statusCode: 403, errCode: "FORBIDDEN" });
      }

      const qrResult = await this.db.query(
        "SELECT relative_path FROM incircle_circle_qr_codes WHERE circle_id = $1 LIMIT 1",
        [circleId]
      );
      await this.updateCircleInviteCredentials(circleId);
      await this.db.query("DELETE FROM incircle_circle_qr_codes WHERE circle_id = $1", [circleId]);
      await this.logOperation(circleId, auth, "更换圈子邀请码", "circle", circleId, {
        hadQrCode: !!qrResult.rows[0],
      });
      return {
        oldQrPath: qrResult.rows[0] ? managedUploadRelativePath(qrResult.rows[0].relative_path) : "",
      };
    });

    const cleanup = bestEffortCleanupManagedUploads(this.config, {
      relativePaths: rotated.oldQrPath ? [rotated.oldQrPath] : [],
    });
    if (cleanup.failed.length) {
      await this.logOperation(circleId, auth, "邀请码二维码清理待处理", "circle", circleId, {
        failedCount: cleanup.failed.length,
      }).catch(() => {});
    }
    const settings = await this.circleSettings(Object.assign({}, body, { circleId }));
    return Object.assign({}, settings, { mediaCleanupFailedCount: cleanup.failed.length });
  }

  async exitCircle(body) {
    const auth = await this.requireUser(body);
    const circleId = String(body.circleId || "");
    const membershipResult = await this.db.query(
      "SELECT * FROM incircle_circle_members WHERE circle_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1",
      [circleId, auth.user.id]
    );
    const membership = membershipResult.rows[0];
    if (!membership) throw new AppError("你不在这个圈子里", { statusCode: 403, errCode: "NOT_IN_CIRCLE" });
    if (isOwnerRole(membership.role)) {
      throw new AppError("圈主不能退出圈子，请先解散圈子", { statusCode: 403, errCode: "OWNER_CANNOT_EXIT" });
    }
    return this.db.withTransaction(async () => {
      await this.db.query("DELETE FROM incircle_ai_reports WHERE circle_id = $1 AND user_id = $2", [circleId, auth.user.id]);
      await this.db.query("DELETE FROM incircle_ai_consents WHERE circle_id = $1 AND user_id = $2", [circleId, auth.user.id]);
      await this.db.query("DELETE FROM incircle_ai_conversations WHERE circle_id = $1 AND user_id = $2", [circleId, auth.user.id]);
      await this.db.query(
        "UPDATE incircle_circle_members SET status = 'exited', exited_at = now(), updated_at = now() WHERE id = $1",
        [membership.id]
      );
      await this.db.query(
        `
        UPDATE incircle_circles SET
          member_count = (SELECT count(*) FROM incircle_circle_members WHERE circle_id = $1 AND status = 'active'),
          updated_at = now()
        WHERE id = $1
        `,
        [circleId]
      );
      const nextMemberships = await this.getActiveMemberships(auth.user.id);
      const nextCircleId = String(auth.user.current_circle_id || "") === circleId ? null : auth.user.current_circle_id || null;
      const userResult = await this.db.query(
        "UPDATE incircle_users SET current_circle_id = $2, updated_at = now() WHERE id = $1 RETURNING *",
        [auth.user.id, nextCircleId]
      );
      await this.logOperation(circleId, auth, "退出圈子", "member", membership.id, {
        role: normalizeMemberRole(membership.role),
      });
      return Object.assign(await this.buildSession(userResult.rows[0]), { hasCircles: nextMemberships.length > 0 });
    });
  }

  async dissolveCircle(body) {
    const auth = await this.requireUser(body);
    const circleId = String(body.circleId || "");
    const settings = await this.circleSettings(Object.assign({}, body, { circleId }));
    if (!settings.canDissolve) throw new AppError("只有圈主可以解散圈子", { statusCode: 403, errCode: "FORBIDDEN" });
    const mediaPaths = await this.collectCircleUploadPaths([circleId]);
    const result = await this.db.withTransaction(async () => {
      const locked = await this.db.query("SELECT id FROM incircle_circles WHERE id = $1 FOR UPDATE", [circleId]);
      if (!locked.rows[0]) throw new AppError("圈子不存在", { statusCode: 404, errCode: "CIRCLE_NOT_FOUND" });
      await this.logOperation(circleId, auth, "解散圈子", "circle", circleId, {
        circleName: settings.circle && settings.circle.name,
      });
      await this.db.query("DELETE FROM incircle_circles WHERE id = $1", [circleId]);
      const nextMemberships = await this.getActiveMemberships(auth.user.id);
      const nextCircleId = String(auth.user.current_circle_id || "") === circleId ? null : auth.user.current_circle_id || null;
      const userResult = await this.db.query(
        "UPDATE incircle_users SET current_circle_id = $2, updated_at = now() WHERE id = $1 RETURNING *",
        [auth.user.id, nextCircleId]
      );
      return Object.assign(await this.buildSession(userResult.rows[0]), {
        hasCircles: nextMemberships.length > 0,
        deletedCircleId: circleId,
      });
    });
    const cleanup = bestEffortCleanupManagedUploads(this.config, { relativePaths: mediaPaths, circleIds: [circleId] });
    if (cleanup.failed.length) {
      await this.logOperation(null, auth, "圈子媒体清理待处理", "circle", circleId, {
        failedCount: cleanup.failed.length,
      }).catch(() => {});
    }
    return Object.assign({}, result, { mediaCleanupFailedCount: cleanup.failed.length });
  }

  async requireCircleContext(body, options) {
    const auth = await this.requireUser(body);
    const circleId = String(body.circleId || auth.user.current_circle_id || "");
    if (!circleId) throw new AppError("请先加入或创建圈子", { statusCode: 400, errCode: "CIRCLE_REQUIRED" });
    const result = await this.db.query(
      `
      SELECT m.*, c.status AS circle_status, c.name AS circle_name
      FROM incircle_circle_members m
      JOIN incircle_circles c ON c.id = m.circle_id
      WHERE m.user_id = $1 AND m.circle_id = $2 AND m.status = 'active'
      LIMIT 1
      `,
      [auth.user.id, circleId]
    );
    const membership = result.rows[0];
    if (!membership) {
      const allowSuperAdmin = !!(options && options.allowSuperAdmin);
      const superAdminAccess = allowSuperAdmin && this.isSuperAdmin(auth.identity && auth.identity.openid, auth.user);
      if (!superAdminAccess) {
        throw new AppError("你还没有加入这个圈子", { statusCode: 403, errCode: "NOT_IN_CIRCLE" });
      }
      const circleResult = await this.db.query(
        "SELECT id, status, name FROM incircle_circles WHERE id = $1 LIMIT 1",
        [circleId]
      );
      const circle = circleResult.rows[0];
      if (!circle) throw new AppError("圈子不存在或已删除", { statusCode: 404, errCode: "CIRCLE_NOT_FOUND" });
      return {
        auth,
        circleId,
        membership: null,
        memberCard: null,
        superAdminAccess: true,
        circleStatus: circle.status,
        circleName: circle.name,
      };
    }
    if (membership.circle_status !== "active") {
      throw new AppError("这个圈子暂不可进入", { statusCode: 403, errCode: "CIRCLE_DISABLED" });
    }
    const memberCard = await this.ensureMemberCard(circleId, auth.user, membership);
    return { auth, circleId, membership, memberCard };
  }

  async ensureMemberCard(circleId, user, membership) {
    const existed = await this.db.query(
      "SELECT * FROM incircle_member_cards WHERE circle_id = $1 AND user_id = $2 LIMIT 1",
      [circleId, user.id]
    );
    if (existed.rows[0]) return memberCardFromRow(existed.rows[0], user, membership);
    const result = await this.db.query(
      `
      INSERT INTO incircle_member_cards (
        circle_id, user_id, member_id, openid, role, name, avatar_url, title, profile_note, payload
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}'::jsonb)
      RETURNING *
      `,
      [
        circleId,
        user.id,
        membership.id,
        user.openid,
        normalizeMemberRole(membership.role),
        user.nickname || "微信用户",
        user.avatar_url || "/images/avatar.png",
        user.title || normalizeMemberRole(membership.role),
        user.profile_note || "",
      ]
    );
    return memberCardFromRow(result.rows[0], user, membership);
  }

  async circleMonthlyHonors(circleId) {
    const monthStartSql = "(date_trunc('month', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')";
    const [monthlyScoreResult, monthlyOrganizerResult, monthlyCheckinResult] = await Promise.all([
      this.db.query(
        `
        SELECT card.name, sum(logs.delta)::int AS value
        FROM incircle_score_logs logs
        JOIN incircle_member_cards card ON card.id = logs.member_card_id
        WHERE logs.circle_id = $1 AND logs.created_at >= ${monthStartSql}
        GROUP BY card.id, card.name
        ORDER BY value DESC, card.name ASC
        LIMIT 1
        `,
        [circleId]
      ),
      this.db.query(
        `
        SELECT card.name, count(*)::int AS value
        FROM incircle_activities activity
        JOIN incircle_member_cards card ON card.circle_id = activity.circle_id AND card.user_id = activity.created_by_user_id
        WHERE activity.circle_id = $1 AND activity.created_at >= ${monthStartSql}
        GROUP BY card.id, card.name
        ORDER BY value DESC, card.name ASC
        LIMIT 1
        `,
        [circleId]
      ),
      this.db.query(
        `
        SELECT card.name, count(*)::int AS value
        FROM incircle_checkin_records record
        JOIN incircle_member_cards card ON card.id = record.member_card_id
        WHERE record.circle_id = $1 AND record.created_at >= ${monthStartSql}
        GROUP BY card.id, card.name
        ORDER BY value DESC, card.name ASC
        LIMIT 1
        `,
        [circleId]
      ),
    ]);
    return [
      monthlyScoreResult.rows[0] && { label: "本月积分王", name: monthlyScoreResult.rows[0].name },
      monthlyOrganizerResult.rows[0] && { label: "本月组织者", name: monthlyOrganizerResult.rows[0].name },
      monthlyCheckinResult.rows[0] && { label: "本月打卡星", name: monthlyCheckinResult.rows[0].name },
    ].filter(Boolean);
  }

  async listMemberDirectory(circleId) {
    const result = await this.db.query(
      `
      SELECT card.*, u.nickname, u.avatar_url, u.openid AS user_openid, m.role AS member_role
      FROM incircle_member_cards card
      JOIN incircle_users u ON u.id = card.user_id
      LEFT JOIN incircle_circle_members m ON m.circle_id = card.circle_id AND m.user_id = card.user_id
      WHERE card.circle_id = $1
        AND (m.status IS NULL OR m.status = 'active')
      ORDER BY card.created_at ASC
      `,
      [circleId]
    );
    return result.rows.map((row) =>
      memberCardFromRow(
        Object.assign({}, row, { openid: row.openid || row.user_openid }),
        { id: row.user_id, openid: row.user_openid, nickname: row.nickname, avatar_url: row.avatar_url },
        { role: row.member_role || row.role }
      )
    );
  }

  async listMembersData(circleId, userId) {
    const directory = await this.listMemberDirectory(circleId);
    const [membersWithSocialState, weeklyResult, scoreRulesResult, scoreLogsResult, monthlyHonors] = await Promise.all([
      this.hydrateMemberSocialState(directory, circleId, userId),
      this.db.query(
        `
        SELECT COALESCE(member_card_id, card.id) AS member_card_id, sum(delta)::int AS score
        FROM incircle_score_logs logs
        LEFT JOIN incircle_member_cards card ON card.circle_id = logs.circle_id AND card.user_id = logs.user_id
        WHERE logs.circle_id = $1
          AND logs.created_at >= (date_trunc('week', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')
        GROUP BY COALESCE(member_card_id, card.id)
        `,
        [circleId]
      ),
      this.db.query(
        "SELECT * FROM incircle_score_rules WHERE circle_id = $1 OR circle_id IS NULL ORDER BY created_at ASC",
        [circleId]
      ),
      this.db.query(
        `
        SELECT l.*,
          COALESCE(card.name, user_card.name) AS member_name,
          COALESCE(card.avatar_url, user_card.avatar_url, users.avatar_url) AS member_avatar,
          count(*) OVER()::int AS total_count
        FROM incircle_score_logs l
        LEFT JOIN incircle_member_cards card ON card.id = l.member_card_id
        LEFT JOIN incircle_member_cards user_card ON user_card.circle_id = l.circle_id AND user_card.user_id = l.user_id
        LEFT JOIN incircle_users users ON users.id = COALESCE(l.user_id, card.user_id, user_card.user_id)
        WHERE l.circle_id = $1
        ORDER BY l.created_at DESC
        LIMIT 6
        `,
        [circleId]
      ),
      this.circleMonthlyHonors(circleId),
    ]);
    const weeklyByMember = weeklyResult.rows.reduce((map, row) => {
      if (row.member_card_id) map[String(row.member_card_id)] = Number(row.score || 0);
      return map;
    }, {});
    const members = membersWithSocialState.map((member) =>
      Object.assign({}, member, { weeklyScore: weeklyByMember[member.id] || 0 })
    );
    const scoreLogTotal = scoreLogsResult.rows[0] ? Number(scoreLogsResult.rows[0].total_count || 0) : 0;
    const scoreRules = scoreRulesResult.rows.map(publicScoreRule).filter((rule) => rule && rule.enabled !== false);
    return {
      members,
      myCard: members.find((member) => String(member.userId) === String(userId)) || null,
      scoreRules: scoreRules.concat(funBadgeRules()),
      scoreLogs: scoreLogsResult.rows.map((row) =>
        Object.assign(publicScoreLog(row), {
          memberName: row.member_name || (row.payload && row.payload.memberName) || "",
          avatar: safeAvatarUrl(row.member_avatar || (row.payload && row.payload.avatar), "/images/avatar.png"),
        })
      ),
      scoreLogTotal,
      hasMoreScoreLogs: scoreLogTotal > 5,
      monthlyHonors,
    };
  }

  async scoreLogs(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    const keyword = normalizeKeyword(body.keyword || body.search);
    const memberId = String(body.memberId || "").trim();
    const limit = normalizeLimit(body.limit, 20);
    const offset = normalizeOffset(body.offset);
    const params = [ctx.circleId];
    const conditions = ["l.circle_id = $1"];

    if (memberId && memberId !== "all") {
      if (!isUuid(memberId)) throw new AppError("成员筛选参数无效", { statusCode: 400, errCode: "INVALID_MEMBER_ID" });
      params.push(memberId);
      const index = params.length;
      conditions.push(
        `(l.member_card_id = $${index}::uuid OR l.user_id = (SELECT user_id FROM incircle_member_cards WHERE id = $${index}::uuid LIMIT 1))`
      );
    }

    if (keyword) {
      params.push(`%${keyword}%`);
      const index = params.length;
      conditions.push(
        `(l.reason ILIKE $${index} OR l.payload::text ILIKE $${index} OR card.name ILIKE $${index} OR user_card.name ILIKE $${index} OR users.nickname ILIKE $${index})`
      );
    }

    const whereSql = conditions.join(" AND ");
    const listParams = params.concat([limit, offset]);
    const logsResult = await this.db.query(
      `
      SELECT l.*,
        COALESCE(card.name, user_card.name) AS member_name,
        COALESCE(card.avatar_url, user_card.avatar_url, users.avatar_url) AS member_avatar,
        users.nickname AS user_name
      FROM incircle_score_logs l
      LEFT JOIN incircle_member_cards card ON card.id = l.member_card_id
      LEFT JOIN incircle_member_cards user_card ON user_card.circle_id = l.circle_id AND user_card.user_id = l.user_id
      LEFT JOIN incircle_users users ON users.id = COALESCE(l.user_id, card.user_id, user_card.user_id)
      WHERE ${whereSql}
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `,
      listParams
    );
    const totalResult = await this.db.query(
      `
      SELECT count(*)::int AS total
      FROM incircle_score_logs l
      LEFT JOIN incircle_member_cards card ON card.id = l.member_card_id
      LEFT JOIN incircle_member_cards user_card ON user_card.circle_id = l.circle_id AND user_card.user_id = l.user_id
      LEFT JOIN incircle_users users ON users.id = COALESCE(l.user_id, card.user_id, user_card.user_id)
      WHERE ${whereSql}
      `,
      params
    );
    const membersResult = await this.db.query(
      `
      SELECT card.id, card.user_id, card.name, card.avatar_url, users.nickname, users.avatar_url AS user_avatar
      FROM incircle_member_cards card
      LEFT JOIN incircle_users users ON users.id = card.user_id
      LEFT JOIN incircle_circle_members members ON members.circle_id = card.circle_id AND members.user_id = card.user_id
      WHERE card.circle_id = $1
        AND (members.status IS NULL OR members.status = 'active')
      ORDER BY card.name ASC, users.nickname ASC
      `,
      [ctx.circleId]
    );
    const total = totalResult.rows[0] ? totalResult.rows[0].total || 0 : 0;
    return {
      logs: logsResult.rows.map((row) =>
        Object.assign(publicScoreLog(row), {
          memberName: row.member_name || row.user_name || (row.payload && row.payload.memberName) || "成员",
          avatar: safeAvatarUrl(row.member_avatar || (row.payload && row.payload.avatar), "/images/avatar.png"),
        })
      ),
      members: membersResult.rows.map((row) => ({
        id: String(row.id),
        memberCardId: String(row.id),
        userId: row.user_id ? String(row.user_id) : "",
        name: row.name || row.nickname || "成员",
        avatar: safeAvatarUrl(row.avatar_url || row.user_avatar, "/images/avatar.png"),
      })),
      total,
      limit,
      offset,
      hasMore: offset + logsResult.rows.length < total,
    };
  }

  businessTable(kind) {
    const map = {
      activities: "incircle_activities",
      bills: "incircle_bills",
      votes: "incircle_votes",
      checkins: "incircle_checkins",
      docs: "incircle_docs",
      decisions: "incircle_decision_makers",
    };
    const table = map[kind];
    if (!table) throw new AppError("未知业务类型", { statusCode: 400, errCode: "INVALID_BUSINESS_KIND" });
    return table;
  }

  canManageBusiness(ctx) {
    return !!(ctx && this.canManageCircle(ctx.auth, ctx.membership));
  }

  businessEditDisabledReason(row, kind) {
    if (!row) return `${businessKindLabel(kind)}不存在或已删除`;
    const payload = row.payload || {};
    const status = String(row.status || payload.status || "");
    if (payload.systemManaged) return "系统内置资料不可编辑";
    if (kind === "activities" && CLOSED_ACTIVITY_STATUSES.has(status)) return "活动已经结束，内容已锁定";
    if (kind === "bills" && CLOSED_BILL_STATUSES.has(status)) return "AA 已结清，不能再修改账目";
    if (kind === "votes") {
      const deadlineAt = row.deadline_at || payload.deadlineAt || payload.deadlineAtMs || payload.deadline;
      const parsedDeadline = deadlineAt ? parseBeijingDateTime(deadlineAt, payload.createdAt || row.created_at) : null;
      const deadlineMs = parsedDeadline ? parsedDeadline.getTime() : 0;
      if (CLOSED_VOTE_STATUSES.has(status) || (deadlineMs && deadlineMs <= Date.now())) {
        return "投票已经截止，内容已锁定";
      }
      if (normalizeArray(payload.records).length || normalizeArray(payload.vetoRecords).length) {
        return "已有成员参与投票，不能再修改规则或选项";
      }
    }
    if (kind === "checkins") {
      if (CLOSED_CHECKIN_STATUSES.has(status)) return "打卡挑战已经结束，内容已锁定";
      if (normalizeArray(payload.records).length) return "已有打卡记录，不能再修改挑战规则";
    }
    if (kind === "docs" && CLOSED_DOC_STATUSES.has(status)) return "资料已经归档，不能再编辑";
    return "";
  }

  canEditBusinessActor(row, ctx, kind) {
    if (!row || !ctx || !ctx.auth || !ctx.auth.user) return false;
    if (this.canManageCircle(ctx.auth, ctx.membership)) return true;
    if (row.created_by_user_id && String(row.created_by_user_id) === String(ctx.auth.user.id)) return true;
    const payload = row.payload || {};
    const openid = (ctx.auth.user && ctx.auth.user.openid) || (ctx.auth.identity && ctx.auth.identity.openid) || "";
    if (openid && valueListContains(businessOwnerOpenids(payload), openid)) return true;
    if (!row.created_by_user_id && ctx.memberCard && ctx.memberCard.name) {
      return valueListContains(businessOwnerNames(kind, payload), ctx.memberCard.name);
    }
    return false;
  }

  canEditBusinessRow(row, ctx, kind) {
    return this.canEditBusinessActor(row, ctx, kind) && !this.businessEditDisabledReason(row, kind);
  }

  assertCanEditBusinessRow(row, ctx, kind) {
    if (!this.canEditBusinessActor(row, ctx, kind)) {
      throw new AppError(`只有创建人、圈主或超管可以编辑${businessKindLabel(kind)}`, {
        statusCode: 403,
        errCode: "FORBIDDEN",
      });
    }
    const reason = this.businessEditDisabledReason(row, kind);
    if (reason) {
      throw new AppError(reason, {
        statusCode: 409,
        errCode: "BUSINESS_EDIT_LOCKED",
      });
    }
  }

  canDeleteBusinessRow(row, ctx, kind) {
    if (!row || !ctx || !ctx.auth || !ctx.auth.user) return false;
    const payload = row.payload || {};
    if (payload.systemManaged) return false;
    if (this.canManageBusiness(ctx)) return true;
    if (row.created_by_user_id && String(row.created_by_user_id) === String(ctx.auth.user.id)) return true;
    const openid = (ctx.auth.user && ctx.auth.user.openid) || (ctx.auth.identity && ctx.auth.identity.openid) || "";
    if (valueListContains(businessOwnerOpenids(payload), openid)) return true;
    const memberName = ctx.memberCard && ctx.memberCard.name;
    return valueListContains(businessOwnerNames(kind, payload), memberName);
  }

  async hydrateActivitiesWithResponses(activities, ctx) {
    const items = normalizeArray(activities);
    if (!items.length || !ctx) return items;
    const result = await this.db.query(
      `
      SELECT response.*, card.name AS member_name, card.avatar_url, users.openid
      FROM incircle_activity_responses response
      LEFT JOIN incircle_member_cards card ON card.id = response.member_card_id
      JOIN incircle_users users ON users.id = response.user_id
      WHERE response.activity_id = ANY($1::uuid[])
      ORDER BY response.created_at ASC
      `,
      [items.map((item) => item.id)]
    );
    const grouped = result.rows.reduce((map, row) => {
      const key = String(row.activity_id);
      const rows = map[key] || [];
      rows.push(row);
      map[key] = rows;
      return map;
    }, {});
    return items.map((activity) => {
      const responses = grouped[String(activity.id)] || [];
      if (!responses.length) return activity;
      const responseMembers = responses.map((row) => ({
        userId: String(row.user_id),
        memberId: row.member_card_id ? String(row.member_card_id) : "",
        name: row.member_name || "成员",
        avatar: safeAvatarUrl(row.avatar_url, "/images/avatar.png"),
        status: row.status,
        plusOneCount: Number(row.plus_one_count || 0),
      }));
      const namesFor = (statuses) => responseMembers.filter((member) => statuses.includes(member.status)).map((member) => member.name);
      const mine = responseMembers.find((member) => member.userId === String(ctx.auth.user.id));
      return Object.assign({}, activity, {
        attendees: namesFor(["我来", "带一人"]),
        pending: namesFor(["待定"]),
        absent: namesFor(["不来"]),
        waitlist: namesFor(["候补"]),
        plusOneCount: responseMembers.reduce((sum, member) => sum + member.plusOneCount, 0),
        myStatus: mine ? mine.status : "",
        responseMembers,
        hasNormalizedResponses: true,
      });
    });
  }

  async hydrateVotesWithBallots(votes, ctx) {
    const items = normalizeArray(votes);
    if (!items.length || !ctx) return items;
    const ids = items.map((item) => item.id);
    const [ballotsResult, vetoesResult] = await Promise.all([
      this.db.query(
        `
        SELECT ballot.*, card.name AS member_name, card.avatar_url, users.openid
        FROM incircle_vote_ballots ballot
        LEFT JOIN incircle_member_cards card ON card.id = ballot.member_card_id
        JOIN incircle_users users ON users.id = ballot.user_id
        WHERE ballot.vote_id = ANY($1::uuid[])
        ORDER BY ballot.created_at ASC
        `,
        [ids]
      ),
      this.db.query(
        `
        SELECT veto.*, card.name AS member_name, card.avatar_url, users.openid
        FROM incircle_vote_vetoes veto
        LEFT JOIN incircle_member_cards card ON card.id = veto.member_card_id
        JOIN incircle_users users ON users.id = veto.user_id
        WHERE veto.vote_id = ANY($1::uuid[])
        ORDER BY veto.created_at ASC
        `,
        [ids]
      ),
    ]);
    const grouped = (rows, keyName) => rows.reduce((map, row) => {
      const key = String(row[keyName]);
      const values = map[key] || [];
      values.push(row);
      map[key] = values;
      return map;
    }, {});
    const ballots = grouped(ballotsResult.rows, "vote_id");
    const vetoes = grouped(vetoesResult.rows, "vote_id");
    return items.map((vote) => {
      const ballotRows = ballots[String(vote.id)] || [];
      const vetoRows = vetoes[String(vote.id)] || [];
      if (!ballotRows.length && !vetoRows.length) return Object.assign({}, vote, { currentUserId: String(ctx.auth.user.id) });
      const records = ballotRows.map((row) => ({
        memberId: row.member_card_id ? String(row.member_card_id) : "",
        userId: String(row.user_id),
        openid: row.openid || "",
        memberName: row.member_name || "成员",
        avatar: safeAvatarUrl(row.avatar_url, "/images/avatar.png"),
        optionName: row.option_name,
        weight: Number(row.weight || 1),
        createdAt: row.created_at,
      }));
      const myVoteOptionNames = records
        .filter((record) => record.userId === String(ctx.auth.user.id))
        .map((record) => record.optionName);
      return Object.assign({}, vote, {
        currentUserId: String(ctx.auth.user.id),
        records,
        myVoteOptionNames,
        hasMyVote: myVoteOptionNames.length > 0,
        vetoRecords: vetoRows.map((row) => ({
          memberId: row.member_card_id ? String(row.member_card_id) : "",
          userId: String(row.user_id),
          memberName: row.member_name || "成员",
          optionName: row.option_name,
          createdAt: row.created_at,
        })),
        hasNormalizedBallots: true,
      });
    });
  }

  async hydrateCheckinsWithRecords(checkins, ctx) {
    const items = normalizeArray(checkins);
    if (!items.length || !ctx) return items;
    const ids = items.map((item) => item.id);
    const [result, usageResult] = await Promise.all([
      this.db.query(
        `
        SELECT record.*, card.name AS member_name, card.avatar_url, users.openid
        FROM incircle_checkin_records record
        LEFT JOIN incircle_member_cards card ON card.id = record.member_card_id
        JOIN incircle_users users ON users.id = record.user_id
        WHERE record.checkin_id = ANY($1::uuid[])
        ORDER BY record.created_at DESC
        `,
        [ids]
      ),
      this.db.query(
        `
        SELECT checkin_id, card_type, count(*)::int AS used
        FROM incircle_checkin_card_usage
        WHERE checkin_id = ANY($1::uuid[]) AND user_id = $2 AND week_key = $3
        GROUP BY checkin_id, card_type
        `,
        [ids, ctx.auth.user.id, beijingWeekKey()]
      ),
    ]);
    const grouped = result.rows.reduce((map, row) => {
      const key = String(row.checkin_id);
      const rows = map[key] || [];
      rows.push(row);
      map[key] = rows;
      return map;
    }, {});
    const usage = usageResult.rows.reduce((map, row) => {
      const key = String(row.checkin_id);
      const value = map[key] || { leave: 0, makeup: 0 };
      value[row.card_type] = Number(row.used || 0);
      map[key] = value;
      return map;
    }, {});
    return items.map((checkin) => {
      const rows = grouped[String(checkin.id)] || [];
      const currentUsage = usage[String(checkin.id)] || { leave: 0, makeup: 0 };
      if (!rows.length && !currentUsage.leave && !currentUsage.makeup) return checkin;
      return Object.assign({}, checkin, {
        records: rows.map((row) => {
          const media = normalizeCheckinMedia(row.media);
          return {
            id: String(row.id),
            memberId: row.member_card_id ? String(row.member_card_id) : "",
            userId: String(row.user_id),
            openid: row.openid || "",
            memberName: row.member_name || "成员",
            avatar: safeAvatarUrl(row.avatar_url, "/images/avatar.png"),
            type: row.record_type,
            value: row.value,
            note: row.note,
            media,
            src: (media[0] && media[0].src) || "",
            isMine: String(row.user_id) === String(ctx.auth.user.id),
            checkinDate: String(row.checkin_date).slice(0, 10),
            createdAt: row.created_at,
            createdAtMs: new Date(row.created_at).getTime(),
          };
        }),
        hasNormalizedRecords: true,
        leaveCardsUsed: currentUsage.leave || 0,
        makeupCardsUsed: currentUsage.makeup || 0,
        leaveCardAvailable: !currentUsage.leave,
        makeupCardAvailable: !currentUsage.makeup,
      });
    });
  }

  async awardScore(ctx, memberCard, delta, reason, eventKey, payload) {
    if (!delta || !eventKey || !memberCard) return false;
    const inserted = await this.db.query(
      `
      INSERT INTO incircle_score_logs (
        circle_id, user_id, member_card_id, delta, reason, event_key, payload
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      ON CONFLICT (circle_id, event_key) WHERE event_key IS NOT NULL AND event_key <> '' DO NOTHING
      RETURNING id
      `,
      [ctx.circleId, memberCard.userId, memberCard.id, delta, reason, eventKey, JSON.stringify(payload || {})]
    );
    if (!inserted.rows[0]) return false;
    await this.db.query(
      "UPDATE incircle_member_cards SET score = score + $2, updated_at = now() WHERE id = $1",
      [memberCard.id, delta]
    );
    return true;
  }

  async ensureDefaultScoreRulesForCircle(circleId) {
    const rules = DEFAULT_SCORE_RULES.map((rule) => ({
      key: rule.key,
      title: rule.title,
      score: rule.score,
      payload: {
        label: rule.title,
        value: `${rule.score >= 0 ? "+" : ""}${rule.score}`,
      },
    }));
    await this.db.query(
      `
      INSERT INTO incircle_score_rules (circle_id, key, title, score, enabled, payload)
      SELECT $1::uuid, rule.key, rule.title, rule.score, true, rule.payload
      FROM jsonb_to_recordset($2::jsonb) AS rule(key text, title text, score integer, payload jsonb)
      ON CONFLICT (circle_id, key) WHERE circle_id IS NOT NULL AND key <> '' DO NOTHING
      `,
      [circleId, JSON.stringify(rules)]
    );
  }

  async awardRule(ctx, memberCard, ruleKey, eventKey, payload) {
    await this.ensureDefaultScoreRulesForCircle(ctx.circleId);
    const ruleResult = await this.db.query(
      `
      SELECT * FROM incircle_score_rules
      WHERE key = $1 AND enabled = true AND (circle_id = $2 OR circle_id IS NULL)
      ORDER BY (circle_id = $2) DESC
      LIMIT 1
      `,
      [ruleKey, ctx.circleId]
    );
    const rule = ruleResult.rows[0];
    if (!rule) return false;
    return this.awardScore(ctx, memberCard, Number(rule.score || 0), rule.title || ruleKey, eventKey, payload);
  }

  async hydrateMemberSocialState(members, circleId, currentUserId) {
    const items = normalizeArray(members);
    if (!items.length) return items;
    const ids = items.map((member) => member.id);
    const [friendlyResult, proposalResult] = await Promise.all([
      this.db.query(
        `
        SELECT vote.*, voter_card.name AS voter_name, voter_card.avatar_url AS voter_avatar
        FROM incircle_member_tag_votes vote
        LEFT JOIN incircle_member_cards voter_card
          ON voter_card.circle_id = vote.circle_id AND voter_card.user_id = vote.voter_user_id
        WHERE vote.circle_id = $1 AND vote.target_member_card_id = ANY($2::uuid[])
        ORDER BY vote.created_at DESC
        `,
        [circleId, ids]
      ),
      this.db.query(
        `
        SELECT proposal.*, proposer_card.name AS proposer_name,
          proposal_vote.voter_user_id, proposal_vote.created_at AS vote_created_at,
          voter_card.name AS voter_name, voter_card.avatar_url AS voter_avatar
        FROM incircle_member_tag_proposals proposal
        LEFT JOIN incircle_member_cards proposer_card
          ON proposer_card.circle_id = proposal.circle_id AND proposer_card.user_id = proposal.proposed_by_user_id
        LEFT JOIN incircle_member_tag_proposal_votes proposal_vote ON proposal_vote.proposal_id = proposal.id
        LEFT JOIN incircle_member_cards voter_card
          ON voter_card.circle_id = proposal.circle_id AND voter_card.user_id = proposal_vote.voter_user_id
        WHERE proposal.circle_id = $1 AND proposal.target_member_card_id = ANY($2::uuid[])
        ORDER BY proposal.created_at DESC, proposal_vote.created_at ASC
        `,
        [circleId, ids]
      ),
    ]);
    const friendlyByTarget = friendlyResult.rows.reduce((map, row) => {
      const targetKey = String(row.target_member_card_id);
      const tags = map[targetKey] || {};
      const tag = tags[row.tag] || { tag: row.tag, voters: [], threshold: FRIENDLY_TAG_THRESHOLD };
      tag.voters.push({
        userId: String(row.voter_user_id),
        name: row.voter_name || "圈友",
        avatar: safeAvatarUrl(row.voter_avatar, "/images/avatar.png"),
        createdAt: row.created_at,
      });
      tags[row.tag] = tag;
      map[targetKey] = tags;
      return map;
    }, {});
    const proposalsByTarget = {};
    const proposalsById = {};
    proposalResult.rows.forEach((row) => {
      const proposalId = String(row.id);
      let proposal = proposalsById[proposalId];
      if (!proposal) {
        proposal = {
          id: proposalId,
          tag: row.tag,
          proposerName: row.proposer_name || "圈友",
          threshold: Number(row.threshold || FRIENDLY_TAG_THRESHOLD),
          status: row.status === "approved" ? "已上墙" : "投票中",
          voters: [],
          createdAt: row.created_at,
          approvedAt: row.approved_at || "",
        };
        proposalsById[proposalId] = proposal;
        const targetKey = String(row.target_member_card_id);
        const listForTarget = proposalsByTarget[targetKey] || [];
        listForTarget.push(proposal);
        proposalsByTarget[targetKey] = listForTarget;
      }
      if (row.voter_user_id && !proposal.voters.some((voter) => voter.userId === String(row.voter_user_id))) {
        proposal.voters.push({
          userId: String(row.voter_user_id),
          name: row.voter_name || "圈友",
          avatar: safeAvatarUrl(row.voter_avatar, "/images/avatar.png"),
          createdAt: row.vote_created_at,
        });
      }
    });
    return items.map((member) => {
      const friendlyTags = Object.values(friendlyByTarget[String(member.id)] || {}).map((tag) => Object.assign(tag, {
        count: tag.voters.length,
        voterNames: tag.voters.slice(0, 3).map((voter) => voter.name),
        myVoted: tag.voters.some((voter) => voter.userId === String(currentUserId)),
      }));
      const tagProposals = (proposalsByTarget[String(member.id)] || []).map((proposal) => Object.assign({}, proposal, {
        votes: proposal.voters.length,
        voterNames: proposal.voters.slice(0, 3).map((voter) => voter.name),
        myVoted: proposal.voters.some((voter) => voter.userId === String(currentUserId)),
      }));
      return Object.assign({}, member, { friendlyTags, tagProposals });
    });
  }

  canManageBusinessRow(row, ctx) {
    if (!row || !ctx || !ctx.auth || !ctx.auth.user) return false;
    if (this.canManageBusiness(ctx)) return true;
    return !!(row.created_by_user_id && String(row.created_by_user_id) === String(ctx.auth.user.id));
  }

  assertCanManageBusinessRow(row, ctx, action) {
    if (this.canManageBusinessRow(row, ctx)) return;
    throw new AppError(`只有发起人、圈主或超管可以${action || "执行此操作"}`, {
      statusCode: 403,
      errCode: "FORBIDDEN",
    });
  }

  async prepareActivitiesForRuntime(activities, ctx, preparedMembers) {
    if (!ctx) return activities;
    activities = await this.hydrateActivitiesWithResponses(activities, ctx);
    const members = Array.isArray(preparedMembers)
      ? preparedMembers
      : preparedMembers && Array.isArray(preparedMembers.members)
        ? preparedMembers.members
        : await this.listMemberDirectory(ctx.circleId);
    const realNames = uniqueNames(members);
    const realNameSet = memberNameSet(members);
    const currentName = nameOfPerson(ctx.memberCard);

    const normalizeMemberList = (value) => uniqueNames(value).filter((name) => realNameSet.has(name));
    const statusOfCurrentMember = (activity) => {
      if (!currentName) return "";
      if (normalizeMemberList(activity.attendees).includes(currentName)) return "我来";
      if (normalizeMemberList(activity.pending).includes(currentName)) return "待定";
      if (normalizeMemberList(activity.absent).includes(currentName)) return "不来";
      if (normalizeMemberList(activity.waitlist).includes(currentName)) return "候补";
      return "";
    };

    return normalizeArray(activities).map((activity) => {
      const creatorMember = normalizeArray(members).find(
        (member) => String(member.userId || "") === String(activity.createdByUserId || "")
      );
      const creatorName =
        (creatorMember && nameOfPerson(creatorMember)) ||
        (realNameSet.has(nameOfPerson(activity.creatorName)) ? nameOfPerson(activity.creatorName) : "");
      const payloadHostName = realNameSet.has(nameOfPerson(activity.hostName)) ? nameOfPerson(activity.hostName) : "";
      const hostName = payloadHostName || creatorName || realNames[0] || "微信用户";
      let attendees = normalizeMemberList(activity.attendees);
      const pending = normalizeMemberList(activity.pending);
      const absent = normalizeMemberList(activity.absent);
      const waitlist = normalizeMemberList(activity.waitlist);
      const hostHasResponse = [pending, absent, waitlist].some((list) => list.includes(hostName));
      if (!attendees.length && !activity.hasNormalizedResponses && !hostHasResponse && realNameSet.has(hostName)) {
        attendees = [hostName];
      }
      const responded = new Set([].concat(attendees, pending, absent, waitlist));
      const silent = realNames.filter((name) => !responded.has(name));
      const coming = attendees.length + (activity.plusOneCount || 0);
      const capacity = Number(activity.capacity) || Math.max(coming, 1);
      const needCount = Math.max(0, capacity - coming);
      const tags = uniqueNames(
        normalizeArray(activity.tags)
          .filter((tag) => !/^缺\s*\d+\s*人$/.test(String(tag || "")))
          .concat(capacity >= 99 ? "不限人数" : `缺 ${needCount} 人`)
      );
      const myStatus = activity.hasNormalizedResponses
        ? String(activity.myStatus || "")
        : statusOfCurrentMember(Object.assign({}, activity, { attendees, pending, absent, waitlist }));
      return Object.assign({}, activity, {
        hostName,
        creatorName: creatorName || activity.creatorName || hostName,
        attendees,
        pending,
        absent,
        waitlist,
        silent,
        myStatus,
        tags,
        recap: Object.assign({}, activity.recap || {}, {
          earlyBird:
            realNameSet.has(nameOfPerson(activity.recap && activity.recap.earlyBird))
              ? nameOfPerson(activity.recap.earlyBird)
              : attendees[0] || "待定",
        }),
      });
    });
  }

  decorateBusinessRow(row, kind, ctx) {
    const item = publicBusinessRow(row, null, kind);
    if (!item) return item;
    const canDelete = this.canDeleteBusinessRow(row, ctx, kind);
    const canEditActor = this.canEditBusinessActor(row, ctx, kind);
    const editDisabledReason = canEditActor ? this.businessEditDisabledReason(row, kind) : "";
    const canEdit = canEditActor && !editDisabledReason;
    return Object.assign(item, {
      createdByUserId: row.created_by_user_id ? String(row.created_by_user_id) : "",
      canDelete,
      deleteText: canDelete ? "删除" : "",
      canEdit,
      editText: canEdit ? "编辑" : "",
      editDisabledReason,
    });
  }

  async listBusiness(kind, circleId, options) {
    const table = this.businessTable(kind);
    const result = await this.db.query(
      `SELECT * FROM ${table} WHERE circle_id = $1 ORDER BY created_at DESC`,
      [circleId]
    );
    const ctx = options && options.ctx;
    const rows = result.rows.map((row) => this.decorateBusinessRow(row, kind, ctx));
    if (kind === "activities") {
      return this.prepareActivitiesForRuntime(
        rows,
        ctx,
        options && (options.memberDirectory || options.membersData)
      );
    }
    if (kind === "votes") return this.hydrateVotesWithBallots(rows, ctx);
    if (kind !== "checkins") return rows;
    const hydrated = await this.hydrateCheckinsWithRecords(rows, ctx);
    const todayKey = (options && options.todayKey) || beijingDateKey();
    const member = options && options.memberCard;
    return hydrated.map((checkin) => decorateCheckinForMember(checkin, member, todayKey));
  }

  async getBusinessRow(kind, id, circleId) {
    const table = this.businessTable(kind);
    const result = await this.db.query(
      `
      SELECT * FROM ${table}
      WHERE ($1 = '' OR id::text = $1 OR payload->>'legacyId' = $1)
        AND ($2::uuid IS NULL OR circle_id = $2)
      LIMIT 1
      `,
      [String(id || ""), circleId || null]
    );
    return result.rows[0] || null;
  }

  async getBusiness(kind, id, circleId, options) {
    const rawRow = await this.getBusinessRow(kind, id, circleId);
    if (rawRow) {
      const row = this.decorateBusinessRow(rawRow, kind, options && options.ctx);
      if (kind === "activities") {
        const prepared = await this.prepareActivitiesForRuntime([row], options && options.ctx);
        return prepared[0] || row;
      }
      if (kind === "checkins") {
        const todayKey = (options && options.todayKey) || beijingDateKey();
        const hydrated = await this.hydrateCheckinsWithRecords([row], options && options.ctx);
        return decorateCheckinForMember(hydrated[0] || row, options && options.memberCard, todayKey);
      }
      if (kind === "votes") {
        const hydrated = await this.hydrateVotesWithBallots([row], options && options.ctx);
        return hydrated[0] || row;
      }
      return row;
    }
    const fallback = await this.listBusiness(kind, circleId, options);
    return fallback[0] || null;
  }

  async insertBusiness(kind, circleId, userId, incoming, defaults, options) {
    const table = this.businessTable(kind);
    const id = crypto.randomUUID();
    const safeIncoming = options && options.trustedIncoming
      ? stripBusinessTransientFields(incoming)
      : businessInput(kind, incoming);
    const payload = Object.assign({}, safeIncoming, stripBusinessTransientFields(defaults), {
      id,
      circleId,
      createdAt: nowIso(),
      createdAtMs: Date.now(),
    });
    const result = await this.db.query(
      `
      INSERT INTO ${table} (id, circle_id, created_by_user_id, title, status, payload)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      RETURNING *
      `,
      [
        id,
        circleId,
        userId || null,
        payload.title || (defaults && defaults.title) || "",
        payload.status || (defaults && defaults.status) || "active",
        JSON.stringify(payload),
      ]
    );
    return publicBusinessRow(result.rows[0], null, kind);
  }

  async ensureDefaultDocsForCircle(circleId, userId) {
    return ensureDefaultSystemDocsForCircle(this.db, circleId, userId || null);
  }

  async refreshCircleBusinessCounters(circleId) {
    await this.db.query(
      `
      UPDATE incircle_circles SET
        monthly_activity_count = (
          SELECT count(*) FROM incircle_activities
          WHERE circle_id = $1 AND created_at >= date_trunc('month', now())
        ),
        unsettled_count = (
          SELECT count(*) FROM incircle_bills
          WHERE circle_id = $1 AND status <> '已结清'
        ),
        updated_at = now()
      WHERE id = $1
      `,
      [circleId]
    );
  }

  async deleteBusiness(kind, id, ctx) {
    const table = this.businessTable(kind);
    const row = await this.getBusinessRow(kind, id, ctx.circleId);
    if (!row) throw new AppError(`${businessKindLabel(kind)}不存在或已删除`, { statusCode: 404, errCode: "NOT_FOUND" });
    if (!this.canDeleteBusinessRow(row, ctx, kind)) {
      throw new AppError(`只有发起人、圈主或超管可以删除${businessKindLabel(kind)}`, {
        statusCode: 403,
        errCode: "FORBIDDEN",
      });
    }

    await this.db.withTransaction(async () => {
      await this.db.query(`DELETE FROM ${table} WHERE id = $1`, [row.id]);
      if (kind === "bills") {
        await this.db.query(
          `
          UPDATE incircle_activities
          SET payload = ((payload - 'postBillId' - 'postBillStatus') || jsonb_build_object('updatedAt', $3::text)),
              updated_at = now()
          WHERE circle_id = $1 AND payload->>'postBillId' = $2
          `,
          [ctx.circleId, String(row.id), nowIso()]
        );
      }
      if (kind === "activities" || kind === "bills") {
        await this.refreshCircleBusinessCounters(ctx.circleId);
      }
      await this.logOperation(ctx.circleId, ctx.auth, `删除${businessKindLabel(kind)}`, businessTargetType(kind), row.id, {
        title: row.title || (row.payload && row.payload.title) || "",
      });
    });

    return this.decorateBusinessRow(row, kind, ctx);
  }

  async updateBusiness(kind, id, patch) {
    const table = this.businessTable(kind);
    const existed = await this.db.query(`SELECT * FROM ${table} WHERE id = $1 LIMIT 1`, [id]);
    if (!existed.rows[0]) throw new AppError("数据不存在", { statusCode: 404, errCode: "NOT_FOUND" });
    const next = Object.assign({}, stripBusinessTransientFields(existed.rows[0].payload), stripBusinessTransientFields(patch), {
      id: String(existed.rows[0].id),
      circleId: String(existed.rows[0].circle_id),
      updatedAt: nowIso(),
    });
    const result = await this.db.query(
      `
      UPDATE ${table} SET
        title = COALESCE(NULLIF($2, ''), title),
        status = COALESCE(NULLIF($3, ''), status),
        payload = $4::jsonb,
        updated_at = now()
      WHERE id = $1
      RETURNING *
      `,
      [id, next.title || "", next.status || "", JSON.stringify(next)]
    );
    return publicBusinessRow(result.rows[0], null, kind);
  }

  async home(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    const isSuperAdmin = this.isSuperAdmin(ctx.auth.identity && ctx.auth.identity.openid, ctx.auth.user);
    const [circleResult, membersData] = await Promise.all([
      this.db.query("SELECT * FROM incircle_circles WHERE id = $1 LIMIT 1", [ctx.circleId]),
      this.listMembersData(ctx.circleId, ctx.auth.user.id),
    ]);
    const [activities, bills, votes, checkins, docs] = await Promise.all([
      this.listBusiness("activities", ctx.circleId, { ctx, memberDirectory: membersData.members }),
      this.listBusiness("bills", ctx.circleId, { ctx }),
      this.listBusiness("votes", ctx.circleId, { ctx }).then((items) => this.prepareVotesForRuntime(items)),
      this.listBusiness("checkins", ctx.circleId, { ctx, memberCard: ctx.memberCard }),
      this.listBusiness("docs", ctx.circleId, { ctx }),
    ]);
    const pendingVote = votes.find((vote) => !CLOSED_VOTE_STATUSES.has(vote.status));
    const pendingBill = bills.find((bill) => bill.status !== "已结清");
    return {
      circle: publicCircle(circleResult.rows[0], ctx.membership, ctx.circleId, { isSuperAdmin }),
      recentActivity: activities[0],
      pendingVote,
      pendingBill,
      todayCheckin: checkins[0],
      pinnedDoc: docs.find((doc) => doc.pinned) || docs[0],
      leaderboard: scoreLeaderboard(membersData.members, 3),
      myCard: membersData.myCard,
      monthlyHonors: membersData.monthlyHonors,
      isSuperAdmin,
    };
  }

  async activities(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    return this.listBusiness("activities", ctx.circleId, { ctx });
  }

  async activityDetail(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    return this.getBusiness("activities", body.id, ctx.circleId, { ctx });
  }

  async createActivity(body) {
    const ctx = await this.requireCircleContext(body);
    const members = await this.listMemberDirectory(ctx.circleId);
    const memberNames = uniqueNames(members);
    const hostName = nameOfPerson(ctx.memberCard) || memberNames[0] || "微信用户";
    const incoming = Object.assign({}, body.activity || {});
    [
      "hostOpenid",
      "hostName",
      "creatorOpenid",
      "creatorName",
      "attendees",
      "pending",
      "absent",
      "waitlist",
      "silent",
      "myStatus",
      "recap",
    ].forEach((key) => {
      delete incoming[key];
    });
    await this.db.withTransaction(async () => {
      const activity = await this.insertBusiness("activities", ctx.circleId, ctx.auth.user.id, incoming, {
        status: "报名中",
        hostOpenid: ctx.auth.identity && ctx.auth.identity.openid,
        hostName,
        creatorOpenid: ctx.auth.user.openid,
        creatorName: hostName,
        attendees: [],
        pending: [],
        absent: [],
        waitlist: [],
        silent: memberNames.filter((name) => name !== hostName),
        myStatus: "我来",
        plusOneCount: 0,
        recap: {
          mvp: "待活动结束",
          earlyBird: hostName,
          lateBird: "待定",
        },
      });
      const startsAt = parseBeijingDateTime(incoming.startsAt || incoming.time);
      if (startsAt) {
        await this.db.query("UPDATE incircle_activities SET starts_at = $2 WHERE id = $1", [activity.id, startsAt]);
      }
      await this.db.query(
        `
        INSERT INTO incircle_activity_responses (
          circle_id, activity_id, user_id, member_card_id, status, plus_one_count
        ) VALUES ($1, $2, $3, $4, '我来', 0)
        ON CONFLICT (activity_id, user_id) DO UPDATE SET
          status = EXCLUDED.status,
          plus_one_count = 0,
          member_card_id = EXCLUDED.member_card_id,
          updated_at = now()
        `,
        [ctx.circleId, activity.id, ctx.auth.user.id, ctx.memberCard.id]
      );
      await this.awardRule(ctx, ctx.memberCard, "create_activity", `create_activity:${activity.id}`, {
        type: "发起活动",
        activityId: activity.id,
        memberName: ctx.memberCard.name,
        avatar: ctx.memberCard.avatar,
      });
    });
    return this.activities(body);
  }

  async updateActivity(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    const source = businessInput("activities", body.activity || {});
    const activityPatch = pickFields(source, [
      "title", "type", "time", "startsAt", "startsAtMs", "location", "locationName", "locationAddress",
      "latitude", "longitude", "hasMapLocation", "capacity", "fee",
    ]);
    activityPatch.title = sanitizeTimelineText(activityPatch.title).slice(0, 80);
    activityPatch.type = sanitizeTimelineText(activityPatch.type).slice(0, 30);
    activityPatch.time = sanitizeTimelineText(activityPatch.time).slice(0, 80);
    activityPatch.location = sanitizeTimelineText(activityPatch.location).slice(0, 120);
    activityPatch.locationName = sanitizeTimelineText(activityPatch.locationName || activityPatch.location).slice(0, 120);
    activityPatch.locationAddress = sanitizeTimelineText(activityPatch.locationAddress).slice(0, 200);
    activityPatch.fee = sanitizeTimelineText(activityPatch.fee || "费用待定").slice(0, 80);
    activityPatch.capacity = Math.min(99, Math.max(1, Number(activityPatch.capacity || 0)));
    const latitudeValue = activityPatch.latitude;
    const longitudeValue = activityPatch.longitude;
    activityPatch.latitude = latitudeValue !== null && latitudeValue !== "" && Number.isFinite(Number(latitudeValue))
      ? Number(latitudeValue)
      : null;
    activityPatch.longitude = longitudeValue !== null && longitudeValue !== "" && Number.isFinite(Number(longitudeValue))
      ? Number(longitudeValue)
      : null;
    activityPatch.hasMapLocation = !!(
      activityPatch.hasMapLocation &&
      activityPatch.latitude !== null &&
      activityPatch.longitude !== null
    );
    if (!activityPatch.title || !activityPatch.time || !activityPatch.location || !activityPatch.capacity) {
      throw new AppError("请补全活动名称、时间、地点和人数", {
        statusCode: 400,
        errCode: "INVALID_ACTIVITY_FORM",
      });
    }

    await this.db.withTransaction(async () => {
      const found = await this.getBusinessRow("activities", body.id, ctx.circleId);
      if (!found) throw new AppError("活动不存在或已删除", { statusCode: 404, errCode: "ACTIVITY_NOT_FOUND" });
      const locked = await this.db.query("SELECT * FROM incircle_activities WHERE id = $1 FOR UPDATE", [found.id]);
      const row = locked.rows[0];
      this.assertCanEditBusinessRow(row, ctx, "activities");
      const responseResult = await this.db.query(
        `
        SELECT COALESCE(sum(CASE WHEN status IN ('我来', '带一人') THEN 1 + plus_one_count ELSE 0 END), 0)::int AS coming
        FROM incircle_activity_responses
        WHERE activity_id = $1
        `,
        [row.id]
      );
      const coming = Number(responseResult.rows[0] && responseResult.rows[0].coming || 0);
      if (activityPatch.capacity < coming) {
        throw new AppError(`人数上限不能少于当前已报名的 ${coming} 人`, {
          statusCode: 409,
          errCode: "ACTIVITY_CAPACITY_TOO_SMALL",
        });
      }
      await this.updateBusiness("activities", row.id, activityPatch);
      const startsAt = parseBeijingDateTime(activityPatch.startsAt || activityPatch.time);
      await this.db.query("UPDATE incircle_activities SET starts_at = $2 WHERE id = $1", [row.id, startsAt]);
      await this.refreshCircleBusinessCounters(ctx.circleId);
      await this.logOperation(ctx.circleId, ctx.auth, "编辑活动", "activity", row.id, {
        title: activityPatch.title,
      });
    });
    return this.activities(body);
  }

  async deleteActivity(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    await this.deleteBusiness("activities", body.id, ctx);
    return this.activities(body);
  }

  async updateActivityStatus(body) {
    const ctx = await this.requireCircleContext(body);
    const status = String(body.status || "");
    if (!["我来", "带一人", "待定", "不来", "候补"].includes(status)) {
      throw new AppError("报名状态无效", { statusCode: 400, errCode: "INVALID_ACTIVITY_STATUS" });
    }
    await this.db.withTransaction(async () => {
      const row = await this.db.query(
        "SELECT id, status FROM incircle_activities WHERE id = $1 AND circle_id = $2 FOR UPDATE",
        [body.id, ctx.circleId]
      );
      if (!row.rows[0]) throw new AppError("活动不存在或已删除", { statusCode: 404, errCode: "ACTIVITY_NOT_FOUND" });
      if (row.rows[0].status === "已完成") {
        throw new AppError("活动已经结束，不能再修改报名", { statusCode: 409, errCode: "ACTIVITY_CLOSED" });
      }
      const existed = await this.db.query(
        "SELECT id FROM incircle_activity_responses WHERE activity_id = $1 AND user_id = $2 LIMIT 1",
        [body.id, ctx.auth.user.id]
      );
      await this.db.query(
        `
        INSERT INTO incircle_activity_responses (
          circle_id, activity_id, user_id, member_card_id, status, plus_one_count
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (activity_id, user_id) DO UPDATE SET
          status = EXCLUDED.status,
          plus_one_count = EXCLUDED.plus_one_count,
          member_card_id = EXCLUDED.member_card_id,
          updated_at = now()
        `,
        [ctx.circleId, body.id, ctx.auth.user.id, ctx.memberCard.id, status, status === "带一人" ? 1 : 0]
      );
      if (!existed.rows[0]) {
        await this.awardRule(ctx, ctx.memberCard, "activity_response", `activity_response:${body.id}:${ctx.auth.user.id}`, {
          type: "活动表态",
          activityId: body.id,
          status,
          memberName: ctx.memberCard.name,
          avatar: ctx.memberCard.avatar,
        });
      }
    });
    return this.activities(body);
  }

  async finishActivity(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    const row = await this.getBusinessRow("activities", body.id, ctx.circleId);
    if (!row) return null;
    this.assertCanManageBusinessRow(row, ctx, "结束活动");
    const preparedActivities = await this.prepareActivitiesForRuntime([this.decorateBusinessRow(row, "activities", ctx)], ctx);
    const activity = preparedActivities[0];
    const attendees = normalizeArray(activity.attendees);
    await this.updateBusiness("activities", activity.id, {
      status: "已完成",
      highlight: `复盘已生成：${attendees[0] || "本局成员"} 成为本局 MVP。`,
      recap: Object.assign({}, activity.recap || {}, {
        mvp: attendees[0] || "待定",
        vibe: "活动已完成，复盘可分享回群。",
      }),
    });
    return this.getBusiness("activities", activity.id, ctx.circleId, { ctx });
  }

  async addActivityPhoto(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    const row = await this.getBusinessRow("activities", body.id, ctx.circleId);
    if (!row) return null;
    this.assertCanManageBusinessRow(row, ctx, "上传活动照片");
    const activity = this.decorateBusinessRow(row, "activities", ctx);
    const photos = normalizeArray(body.photoList).concat(normalizeArray(activity.photos));
    await this.updateBusiness("activities", activity.id, { photos });
    return this.getBusiness("activities", activity.id, ctx.circleId, { ctx });
  }

  async tools(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    const [membersData, bills, votes, checkins, decisionMakers] = await Promise.all([
      this.listMembersData(ctx.circleId, ctx.auth.user.id),
      this.listBusiness("bills", ctx.circleId, { ctx }),
      this.listBusiness("votes", ctx.circleId, { ctx }).then((items) => this.prepareVotesForRuntime(items)),
      this.listBusiness("checkins", ctx.circleId, { ctx, memberCard: ctx.memberCard }),
      this.listBusiness("decisions", ctx.circleId, { ctx }),
    ]);
    return {
      bills,
      votes: votes.map((vote) => enrichVoteWithVoters(vote, membersData.members)),
      checkins,
      decisionMakers,
      members: membersData.members,
      myCard: membersData.myCard,
      scoreRules: membersData.scoreRules,
      scoreLogs: membersData.scoreLogs,
      monthlyHonors: membersData.monthlyHonors,
    };
  }

  async billDetail(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    return this.getBusiness("bills", body.id, ctx.circleId, { ctx });
  }

  async prepareBillInput(ctx, source) {
    const input = source && typeof source === "object" ? source : {};
    const members = await this.listMemberDirectory(ctx.circleId);
    const byName = members.reduce((map, member) => {
      const name = nameOfPerson(member);
      const values = map[name] || [];
      values.push(member);
      map[name] = values;
      return map;
    }, {});
    const resolveMember = (name) => {
      const matches = byName[nameOfPerson(name)] || [];
      return matches.length === 1 ? matches[0] : null;
    };
    const participants = uniqueNames(input.participants).filter((name) => !!resolveMember(name));
    if (participants.length < 1 || participants.length !== uniqueNames(input.participants).length) {
      throw new AppError("账单参与人包含不存在或重名成员，请重新选择", {
        statusCode: 400,
        errCode: "INVALID_BILL_PARTICIPANTS",
      });
    }
    const payer = resolveMember(input.payerName);
    if (!payer || !participants.includes(payer.name)) {
      throw new AppError("付款人必须是账单参与成员", { statusCode: 400, errCode: "INVALID_BILL_PAYER" });
    }
    const amount = toMoney(input.amount);
    if (!(amount > 0) || amount > 1000000) {
      throw new AppError("账单金额需要大于 0 且不超过 100 万元", { statusCode: 400, errCode: "INVALID_BILL_AMOUNT" });
    }
    const splitMode = ["平均分", "指定参与人", "某人不参与", "发起人免单", "老板请客", "自定义金额"].includes(input.splitMode)
      ? input.splitMode
      : "平均分";
    let debtors = participants.filter((name) => name !== payer.name);
    let transfers = [];
    let perPerson = 0;
    if (splitMode === "老板请客") {
      debtors = [];
    } else if (splitMode === "自定义金额") {
      transfers = normalizeArray(input.transfers).map((transfer) => ({
        from: nameOfPerson(transfer && transfer.from),
        to: payer.name,
        amount: toMoney(transfer && transfer.amount),
      }));
      if (
        !transfers.length ||
        transfers.some((transfer) => !participants.includes(transfer.from) || transfer.from === payer.name || !(transfer.amount > 0)) ||
        transfers.reduce((sum, transfer) => sum + transfer.amount, 0) > amount + 0.01
      ) {
        throw new AppError("自定义金额明细与参与人或总金额不匹配", {
          statusCode: 400,
          errCode: "INVALID_CUSTOM_SPLIT",
        });
      }
      debtors = uniqueNames(transfers.map((transfer) => transfer.from));
      perPerson = toMoney(transfers.reduce((sum, transfer) => sum + transfer.amount, 0) / debtors.length);
    } else {
      const divisor = splitMode === "发起人免单" ? debtors.length : participants.length;
      perPerson = divisor ? toMoney(amount / divisor) : amount;
      transfers = debtors.map((name) => ({ from: name, to: payer.name, amount: perPerson }));
    }
    const expenseItems = normalizeArray(input.expenseItems)
      .slice(0, 20)
      .map((item) => ({ name: sanitizeTimelineText(item && item.name).slice(0, 50), amount: toMoney(item && item.amount) }))
      .filter((item) => item.name && item.amount > 0);
    return {
      title: sanitizeTimelineText(input.title || "AA 账单").slice(0, 80),
      amount,
      payerName: payer.name,
      payerMemberId: payer.id,
      perPerson,
      status: debtors.length ? "结算中" : "已结清",
      splitMode,
      participants,
      participantIds: participants.map((name) => resolveMember(name).id),
      expenseItems: expenseItems.length ? expenseItems : [{ name: sanitizeTimelineText(input.title || "本次费用").slice(0, 50), amount }],
      debtors,
      transfers,
      unsettledCount: debtors.length,
      punchline: debtors.length ? `${debtors[0]} 等 ${debtors.length} 人待结清。` : "本次费用已结清。",
    };
  }

  async createBill(body) {
    const ctx = await this.requireCircleContext(body);
    const prepared = await this.prepareBillInput(ctx, body.bill || {});
    const bill = await this.insertBusiness("bills", ctx.circleId, ctx.auth.user.id, prepared, {
      status: prepared.status,
      creatorOpenid: ctx.auth.user.openid,
      creatorName: ctx.memberCard.name,
    });
    await this.awardRule(ctx, ctx.memberCard, "create_bill", `create_bill:${bill.id}`, {
      type: "发起AA",
      billId: bill.id,
      memberName: ctx.memberCard.name,
      avatar: ctx.memberCard.avatar,
    });
    return this.tools(body).then((data) => data.bills);
  }

  async updateBill(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    await this.db.withTransaction(async () => {
      const found = await this.getBusinessRow("bills", body.id, ctx.circleId);
      if (!found) throw new AppError("AA 账单不存在或已删除", { statusCode: 404, errCode: "NOT_FOUND" });
      const locked = await this.db.query("SELECT * FROM incircle_bills WHERE id = $1 FOR UPDATE", [found.id]);
      const row = locked.rows[0];
      this.assertCanEditBusinessRow(row, ctx, "bills");
      const prepared = await this.prepareBillInput(ctx, businessInput("bills", body.bill || {}));
      await this.updateBusiness("bills", row.id, Object.assign({}, prepared, {
        status: prepared.status,
        remindCount: 0,
        lastReminder: "",
        lastNoticeResult: null,
      }));
      await this.refreshCircleBusinessCounters(ctx.circleId);
      await this.logOperation(ctx.circleId, ctx.auth, "编辑AA", "bill", row.id, {
        title: prepared.title,
        amount: prepared.amount,
      });
    });
    return this.tools(body).then((data) => data.bills);
  }

  async deleteBill(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    await this.deleteBusiness("bills", body.id, ctx);
    return this.tools(body).then((data) => data.bills);
  }

  async createBillFromActivity(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    return this.db.withTransaction(async () => {
      const locked = await this.db.query(
        "SELECT * FROM incircle_activities WHERE id = $1 AND circle_id = $2 FOR UPDATE",
        [body.id, ctx.circleId]
      );
      const activityRow = locked.rows[0];
      if (!activityRow) throw new AppError("活动不存在，无法生成账单", { statusCode: 404, errCode: "ACTIVITY_NOT_FOUND" });
      this.assertCanManageBusinessRow(activityRow, ctx, "发起活动 AA");
      const preparedActivities = await this.prepareActivitiesForRuntime([this.decorateBusinessRow(activityRow, "activities", ctx)], ctx);
      const activity = preparedActivities[0];
      const existingBill = await this.db.query(
        `
        SELECT id, status FROM incircle_bills
        WHERE circle_id = $1 AND (source_activity_id = $2 OR payload->>'sourceActivityId' = $2::text)
        LIMIT 1
        `,
        [ctx.circleId, activity.id]
      );
      if (existingBill.rows[0]) {
        await this.updateBusiness("activities", activity.id, {
          postBillId: String(existingBill.rows[0].id),
          postBillStatus: existingBill.rows[0].status || "已生成账单",
        });
        return this.getBusiness("activities", activity.id, ctx.circleId, { ctx });
      }
      const participants = uniqueNames(activity.attendees);
      const payerName = nameOfPerson(activity.creatorName || activity.hostName || ctx.memberCard);
      if (payerName && !participants.includes(payerName)) participants.unshift(payerName);
      const fee = parseActivityFee(activity, participants.length);
      if (!(fee.amount > 0)) {
        throw new AppError("活动费用尚未填写，暂时不能生成 AA", {
          statusCode: 409,
          errCode: "ACTIVITY_FEE_REQUIRED",
        });
      }
      const preparedBill = await this.prepareBillInput(ctx, {
        title: `${activity.title || "活动"} AA 账单`,
        amount: fee.amount,
        payerName,
        splitMode: "平均分",
        participants,
        expenseItems: [{ name: activity.title || "活动费用", amount: fee.amount }],
      });
      const bill = await this.insertBusiness("bills", ctx.circleId, ctx.auth.user.id, {}, Object.assign({}, preparedBill, {
        sourceActivityId: activity.id,
        sourceActivityTitle: activity.title || "",
        creatorOpenid: ctx.auth.user.openid,
        creatorName: nameOfPerson(ctx.memberCard) || payerName,
      }));
      await this.db.query("UPDATE incircle_bills SET source_activity_id = $2 WHERE id = $1", [bill.id, activity.id]);
      await this.updateBusiness("activities", activity.id, {
        postBillId: bill.id,
        postBillStatus: "已生成账单",
      });
      if (ctx.memberCard) {
        await this.awardRule(ctx, ctx.memberCard, "create_bill", `create_bill:${bill.id}`, {
          type: "发起AA",
          billId: bill.id,
          activityId: activity.id,
          memberName: ctx.memberCard.name,
          avatar: ctx.memberCard.avatar,
        });
      }
      return this.getBusiness("activities", activity.id, ctx.circleId, { ctx });
    });
  }

  async settleBill(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    const row = await this.getBusinessRow("bills", body.id, ctx.circleId);
    if (!row) throw new AppError("AA 账单不存在或已删除", { statusCode: 404, errCode: "NOT_FOUND" });
    this.assertCanManageBusinessRow(row, ctx, "结清账单");
    await this.db.withTransaction(async () => {
      await this.updateBusiness("bills", body.id, {
        unsettledCount: 0,
        debtors: [],
        transfers: [],
        status: "已结清",
        punchline: "全员结清。",
      });
      if (ctx.memberCard) {
        await this.awardRule(ctx, ctx.memberCard, "settle_bill", `settle_bill:${body.id}`, {
          type: "完成结算",
          billId: body.id,
          memberName: ctx.memberCard.name,
          avatar: ctx.memberCard.avatar,
        });
      }
    });
    return this.tools(body).then((data) => data.bills);
  }

  async remindBill(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    const row = await this.getBusinessRow("bills", body.id, ctx.circleId);
    if (!row) return null;
    this.assertCanManageBusinessRow(row, ctx, "提醒结算");
    const bill = this.decorateBusinessRow(row, "bills", ctx);
    await this.updateBusiness("bills", bill.id, {
      remindCount: (bill.remindCount || 0) + 1,
      lastReminder: `第 ${(bill.remindCount || 0) + 1} 次提醒已生成。`,
      lastNoticeResult: { enabled: false, message: "自建后端暂未接入微信订阅消息，已生成站内提醒" },
    });
    return this.getBusiness("bills", bill.id, ctx.circleId, { ctx });
  }

  async prepareVoteForRuntime(vote, options) {
    if (!vote) return vote;
    const prepared = prepareVotePayload(vote, options);
    let nextVote = prepared.vote;
    if (prepared.shouldPersist && nextVote && nextVote.id) {
      await this.updateBusiness("votes", nextVote.id, nextVote);
    }
    const hasParticipation = normalizeArray(nextVote.records).length > 0 || normalizeArray(nextVote.vetoRecords).length > 0;
    const runtimeEditReason = nextVote.isClosed || voteStatusIsClosed(nextVote)
      ? "投票已经截止，内容已锁定"
      : hasParticipation
        ? "已有成员参与投票，不能再修改规则或选项"
        : vote.editDisabledReason || "";
    nextVote = Object.assign({}, nextVote, {
      canDelete: !!vote.canDelete,
      deleteText: vote.deleteText || "",
      canEdit: !!vote.canEdit && !runtimeEditReason,
      editDisabledReason: runtimeEditReason,
    });
    return nextVote;
  }

  async prepareVotesForRuntime(votes, options) {
    return Promise.all(normalizeArray(votes).map((vote) => this.prepareVoteForRuntime(vote, options)));
  }

  async voteDetail(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    const members = await this.listMemberDirectory(ctx.circleId);
    const vote = await this.getBusiness("votes", body.id, ctx.circleId, { ctx });
    return enrichVoteWithVoters(await this.prepareVoteForRuntime(vote), members);
  }

  async createVote(body) {
    const ctx = await this.requireCircleContext(body);
    const voteDraft = prepareVotePayload(Object.assign({}, body.vote || {}, { createdAt: nowIso() })).vote;
    const vote = await this.insertBusiness("votes", ctx.circleId, ctx.auth.user.id, voteDraft, {
      status: "投票中",
      records: [],
      vetoRecords: [],
      creatorOpenid: ctx.auth.user.openid,
      creatorName: ctx.memberCard.name,
    });
    const deadline = parseBeijingDateTime(voteDraft.deadlineAt || voteDraft.deadlineTime || voteDraft.deadline);
    if (deadline) await this.db.query("UPDATE incircle_votes SET deadline_at = $2 WHERE id = $1", [vote.id, deadline]);
    await this.awardRule(ctx, ctx.memberCard, "create_vote", `create_vote:${vote.id}`, {
      type: "发起投票",
      voteId: vote.id,
      memberName: ctx.memberCard.name,
      avatar: ctx.memberCard.avatar,
    });
    return this.tools(body).then((data) => data.votes);
  }

  async updateVote(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    await this.db.withTransaction(async () => {
      const found = await this.getBusinessRow("votes", body.id, ctx.circleId);
      if (!found) throw new AppError("投票不存在或已删除", { statusCode: 404, errCode: "NOT_FOUND" });
      const locked = await this.db.query("SELECT * FROM incircle_votes WHERE id = $1 FOR UPDATE", [found.id]);
      const row = locked.rows[0];
      this.assertCanEditBusinessRow(row, ctx, "votes");
      const participation = await this.db.query(
        `
        SELECT
          (SELECT count(*) FROM incircle_vote_ballots WHERE vote_id = $1)::int AS ballots,
          (SELECT count(*) FROM incircle_vote_vetoes WHERE vote_id = $1)::int AS vetoes
        `,
        [row.id]
      );
      const counts = participation.rows[0] || {};
      if (Number(counts.ballots || 0) > 0 || Number(counts.vetoes || 0) > 0) {
        throw new AppError("已有成员参与投票，不能再修改规则或选项", {
          statusCode: 409,
          errCode: "VOTE_HAS_PARTICIPATION",
        });
      }

      const incoming = businessInput("votes", body.vote || {});
      const title = sanitizeTimelineText(incoming.title).slice(0, 80);
      const optionNames = uniqueNames(
        normalizeArray(incoming.options)
          .map((option) => sanitizeTimelineText(option && option.name).slice(0, 80))
          .filter(Boolean)
      ).slice(0, 20);
      if (!title || optionNames.length < 2) {
        throw new AppError("请填写投票标题和至少两个选项", {
          statusCode: 400,
          errCode: "INVALID_VOTE_FORM",
        });
      }
      const deadline = parseBeijingDateTime(
        incoming.deadlineAtMs || incoming.deadlineAt || incoming.deadlineText || incoming.deadline,
        row.created_at
      );
      if (!deadline || deadline.getTime() <= Date.now()) {
        throw new AppError("投票截止时间必须晚于当前时间", {
          statusCode: 400,
          errCode: "INVALID_VOTE_DEADLINE",
        });
      }
      const type = ["普通投票", "时间投票", "地点投票", "随机抽签", "命运转盘"].includes(incoming.type)
        ? incoming.type
        : "普通投票";
      const visibility = incoming.visibility === "匿名" ? "匿名" : "实名";
      const choiceMode = incoming.choiceMode === "多选" ? "多选" : "单选";
      const isLocationVote = type === "地点投票";
      const latitudeValue = incoming.latitude;
      const longitudeValue = incoming.longitude;
      const latitude = latitudeValue !== null && latitudeValue !== "" && Number.isFinite(Number(latitudeValue))
        ? Number(latitudeValue)
        : null;
      const longitude = longitudeValue !== null && longitudeValue !== "" && Number.isFinite(Number(longitudeValue))
        ? Number(longitudeValue)
        : null;
      const deadlineDisplay = formatBeijingDateTime(deadline);
      const current = publicBusinessRow(row, null, "votes");
      const nextDraft = Object.assign({}, current, {
        title,
        type,
        visibility,
        choiceMode,
        allowVeto: !!incoming.allowVeto,
        organizerWeighted: !!incoming.organizerWeighted,
        weightValue: 2,
        deadline: `${deadlineDisplay} 截止`,
        deadlineAt: deadline.toISOString(),
        deadlineAtMs: deadline.getTime(),
        deadlineDisplay,
        deadlineText: `${deadlineDisplay} 截止`,
        locationText: isLocationVote ? sanitizeTimelineText(incoming.locationText).slice(0, 160) : "",
        locationName: isLocationVote ? sanitizeTimelineText(incoming.locationName).slice(0, 120) : "",
        locationAddress: isLocationVote ? sanitizeTimelineText(incoming.locationAddress).slice(0, 200) : "",
        latitude: isLocationVote ? latitude : null,
        longitude: isLocationVote ? longitude : null,
        rule: [
          `${visibility}${choiceMode}`,
          incoming.organizerWeighted ? "组织者权重票" : "同票权重",
          incoming.allowVeto ? "可一票否决" : "无否决",
          type === "时间投票" ? "最多人可来自动胜出" : "结果可回群公布",
        ].join(" · "),
        options: optionNames.map((name) => ({ name, count: 0, weightedCount: 0, percent: 0 })),
        records: [],
        vetoRecords: [],
        status: "投票中",
        winner: "",
        resultText: "",
        resultSummary: "",
        resultAnalysis: null,
        resultGeneratedAt: "",
        closedAt: "",
        closedReason: "",
        isClosed: false,
        canVote: true,
      });
      const prepared = prepareVotePayload(nextDraft).vote;
      await this.updateBusiness("votes", row.id, prepared);
      await this.db.query("UPDATE incircle_votes SET deadline_at = $2 WHERE id = $1", [row.id, deadline]);
      await this.logOperation(ctx.circleId, ctx.auth, "编辑投票", "vote", row.id, { title });
    });
    return this.tools(body).then((data) => data.votes);
  }

  async deleteVote(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    await this.deleteBusiness("votes", body.id, ctx);
    return this.tools(body).then((data) => data.votes);
  }

  async voteOption(body) {
    const ctx = await this.requireCircleContext(body);
    const optionName = String(body.name || "").trim();
    await this.db.withTransaction(async () => {
      const locked = await this.db.query(
        "SELECT * FROM incircle_votes WHERE id = $1 AND circle_id = $2 FOR UPDATE",
        [body.id, ctx.circleId]
      );
      const row = locked.rows[0];
      if (!row) throw new AppError("投票不存在或已删除", { statusCode: 404, errCode: "NOT_FOUND" });
      const hydrated = await this.hydrateVotesWithBallots([this.decorateBusinessRow(row, "votes", ctx)], ctx);
      const vote = await this.prepareVoteForRuntime(hydrated[0]);
      if (vote.isClosed || voteStatusIsClosed(vote)) {
        throw new AppError("投票已截止，不能再投", { statusCode: 409, errCode: "VOTE_CLOSED" });
      }
      if (!normalizeArray(vote.options).some((option) => option.name === optionName)) {
        throw new AppError("投票选项不存在", { statusCode: 404, errCode: "VOTE_OPTION_NOT_FOUND" });
      }
      const existing = await this.db.query(
        "SELECT id FROM incircle_vote_ballots WHERE vote_id = $1 AND user_id = $2 AND option_name = $3 LIMIT 1",
        [vote.id, ctx.auth.user.id, optionName]
      );
      const existingAny = await this.db.query(
        "SELECT id FROM incircle_vote_ballots WHERE vote_id = $1 AND user_id = $2 LIMIT 1",
        [vote.id, ctx.auth.user.id]
      );
      const isMulti = vote.choiceMode === "多选";
      if (isMulti && existing.rows[0]) {
        await this.db.query("DELETE FROM incircle_vote_ballots WHERE id = $1", [existing.rows[0].id]);
      } else if (!isMulti && existing.rows[0]) {
        return;
      } else {
        if (!isMulti) {
          await this.db.query("DELETE FROM incircle_vote_ballots WHERE vote_id = $1 AND user_id = $2", [vote.id, ctx.auth.user.id]);
        }
        const isOrganizer = String(row.created_by_user_id || "") === String(ctx.auth.user.id);
        const weight = vote.organizerWeighted && isOrganizer ? Math.max(1, Number(vote.weightValue || 2)) : 1;
        await this.db.query(
          `
          INSERT INTO incircle_vote_ballots (
            circle_id, vote_id, user_id, member_card_id, option_name, weight
          ) VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (vote_id, user_id, option_name) DO NOTHING
          `,
          [ctx.circleId, vote.id, ctx.auth.user.id, ctx.memberCard.id, optionName, weight]
        );
        if (!existingAny.rows[0]) {
          await this.awardRule(ctx, ctx.memberCard, "vote_ballot", `vote_ballot:${vote.id}:${ctx.auth.user.id}`, {
            type: "参与投票",
            voteId: vote.id,
            memberName: ctx.memberCard.name,
            avatar: ctx.memberCard.avatar,
          });
        }
      }
      const nextHydrated = await this.hydrateVotesWithBallots([this.decorateBusinessRow(row, "votes", ctx)], ctx);
      await this.updateBusiness("votes", vote.id, recalcVote(nextHydrated[0]));
    });
    return this.tools(body).then((data) => data.votes);
  }

  async vetoVoteOption(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    const row = await this.getBusinessRow("votes", body.id, ctx.circleId);
    if (!row) return this.tools(body).then((data) => data.votes);
    this.assertCanManageBusinessRow(row, ctx, "否决投票选项");
    const hydrated = await this.hydrateVotesWithBallots([this.decorateBusinessRow(row, "votes", ctx)], ctx);
    const vote = await this.prepareVoteForRuntime(hydrated[0]);
    if (!vote || !vote.allowVeto) return this.tools(body).then((data) => data.votes);
    if (vote.isClosed || voteStatusIsClosed(vote)) {
      throw new AppError("投票已截止，不能再否决", { statusCode: 409, errCode: "VOTE_CLOSED" });
    }
    const optionName = String(body.name || "").trim();
    if (!normalizeArray(vote.options).some((option) => option.name === optionName)) {
      throw new AppError("投票选项不存在", { statusCode: 404, errCode: "VOTE_OPTION_NOT_FOUND" });
    }
    await this.db.query(
      `
      INSERT INTO incircle_vote_vetoes (circle_id, vote_id, user_id, member_card_id, option_name)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (vote_id, user_id, option_name) DO NOTHING
      `,
      [ctx.circleId, vote.id, ctx.auth.user.id, ctx.memberCard ? ctx.memberCard.id : null, optionName]
    );
    const vetoRecords = normalizeArray(vote.vetoRecords);
    if (!vetoRecords.some((record) => String(record.userId || "") === String(ctx.auth.user.id) && record.optionName === optionName)) {
      vetoRecords.unshift({
        memberId: ctx.memberCard ? ctx.memberCard.id : "",
        userId: ctx.auth.user.id,
        memberName: ctx.memberCard ? ctx.memberCard.name : ctx.auth.user.nickname || "超管",
        optionName,
        createdAt: nowIso(),
      });
    }
    const options = normalizeArray(vote.options).map((option) =>
      option.name === optionName ? Object.assign({}, option, { vetoed: true }) : option
    );
    await this.updateBusiness("votes", vote.id, recalcVote(Object.assign({}, vote, { vetoRecords, options })));
    return this.tools(body).then((data) => data.votes);
  }

  async finishVote(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    const row = await this.getBusinessRow("votes", body.id, ctx.circleId);
    if (!row) return null;
    this.assertCanManageBusinessRow(row, ctx, "提前结束投票");
    const hydrated = await this.hydrateVotesWithBallots([this.decorateBusinessRow(row, "votes", ctx)], ctx);
    const vote = await this.prepareVoteForRuntime(hydrated[0]);
    if (!vote.isClosed && !voteStatusIsClosed(vote)) {
      const prepared = prepareVotePayload(vote, {
        forceClose: true,
        closedReason: "提前截止",
        closedAt: nowIso(),
        generatedAt: nowIso(),
      }).vote;
      await this.updateBusiness("votes", vote.id, prepared);
    }
    return this.voteDetail(body);
  }

  async checkinDetail(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    return this.getBusiness("checkins", body.id, ctx.circleId, { ctx, memberCard: ctx.memberCard });
  }

  async createCheckin(body) {
    const ctx = await this.requireCircleContext(body);
    const checkin = await this.insertBusiness("checkins", ctx.circleId, ctx.auth.user.id, body.checkin || {}, {
      status: "进行中",
      records: [],
      done: 0,
      creatorOpenid: ctx.auth.user.openid,
      creatorName: ctx.memberCard.name,
    });
    await this.awardRule(ctx, ctx.memberCard, "create_checkin", `create_checkin:${checkin.id}`, {
      type: "发起打卡挑战",
      checkinId: checkin.id,
      memberName: ctx.memberCard.name,
      avatar: ctx.memberCard.avatar,
    });
    return this.tools(body).then((data) => data.checkins);
  }

  async updateCheckin(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    await this.db.withTransaction(async () => {
      const found = await this.getBusinessRow("checkins", body.id, ctx.circleId);
      if (!found) throw new AppError("打卡挑战不存在或已删除", { statusCode: 404, errCode: "NOT_FOUND" });
      const locked = await this.db.query("SELECT * FROM incircle_checkins WHERE id = $1 FOR UPDATE", [found.id]);
      const row = locked.rows[0];
      this.assertCanEditBusinessRow(row, ctx, "checkins");
      const recordCount = await this.db.query(
        `
        SELECT
          (SELECT count(*) FROM incircle_checkin_records WHERE checkin_id = $1)::int AS records,
          (SELECT count(*) FROM incircle_checkin_card_usage WHERE checkin_id = $1)::int AS card_usage
        `,
        [row.id]
      );
      const usage = recordCount.rows[0] || {};
      if (Number(usage.records || 0) > 0 || Number(usage.card_usage || 0) > 0) {
        throw new AppError("已有成员参与挑战，不能再修改挑战规则", {
          statusCode: 409,
          errCode: "CHECKIN_HAS_RECORDS",
        });
      }
      const incoming = businessInput("checkins", body.checkin || {});
      const title = sanitizeTimelineText(incoming.title).slice(0, 80);
      const type = sanitizeTimelineText(incoming.type).slice(0, 30);
      const reward = sanitizeTimelineText(incoming.reward).slice(0, 200);
      const total = Math.min(500, Math.max(1, Number(incoming.total || 0)));
      if (!title || !type || !total) {
        throw new AppError("请补全挑战标题、类型和目标人数", {
          statusCode: 400,
          errCode: "INVALID_CHECKIN_FORM",
        });
      }
      await this.updateBusiness("checkins", row.id, {
        title,
        type,
        reward: reward || "坚持记录，完成后自动生成总结",
        total,
        punishmentPool: normalizeArray(incoming.punishmentPool)
          .map((item) => sanitizeTimelineText(item).slice(0, 80))
          .filter(Boolean)
          .slice(0, 20),
      });
      await this.logOperation(ctx.circleId, ctx.auth, "编辑打卡挑战", "checkin", row.id, { title });
    });
    return this.tools(body).then((data) => data.checkins);
  }

  async deleteCheckin(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    await this.deleteBusiness("checkins", body.id, ctx);
    return this.tools(body).then((data) => data.checkins);
  }

  async useCheckinCard(body) {
    const ctx = await this.requireCircleContext(body);
    const cardType = body.cardType === "leave" ? "leave" : body.cardType === "makeup" ? "makeup" : "";
    if (!cardType) throw new AppError("卡片类型无效", { statusCode: 400, errCode: "INVALID_CARD_TYPE" });
    const todayKey = beijingDateKey();
    const targetDate = cardType === "makeup" ? shiftDateKey(todayKey, -1) : todayKey;
    await this.db.withTransaction(async () => {
      const row = await this.db.query(
        "SELECT id, status FROM incircle_checkins WHERE id = $1 AND circle_id = $2 FOR UPDATE",
        [body.id, ctx.circleId]
      );
      if (!row.rows[0]) throw new AppError("打卡挑战不存在或已删除", { statusCode: 404, errCode: "NOT_FOUND" });
      if (row.rows[0].status !== "进行中") throw new AppError("挑战已结束，不能再使用卡片", { statusCode: 409, errCode: "CHECKIN_CLOSED" });
      const inserted = await this.db.query(
        `
        INSERT INTO incircle_checkin_card_usage (
          circle_id, checkin_id, user_id, member_card_id, card_type, week_key, target_date
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::date)
        ON CONFLICT (checkin_id, user_id, card_type, week_key) DO NOTHING
        RETURNING id
        `,
        [ctx.circleId, body.id, ctx.auth.user.id, ctx.memberCard.id, cardType, beijingWeekKey(), targetDate]
      );
      if (!inserted.rows[0]) {
        throw new AppError("本周已经使用过这张卡", { statusCode: 409, errCode: "CHECKIN_CARD_ALREADY_USED" });
      }
      if (cardType === "makeup") {
        await this.db.query(
          `
          INSERT INTO incircle_checkin_records (
            circle_id, checkin_id, user_id, member_card_id, checkin_date, record_type, value, note
          ) VALUES ($1, $2, $3, $4, $5::date, '补签', '补签完成', '使用本周补签卡')
          ON CONFLICT (checkin_id, user_id, checkin_date) DO NOTHING
          `,
          [ctx.circleId, body.id, ctx.auth.user.id, ctx.memberCard.id, targetDate]
        );
      }
    });
    return this.getBusiness("checkins", body.id, ctx.circleId, { ctx, memberCard: ctx.memberCard });
  }

  async checkIn(body) {
    const ctx = await this.requireCircleContext(body);
    const todayKey = beijingDateKey();
    const incoming = body.record && typeof body.record === "object" ? body.record : {};
    const recordType = String(incoming.type || "文字").trim().slice(0, 20);
    const value = sanitizeTimelineText(incoming.value || "已完成").slice(0, 500);
    const note = sanitizeTimelineText(incoming.note || "").slice(0, 500);
    const media = normalizeCheckinMedia(incoming.media || incoming.images || incoming.photos, incoming);
    if (recordType === "图片" && !media.length) {
      throw new AppError("图片打卡需要先上传图片", { statusCode: 400, errCode: "CHECKIN_IMAGE_REQUIRED" });
    }
    await this.db.withTransaction(async () => {
      const row = await this.db.query(
        "SELECT id, status FROM incircle_checkins WHERE id = $1 AND circle_id = $2 FOR UPDATE",
        [body.id, ctx.circleId]
      );
      if (!row.rows[0]) throw new AppError("打卡挑战不存在或已删除", { statusCode: 404, errCode: "NOT_FOUND" });
      if (row.rows[0].status !== "进行中") throw new AppError("挑战已结束，不能再打卡", { statusCode: 409, errCode: "CHECKIN_CLOSED" });
      const inserted = await this.db.query(
        `
        INSERT INTO incircle_checkin_records (
          circle_id, checkin_id, user_id, member_card_id, checkin_date, record_type, value, note, media
        ) VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9::jsonb)
        ON CONFLICT (checkin_id, user_id, checkin_date) DO NOTHING
        RETURNING id
        `,
        [ctx.circleId, body.id, ctx.auth.user.id, ctx.memberCard.id, todayKey, recordType, value, note, JSON.stringify(media)]
      );
      if (inserted.rows[0]) {
        await this.awardRule(ctx, ctx.memberCard, "daily_checkin", `daily_checkin:${body.id}:${ctx.auth.user.id}:${todayKey}`, {
          type: "完成打卡",
          checkinId: body.id,
          checkinDate: todayKey,
          memberName: ctx.memberCard.name,
          avatar: ctx.memberCard.avatar,
        });
      }
    });
    return this.tools(body).then((data) => data.checkins);
  }

  async updateCheckinRecordMedia(body) {
    const ctx = await this.requireCircleContext(body);
    if (!isUuid(body.id) || !isUuid(body.recordId)) {
      throw new AppError("打卡记录参数无效", { statusCode: 400, errCode: "INVALID_CHECKIN_RECORD" });
    }
    const media = normalizeCheckinMedia(body.media, body.image);
    if (!media.length) {
      throw new AppError("请选择需要补充的图片", { statusCode: 400, errCode: "CHECKIN_IMAGE_REQUIRED" });
    }
    const updated = await this.db.query(
      `
      UPDATE incircle_checkin_records
      SET media = $5::jsonb, record_type = '图片', updated_at = now()
      WHERE id = $1 AND checkin_id = $2 AND circle_id = $3 AND user_id = $4
      RETURNING id
      `,
      [body.recordId, body.id, ctx.circleId, ctx.auth.user.id, JSON.stringify(media)]
    );
    if (!updated.rows[0]) {
      throw new AppError("打卡记录不存在或不能修改", { statusCode: 404, errCode: "CHECKIN_RECORD_NOT_FOUND" });
    }
    return this.getBusiness("checkins", body.id, ctx.circleId, { ctx, memberCard: ctx.memberCard });
  }

  async runCheckinPunishment(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    const row = await this.getBusinessRow("checkins", body.id, ctx.circleId);
    if (!row) return null;
    this.assertCanManageBusinessRow(row, ctx, "抽取惩罚任务");
    const hydrated = await this.hydrateCheckinsWithRecords([this.decorateBusinessRow(row, "checkins", ctx)], ctx);
    const checkin = hydrated[0];
    const pool = normalizeArray(checkin.punishmentPool).length ? checkin.punishmentPool : ["下次负责订位"];
    const task = pool[Math.floor(Math.random() * pool.length)];
    const todayKey = beijingDateKey();
    const candidates = await this.db.query(
      `
      SELECT card.name
      FROM incircle_member_cards card
      JOIN incircle_circle_members membership
        ON membership.circle_id = card.circle_id AND membership.user_id = card.user_id AND membership.status = 'active'
      WHERE card.circle_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM incircle_checkin_records record
          WHERE record.checkin_id = $2 AND record.user_id = card.user_id AND record.checkin_date = $3::date
        )
        AND NOT EXISTS (
          SELECT 1 FROM incircle_checkin_card_usage usage
          WHERE usage.checkin_id = $2 AND usage.user_id = card.user_id
            AND usage.card_type = 'leave' AND usage.target_date = $3::date
        )
      ORDER BY card.name
      `,
      [ctx.circleId, checkin.id, todayKey]
    );
    const target = candidates.rows.length ? candidates.rows[Math.floor(Math.random() * candidates.rows.length)].name : "全员已完成";
    await this.updateBusiness("checkins", checkin.id, {
      punishmentResult: { memberName: target, task: target === "全员已完成" ? "本次无需惩罚" : task, createdAt: nowIso(), createdAtMs: Date.now() },
    });
    return this.getBusiness("checkins", checkin.id, ctx.circleId, { ctx, memberCard: ctx.memberCard });
  }

  async runDecision(body) {
    const ctx = await this.requireCircleContext(body);
    const decision = await this.getBusiness("decisions", body.id, ctx.circleId, { ctx });
    if (!decision) return this.listBusiness("decisions", ctx.circleId, { ctx });
    const options = normalizeArray(decision.options);
    const result = options.length ? options[Math.floor(Math.random() * options.length)] : "";
    await this.updateBusiness("decisions", decision.id, { result, hasRun: true });
    return this.listBusiness("decisions", ctx.circleId, { ctx });
  }

  async docs(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    return this.listBusiness("docs", ctx.circleId, { ctx });
  }

  async docDetail(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    return this.getBusiness("docs", body.id, ctx.circleId, { ctx });
  }

  async createDoc(body) {
    const ctx = await this.requireCircleContext(body);
    const incoming = Object.assign({}, body.doc || {});
    ["owner", "ownerOpenid", "creatorOpenid", "creatorName"].forEach((key) => {
      delete incoming[key];
    });
    const doc = await this.insertBusiness("docs", ctx.circleId, ctx.auth.user.id, incoming, {
      status: "active",
      owner: ctx.memberCard.name,
      ownerOpenid: ctx.auth.user.openid,
      creatorOpenid: ctx.auth.user.openid,
      creatorName: ctx.memberCard.name,
    });
    await this.awardRule(ctx, ctx.memberCard, "create_doc", `create_doc:${doc.id}`, {
      type: "发布资料",
      docId: doc.id,
      memberName: ctx.memberCard.name,
      avatar: ctx.memberCard.avatar,
    });
    return this.docs(body);
  }

  async updateDoc(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    await this.db.withTransaction(async () => {
      const found = await this.getBusinessRow("docs", body.id, ctx.circleId);
      if (!found) throw new AppError("资料不存在或已删除", { statusCode: 404, errCode: "NOT_FOUND" });
      const locked = await this.db.query("SELECT * FROM incircle_docs WHERE id = $1 FOR UPDATE", [found.id]);
      const row = locked.rows[0];
      this.assertCanEditBusinessRow(row, ctx, "docs");
      const incoming = businessInput("docs", body.doc || {});
      const title = sanitizeTimelineText(incoming.title).slice(0, 100);
      const summary = sanitizeTimelineText(incoming.summary).slice(0, 300);
      if (!title || !summary) {
        throw new AppError("请补全资料标题和摘要", {
          statusCode: 400,
          errCode: "INVALID_DOC_FORM",
        });
      }
      const patch = {
        title,
        category: sanitizeTimelineText(incoming.category || "公告").slice(0, 30),
        summary,
        body: normalizeArray(incoming.body)
          .map((item) => sanitizeTimelineText(item).slice(0, 1000))
          .filter(Boolean)
          .slice(0, 100),
        checklist: normalizeArray(incoming.checklist)
          .map((item) => sanitizeTimelineText(item).slice(0, 200))
          .filter(Boolean)
          .slice(0, 50),
        related: normalizeArray(incoming.related)
          .map((item) => sanitizeTimelineText(item).slice(0, 80))
          .filter(Boolean)
          .slice(0, 30),
      };
      await this.updateBusiness("docs", row.id, patch);
      await this.logOperation(ctx.circleId, ctx.auth, "编辑资料", "doc", row.id, { title });
    });
    return this.docs(body);
  }

  async deleteDoc(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    await this.deleteBusiness("docs", body.id, ctx);
    return this.docs(body);
  }

  async members(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    return this.listMembersData(ctx.circleId, ctx.auth.user.id);
  }

  async memberDetail(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    const data = await this.listMembersData(ctx.circleId, ctx.auth.user.id);
    const member = data.members.find((item) => item.id === body.id || item.openid === body.id) || data.myCard;
    if (!member) return null;
    const scoreParams = [ctx.circleId, member.id || null, member.userId || null, String(member.id || ""), member.name || ""];
    const scoreWhere = `
      l.circle_id = $1
      AND (
        ($2::uuid IS NOT NULL AND l.member_card_id = $2::uuid)
        OR ($3::uuid IS NOT NULL AND l.user_id = $3::uuid)
        OR l.payload->>'memberId' = $4
        OR l.payload->>'memberName' = $5
      )
    `;
    const scoreLogsResult = await this.db.query(
      `
      SELECT l.*,
        COALESCE(card.name, user_card.name) AS member_name,
        COALESCE(card.avatar_url, user_card.avatar_url, users.avatar_url) AS member_avatar,
        users.nickname AS user_name
      FROM incircle_score_logs l
      LEFT JOIN incircle_member_cards card ON card.id = l.member_card_id
      LEFT JOIN incircle_member_cards user_card ON user_card.circle_id = l.circle_id AND user_card.user_id = l.user_id
      LEFT JOIN incircle_users users ON users.id = COALESCE(l.user_id, card.user_id, user_card.user_id)
      WHERE ${scoreWhere}
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT 6
      `,
      scoreParams
    );
    const scoreLogTotalResult = await this.db.query(
      `
      SELECT count(*)::int AS total
      FROM incircle_score_logs l
      WHERE ${scoreWhere}
      `,
      scoreParams
    );
    const scoreLogTotal = scoreLogTotalResult.rows[0] ? scoreLogTotalResult.rows[0].total || 0 : 0;
    const [recentActivityRows, recentVoteRows, recentCheckinRows, recentBillRows, recentDocRows] = await Promise.all([
      this.db.query(
        "SELECT 'activity' AS kind, id::text, created_by_user_id, title, status, payload, created_at FROM incircle_activities WHERE circle_id = $1 ORDER BY created_at DESC LIMIT 30",
        [ctx.circleId]
      ),
      this.db.query(
        "SELECT 'vote' AS kind, id::text, created_by_user_id, title, status, payload, created_at FROM incircle_votes WHERE circle_id = $1 ORDER BY created_at DESC LIMIT 30",
        [ctx.circleId]
      ),
      this.db.query(
        "SELECT 'checkin' AS kind, id::text, created_by_user_id, title, status, payload, created_at FROM incircle_checkins WHERE circle_id = $1 ORDER BY created_at DESC LIMIT 30",
        [ctx.circleId]
      ),
      this.db.query(
        "SELECT 'bill' AS kind, id::text, created_by_user_id, title, status, payload, created_at FROM incircle_bills WHERE circle_id = $1 ORDER BY created_at DESC LIMIT 30",
        [ctx.circleId]
      ),
      this.db.query(
        "SELECT 'doc' AS kind, id::text, created_by_user_id, title, status, payload, created_at FROM incircle_docs WHERE circle_id = $1 ORDER BY created_at DESC LIMIT 30",
        [ctx.circleId]
      ),
    ]);
    const memberKeys = {
      id: String(member.id || ""),
      userId: String(member.userId || ""),
      openid: String(member.openid || ""),
      name: String(member.name || ""),
    };
    const matchesMember = (value) => {
      if (!value) return false;
      if (typeof value === "string") return value === memberKeys.name || value === memberKeys.id || value === memberKeys.userId || value === memberKeys.openid;
      if (typeof value !== "object") return false;
      return (
        (!!memberKeys.id && String(value.memberId || value.member_card_id || value.id || "") === memberKeys.id) ||
        (!!memberKeys.userId && String(value.userId || value.user_id || "") === memberKeys.userId) ||
        (!!memberKeys.openid && String(value.openid || value._openid || "") === memberKeys.openid) ||
        (!!memberKeys.name && String(value.memberName || value.name || value.nickname || value.from || value.to || "") === memberKeys.name)
      );
    };
    const listMatchesMember = (value) => normalizeArray(value).some(matchesMember);
    const payloadMatchesMember = (row) => {
      const payload = row.payload || {};
      if (String(row.created_by_user_id || "") === memberKeys.userId) return true;
      if ([payload.creatorName, payload.hostName, payload.owner, payload.payerName].some((value) => value === memberKeys.name)) return true;
      if ([payload.creatorOpenid, payload.hostOpenid, payload.openid, payload._openid].some((value) => value && String(value) === memberKeys.openid)) return true;
      if (listMatchesMember(payload.attendees) || listMatchesMember(payload.pending) || listMatchesMember(payload.absent) || listMatchesMember(payload.waitlist)) return true;
      if (listMatchesMember(payload.participants) || listMatchesMember(payload.debtors) || listMatchesMember(payload.transfers)) return true;
      if (listMatchesMember(payload.records) || listMatchesMember(payload.vetoRecords)) return true;
      return false;
    };
    const recentLabels = {
      activity: "活动",
      vote: "投票",
      checkin: "打卡",
      bill: "AA",
      doc: "资料",
    };
    const recentActivities = []
      .concat(recentActivityRows.rows, recentVoteRows.rows, recentCheckinRows.rows, recentBillRows.rows, recentDocRows.rows)
      .filter(payloadMatchesMember)
      .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime())
      .slice(0, 5)
      .map((row) => `${recentLabels[row.kind] || "动态"} · ${row.title || (row.payload && row.payload.title) || "未命名"} · ${formatBeijingDateTime(row.created_at)}`);
    return Object.assign({}, member, {
      friendlyTagPresets: friendlyTagPresets(),
      myMemberCardId: String((ctx.memberCard && ctx.memberCard.id) || ""),
      myUserId: String(ctx.auth.user.id || ""),
      isSelf: String(member.userId || "") === String(ctx.auth.user.id || ""),
      showSocialFeedback: String(member.userId || "") !== String(ctx.auth.user.id || ""),
      friendlyTags:
        String(member.userId || "") === String(ctx.auth.user.id || "") ? [] : normalizeArray(member.friendlyTags),
      tagProposals:
        String(member.userId || "") === String(ctx.auth.user.id || "") ? [] : normalizeArray(member.tagProposals),
      canEditTags:
        String(member.userId || "") === String(ctx.auth.user.id || "") ||
        this.canManageCircle(ctx.auth, ctx.membership),
      scoreLogs: scoreLogsResult.rows.map((row) =>
        Object.assign(publicScoreLog(row), {
          memberName: row.member_name || row.user_name || (row.payload && row.payload.memberName) || member.name || "成员",
          avatar: safeAvatarUrl(row.member_avatar || (row.payload && row.payload.avatar) || member.avatar, "/images/avatar.png"),
        })
      ),
      scoreLogTotal,
      hasMoreScoreLogs: scoreLogTotal > 5,
      recentActivities,
    });
  }

  async updateMyCard(body) {
    const ctx = await this.requireCircleContext(body);
    const patch = pickFields(body.patch, [
      "name", "avatar", "avatarUrl", "title", "profileNote", "note", "availability", "tags", "skills",
      "interests", "taboos",
    ]);
    const current = await this.db.query("SELECT * FROM incircle_member_cards WHERE id = $1 LIMIT 1", [ctx.memberCard.id]);
    const row = current.rows[0];
    const payload = Object.assign({}, row.payload || {}, patch);
    const nextAvatar = patch.avatar || patch.avatarUrl || "";
    await this.db.withTransaction(async () => {
      await this.db.query(
      `
      UPDATE incircle_member_cards SET
        name = COALESCE(NULLIF($2, ''), name),
        avatar_url = COALESCE(NULLIF($3, ''), avatar_url),
        title = COALESCE(NULLIF($4, ''), title),
        profile_note = COALESCE($5, profile_note),
        payload = $6::jsonb,
        updated_at = now()
      WHERE id = $1
      `,
      [
        ctx.memberCard.id,
        patch.name || "",
        nextAvatar,
        patch.title || "",
        patch.profileNote || patch.note || "",
        JSON.stringify(payload),
      ]
    );
      await this.db.query(
      `
      UPDATE incircle_users SET
        nickname = COALESCE(NULLIF($2, ''), nickname),
        avatar_url = COALESCE(NULLIF($3, ''), avatar_url),
        title = COALESCE(NULLIF($4, ''), title),
        profile_note = COALESCE($5, profile_note),
        updated_at = now()
      WHERE id = $1
      `,
      [
        ctx.auth.user.id,
        patch.name || "",
        nextAvatar,
        patch.title || "",
        patch.profileNote || patch.note || "",
      ]
    );
      await this.db.query(
      `
      UPDATE incircle_circle_members SET
        member_name = COALESCE(NULLIF($3, ''), member_name),
        updated_at = now()
      WHERE circle_id = $1 AND user_id = $2
      `,
      [ctx.circleId, ctx.auth.user.id, patch.name || ""]
    );
      await this.awardRule(ctx, ctx.memberCard, "profile_complete", `profile_complete:${ctx.memberCard.id}`, {
        type: "完善身份卡",
        memberName: patch.name || ctx.memberCard.name,
        avatar: nextAvatar || ctx.memberCard.avatar,
      });
      await this.logOperation(ctx.circleId, ctx.auth, "更新身份卡", "member_card", ctx.memberCard.id, {
        fields: Object.keys(patch),
      });
    });
    if (nextAvatar) removeUploadUrl(this.config, row.avatar_url, nextAvatar);
    return this.members(body);
  }

  async getMemberCardForTag(ctx, id) {
    const targetId = String(id || "").trim();
    if (!targetId) throw new AppError("缺少成员信息", { statusCode: 400, errCode: "MEMBER_REQUIRED" });
    const result = await this.db.query(
      `
      SELECT card.*, users.nickname AS user_nickname, users.avatar_url AS user_avatar_url,
        users.openid AS user_openid, members.role AS member_role
      FROM incircle_member_cards card
      JOIN incircle_users users ON users.id = card.user_id
      LEFT JOIN incircle_circle_members members ON members.circle_id = card.circle_id AND members.user_id = card.user_id
      WHERE card.circle_id = $1
        AND (card.id::text = $2 OR card.openid = $2 OR users.openid = $2)
        AND (members.status IS NULL OR members.status = 'active')
      LIMIT 1
      `,
      [ctx.circleId, targetId]
    );
    const row = result.rows[0];
    if (!row) throw new AppError("成员不存在或已离开圈子", { statusCode: 404, errCode: "MEMBER_NOT_FOUND" });
    const member = memberCardFromRow(
      Object.assign({}, row, { openid: row.openid || row.user_openid }),
      { id: row.user_id, openid: row.user_openid, nickname: row.user_nickname, avatar_url: row.user_avatar_url },
      { role: row.member_role || row.role }
    );
    return { row, member };
  }

  async updateMemberTagState(target, patch, scoreDelta, scorePayload) {
    const currentScore = Math.max(Number(target.row.score || 0), Number(target.member.score || 0));
    const currentWeeklyScore = Math.max(Number(target.row.weekly_score || 0), Number(target.member.weeklyScore || 0));
    const payloadPatch = Object.assign({}, patch);
    if (scoreDelta) {
      payloadPatch.score = currentScore + scoreDelta;
      payloadPatch.weeklyScore = currentWeeklyScore + scoreDelta;
    }
    await this.db.query(
      `
      UPDATE incircle_member_cards SET
        tags = $2::jsonb,
        score = score + $3,
        weekly_score = weekly_score + $3,
        payload = payload || $4::jsonb,
        updated_at = now()
      WHERE id = $1
      `,
      [target.member.id, JSON.stringify(patch.tags || []), scoreDelta || 0, JSON.stringify(payloadPatch)]
    );
    if (scoreDelta) {
      await this.db.query(
        `
        INSERT INTO incircle_score_logs (circle_id, user_id, member_card_id, delta, reason, payload)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        `,
        [
          target.member.circleId || target.row.circle_id,
          target.member.userId || target.row.user_id,
          target.member.id,
          scoreDelta,
          scorePayload.reason,
          JSON.stringify(scorePayload.payload || {}),
        ]
      );
    }
  }

  async addMemberTag(body) {
    const ctx = await this.requireCircleContext(body);
    const target = await this.getMemberCardForTag(ctx, body.id);
    const tag = normalizeFriendlyTag(body.tag);
    if (!tag) throw new AppError("标签不能为空", { statusCode: 400, errCode: "TAG_REQUIRED" });
    const isSelf = String(target.member.userId || "") === String(ctx.auth.user.id || "");
    if (isSelf) throw new AppError("不能给自己添加友好印象", { statusCode: 403, errCode: "SELF_FRIENDLY_TAG_FORBIDDEN" });
    let friendlyAction = null;
    await this.db.withTransaction(async () => {
      const lockedResult = await this.db.query(
        "SELECT tags, payload FROM incircle_member_cards WHERE id = $1 FOR UPDATE",
        [target.member.id]
      );
      const lockedCard = lockedResult.rows[0];
      if (!lockedCard) throw new AppError("成员不存在或已离开圈子", { statusCode: 404, errCode: "MEMBER_NOT_FOUND" });
      const existing = await this.db.query(
        "SELECT id FROM incircle_member_tag_votes WHERE target_member_card_id = $1 AND voter_user_id = $2 AND tag = $3 LIMIT 1",
        [target.member.id, ctx.auth.user.id, tag]
      );
      const added = !existing.rows[0];
      if (added) {
        await this.db.query(
          "INSERT INTO incircle_member_tag_votes (circle_id, target_member_card_id, voter_user_id, tag) VALUES ($1, $2, $3, $4)",
          [ctx.circleId, target.member.id, ctx.auth.user.id, tag]
        );
      } else {
        await this.db.query("DELETE FROM incircle_member_tag_votes WHERE id = $1", [existing.rows[0].id]);
      }
      const countResult = await this.db.query(
        "SELECT count(*)::int AS count FROM incircle_member_tag_votes WHERE target_member_card_id = $1 AND tag = $2",
        [target.member.id, tag]
      );
      const count = Number(countResult.rows[0].count || 0);
      const currentPayload = lockedCard.payload && typeof lockedCard.payload === "object" ? lockedCard.payload : {};
      const wallState = friendlyTagWallState(lockedCard.tags, currentPayload.autoFriendlyTags, tag, count);
      const safetyNote = added
        ? wallState.promoted
          ? `「${tag}」已获得 ${count} 位圈友认可，自动加入标签墙。`
          : `已记录「${tag}」印象，满 ${FRIENDLY_TAG_THRESHOLD} 人认可后自动上墙。`
        : `已撤回「${tag}」印象，标签墙已按当前认可人数更新。`;
      await this.db.query(
        "UPDATE incircle_member_cards SET tags = $2::jsonb, payload = payload || $3::jsonb, updated_at = now() WHERE id = $1",
        [target.member.id, JSON.stringify(wallState.tags), JSON.stringify({ autoFriendlyTags: wallState.autoTags, safetyNote })]
      );
      if (added) {
        await this.awardRule(
          ctx,
          target.member,
          "friendly_impression",
          `friendly:${target.member.id}:${ctx.auth.user.id}:${tag}`,
          { type: "友好印象", tag, voterName: ctx.memberCard.name, memberName: target.member.name, avatar: target.member.avatar }
        );
      }
      if (wallState.becamePromoted) {
        await this.awardRule(
          ctx,
          target.member,
          "friendly_promotion",
          `friendly-promotion:${target.member.id}:${tag}`,
          { type: "友好标签", tag, memberName: target.member.name, avatar: target.member.avatar }
        );
      }
      friendlyAction = {
        tag,
        added,
        count,
        promoted: wallState.promoted,
        becamePromoted: wallState.becamePromoted,
      };
      await this.logOperation(ctx.circleId, ctx.auth, added ? "贴友好印象" : "撤回友好印象", "member_card", target.member.id, {
        memberName: target.member.name,
        tag,
        count,
        promoted: wallState.promoted,
      });
    });
    const member = await this.memberDetail(body);
    return Object.assign({}, member, { friendlyAction });
  }

  async proposeMemberTag(body) {
    const ctx = await this.requireCircleContext(body);
    const target = await this.getMemberCardForTag(ctx, body.id);
    const tag = normalizeFriendlyTag(body.tag);
    if (!tag) throw new AppError("标签不能为空", { statusCode: 400, errCode: "TAG_REQUIRED" });
    const isSelf = String(target.member.userId || "") === String(ctx.auth.user.id || "");
    if (isSelf) throw new AppError("不能给自己发起圈友提名", { statusCode: 403, errCode: "SELF_TAG_PROPOSAL_FORBIDDEN" });
    const existingTags = normalizeArray(target.member.tags).map(normalizeFriendlyTag).filter(Boolean);
    if (existingTags.includes(tag)) {
      throw new AppError("这个标签已经在标签墙上", { statusCode: 409, errCode: "TAG_ALREADY_ON_WALL" });
    }
    await this.db.withTransaction(async () => {
      const proposalResult = await this.db.query(
        `
        INSERT INTO incircle_member_tag_proposals (
          circle_id, target_member_card_id, proposed_by_user_id, tag, threshold, status
        ) VALUES ($1, $2, $3, $4, $5, 'voting')
        ON CONFLICT (target_member_card_id, tag) DO UPDATE SET updated_at = now()
        RETURNING *
        `,
        [ctx.circleId, target.member.id, ctx.auth.user.id, tag, FRIENDLY_TAG_THRESHOLD]
      );
      const proposal = proposalResult.rows[0];
      if (proposal.status === "approved") {
        throw new AppError("这个标签已经通过提名", { statusCode: 409, errCode: "TAG_ALREADY_APPROVED" });
      }
      const inserted = await this.db.query(
        `
        INSERT INTO incircle_member_tag_proposal_votes (proposal_id, voter_user_id)
        VALUES ($1, $2)
        ON CONFLICT (proposal_id, voter_user_id) DO NOTHING
        RETURNING id
        `,
        [proposal.id, ctx.auth.user.id]
      );
      if (!inserted.rows[0]) {
        throw new AppError("你已经为这个提名投过票，可在提名卡片上取消", {
          statusCode: 409,
          errCode: "PROPOSAL_ALREADY_VOTED",
        });
      }
      await this.logOperation(ctx.circleId, ctx.auth, "提名成员标签", "member_card", target.member.id, {
        memberName: target.member.name,
        tag,
        proposalId: String(proposal.id),
      });
    });
    return this.memberDetail(body);
  }

  async voteMemberTagProposal(body) {
    const ctx = await this.requireCircleContext(body);
    const target = await this.getMemberCardForTag(ctx, body.id);
    const proposalId = String(body.proposalId || "").trim();
    if (!proposalId) throw new AppError("缺少提名信息", { statusCode: 400, errCode: "PROPOSAL_REQUIRED" });
    const isSelf = String(target.member.userId || "") === String(ctx.auth.user.id || "");
    if (isSelf) throw new AppError("不能给自己的圈友提名投票", { statusCode: 403, errCode: "SELF_TAG_PROPOSAL_VOTE_FORBIDDEN" });
    if (!isUuid(proposalId)) throw new AppError("提名参数无效", { statusCode: 400, errCode: "INVALID_PROPOSAL_ID" });
    await this.db.withTransaction(async () => {
      const proposalResult = await this.db.query(
        `
        SELECT * FROM incircle_member_tag_proposals
        WHERE id = $1 AND circle_id = $2 AND target_member_card_id = $3
        FOR UPDATE
        `,
        [proposalId, ctx.circleId, target.member.id]
      );
      const proposal = proposalResult.rows[0];
      if (!proposal) throw new AppError("提名不存在", { statusCode: 404, errCode: "PROPOSAL_NOT_FOUND" });
      if (proposal.status === "approved") {
        throw new AppError("这个提名已经通过", { statusCode: 409, errCode: "PROPOSAL_ALREADY_APPROVED" });
      }
      const existing = await this.db.query(
        "SELECT id FROM incircle_member_tag_proposal_votes WHERE proposal_id = $1 AND voter_user_id = $2 LIMIT 1",
        [proposal.id, ctx.auth.user.id]
      );
      const canceled = !!existing.rows[0];
      if (canceled) {
        await this.db.query("DELETE FROM incircle_member_tag_proposal_votes WHERE id = $1", [existing.rows[0].id]);
      } else {
        await this.db.query(
          "INSERT INTO incircle_member_tag_proposal_votes (proposal_id, voter_user_id) VALUES ($1, $2)",
          [proposal.id, ctx.auth.user.id]
        );
      }
      const countResult = await this.db.query(
        "SELECT count(*)::int AS count FROM incircle_member_tag_proposal_votes WHERE proposal_id = $1",
        [proposal.id]
      );
      const count = Number(countResult.rows[0].count || 0);
      if (!count) {
        await this.db.query("DELETE FROM incircle_member_tag_proposals WHERE id = $1", [proposal.id]);
      } else if (count >= Number(proposal.threshold || FRIENDLY_TAG_THRESHOLD)) {
        await this.db.query(
          "UPDATE incircle_member_tag_proposals SET status = 'approved', approved_at = now(), updated_at = now() WHERE id = $1",
          [proposal.id]
        );
        const currentTags = normalizeArray(target.row.tags).map(normalizeFriendlyTag).filter(Boolean);
        const currentPayload = target.row.payload || {};
        const autoTags = normalizeArray(currentPayload.autoFriendlyTags).map(normalizeFriendlyTag).filter(Boolean);
        await this.db.query(
          "UPDATE incircle_member_cards SET tags = $2::jsonb, payload = payload || $3::jsonb, updated_at = now() WHERE id = $1",
          [
            target.member.id,
            JSON.stringify(uniqueNames([proposal.tag].concat(currentTags))),
            JSON.stringify({
              autoFriendlyTags: uniqueNames([proposal.tag].concat(autoTags)),
              safetyNote: `「${proposal.tag}」已满 ${proposal.threshold} 票，自动加入标签墙。`,
            }),
          ]
        );
        await this.awardRule(
          ctx,
          target.member,
          "friendly_promotion",
          `tag-promotion:${proposal.id}`,
          { type: "友好标签", tag: proposal.tag, memberName: target.member.name, avatar: target.member.avatar }
        );
      }
      await this.logOperation(
        ctx.circleId,
        ctx.auth,
        canceled ? "取消成员标签投票" : count >= Number(proposal.threshold || FRIENDLY_TAG_THRESHOLD) ? "成员标签上墙" : "投票成员标签",
        "member_card",
        target.member.id,
        { memberName: target.member.name, tag: proposal.tag, removedEmptyProposal: count === 0 }
      );
    });
    return this.memberDetail(body);
  }

  async removeMemberTag(body) {
    const ctx = await this.requireCircleContext(body, { allowSuperAdmin: true });
    const target = await this.getMemberCardForTag(ctx, body.id);
    if (
      String(target.member.userId || "") !== String(ctx.auth.user.id || "") &&
      !this.canManageCircle(ctx.auth, ctx.membership)
    ) {
      throw new AppError("只有本人、圈主或超管可以移除标签", { statusCode: 403, errCode: "FORBIDDEN" });
    }
    const tag = normalizeFriendlyTag(body.tag);
    if (!tag) throw new AppError("标签不能为空", { statusCode: 400, errCode: "TAG_REQUIRED" });
    const tags = normalizeArray(target.member.tags).map(normalizeFriendlyTag).filter((item) => item && item !== tag);
    const autoTags = normalizeArray(target.row.payload && target.row.payload.autoFriendlyTags)
      .map(normalizeFriendlyTag)
      .filter((item) => item && item !== tag);
    await this.db.withTransaction(async () => {
      await this.db.query(
        "DELETE FROM incircle_member_tag_votes WHERE target_member_card_id = $1 AND tag = $2",
        [target.member.id, tag]
      );
      await this.db.query(
        "DELETE FROM incircle_member_tag_proposals WHERE target_member_card_id = $1 AND tag = $2",
        [target.member.id, tag]
      );
      await this.db.query(
        "UPDATE incircle_member_cards SET tags = $2::jsonb, payload = payload || $3::jsonb, updated_at = now() WHERE id = $1",
        [target.member.id, JSON.stringify(tags), JSON.stringify({ autoFriendlyTags: autoTags, safetyNote: `已移除「${tag}」标签。` })]
      );
      await this.logOperation(ctx.circleId, ctx.auth, "移除成员标签", "member_card", target.member.id, {
        memberName: target.member.name,
        tag,
      });
    });
    return this.memberDetail(body);
  }

  async appealMemberTag(body) {
    const ctx = await this.requireCircleContext(body);
    const target = await this.getMemberCardForTag(ctx, body.id);
    const tag = normalizeFriendlyTag(body.tag) || "标签墙";
    const reason = sanitizeTimelineText(body.reason || "成员认为该标签不合适").slice(0, 300);
    await this.db.query(
      `
      INSERT INTO incircle_member_tag_appeals (
        circle_id, target_member_card_id, appellant_user_id, tag, reason, status
      ) VALUES ($1, $2, $3, $4, $5, 'pending')
      ON CONFLICT (target_member_card_id, appellant_user_id, tag) WHERE status = 'pending'
      DO UPDATE SET reason = EXCLUDED.reason, updated_at = now()
      `,
      [ctx.circleId, target.member.id, ctx.auth.user.id, tag, reason]
    );
    await this.logOperation(ctx.circleId, ctx.auth, "提交标签申诉", "member_card", target.member.id, {
      memberName: target.member.name,
      tag,
    });
    return { submitted: true, tag };
  }

  async platformSettings() {
    const result = await this.db.query(
      `SELECT circle_ai_enabled, updated_by_user_id, updated_at
       FROM incircle_platform_settings
       WHERE singleton_id = 1
       LIMIT 1`
    );
    const row = result.rows[0];
    return {
      circleAiEnabled: !!(row && row.circle_ai_enabled === true),
      updatedByUserId: row ? row.updated_by_user_id || "" : "",
      updatedAt: row ? row.updated_at || null : null,
    };
  }

  async requireSuperAdmin(body) {
    const auth = await this.requireUser(body);
    if (!this.isSuperAdmin(auth.identity.openid, auth.user)) {
      throw new AppError("只有超管可以访问", { statusCode: 403, errCode: "FORBIDDEN" });
    }
    return auth;
  }

  async adminOverview(body) {
    await this.requireSuperAdmin(body);
    const [circleResult, userResult, logsResult, logsTotalResult, platformSettings] = await Promise.all([
      this.db.query(
        `
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE status <> 'active')::int AS frozen
        FROM incircle_circles
        `
      ),
      this.db.query(
        `
        SELECT count(*) FILTER (WHERE status <> 'deleted')::int AS total,
               count(*) FILTER (WHERE status = 'blocked')::int AS blocked
        FROM incircle_users
        `
      ),
      this.db.query(
        `
        SELECT logs.*, users.nickname AS actor_name, circles.name AS circle_name
        FROM incircle_operation_logs logs
        LEFT JOIN incircle_users users ON users.id = logs.actor_user_id
        LEFT JOIN incircle_circles circles ON circles.id = logs.circle_id
        ORDER BY logs.created_at DESC, logs.id DESC
        LIMIT 5
        `
      ),
      this.db.query("SELECT count(*)::int AS total FROM incircle_operation_logs"),
      this.platformSettings(),
    ]);
    const circleStats = circleResult.rows[0] || {};
    const userStats = userResult.rows[0] || {};
    const logs = logsResult.rows.map(publicAdminOperationLog);
    const logTotal = Number((logsTotalResult.rows[0] && logsTotalResult.rows[0].total) || 0);
    return {
      isSuperAdmin: true,
      metrics: [
        { label: "圈子", value: String(circleStats.total || 0) },
        { label: "用户", value: String(userStats.total || 0) },
        { label: "封禁", value: String(userStats.blocked || 0) },
      ],
      circleSummary: { total: Number(circleStats.total || 0), frozen: Number(circleStats.frozen || 0) },
      userSummary: { total: Number(userStats.total || 0), blocked: Number(userStats.blocked || 0) },
      platformSettings,
      logs,
      operationLogs: logs,
      logTotal,
      hasMoreLogs: logTotal > logs.length,
    };
  }

  async adminUpdatePlatformAi(body) {
    const auth = await this.requireSuperAdmin(body);
    if (typeof body.circleAiEnabled !== "boolean") {
      throw new AppError("圈内 AI 开关参数无效", {
        statusCode: 400,
        errCode: "PLATFORM_AI_SETTING_INVALID",
      });
    }
    const circleAiEnabled = body.circleAiEnabled;
    const platformSettings = await this.db.withTransaction(async () => {
      const result = await this.db.query(
        `
        INSERT INTO incircle_platform_settings (
          singleton_id, circle_ai_enabled, updated_by_user_id
        ) VALUES (1, $1, $2)
        ON CONFLICT (singleton_id) DO UPDATE SET
          circle_ai_enabled = EXCLUDED.circle_ai_enabled,
          updated_by_user_id = EXCLUDED.updated_by_user_id
        RETURNING circle_ai_enabled, updated_by_user_id, updated_at
        `,
        [circleAiEnabled, auth.user.id]
      );
      await this.logOperation(
        null,
        auth,
        circleAiEnabled ? "开放平台圈内AI" : "关闭平台圈内AI",
        "platform_settings",
        "circle_ai",
        { circleAiEnabled }
      );
      const row = result.rows[0] || {};
      return {
        circleAiEnabled: row.circle_ai_enabled === true,
        updatedByUserId: row.updated_by_user_id || "",
        updatedAt: row.updated_at || null,
      };
    });
    return { isSuperAdmin: true, platformSettings };
  }

  async adminListCircles(body) {
    await this.requireSuperAdmin(body);
    const keyword = normalizeKeyword(body.keyword || body.search);
    const status = String(body.status || "all").trim();
    const limit = normalizeLimit(body.limit, 20);
    const offset = normalizeOffset(body.offset);
    if (!["all", "active", "frozen", "closed"].includes(status)) {
      throw new AppError("圈子筛选参数无效", { statusCode: 400, errCode: "INVALID_CIRCLE_STATUS" });
    }
    const params = [];
    const conditions = [];
    if (status !== "all") {
      params.push(status);
      conditions.push(`circle.status = $${params.length}`);
    }
    if (keyword) {
      params.push(`%${keyword}%`);
      const index = params.length;
      conditions.push(
        `(circle.name ILIKE $${index} OR circle.slogan ILIKE $${index} OR circle.join_code ILIKE $${index} `
        + `OR owner.nickname ILIKE $${index} OR owner.account_name ILIKE $${index})`
      );
    }
    const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.db.query(
      `
      SELECT circle.*, owner.nickname AS owner_name, owner.account_name AS owner_account,
             count(*) OVER()::int AS filtered_total
      FROM incircle_circles circle
      LEFT JOIN incircle_users owner ON owner.id = circle.owner_user_id
      ${whereSql}
      ORDER BY circle.created_at DESC, circle.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `,
      params.concat([limit, offset])
    );
    const circles = result.rows.map((row) => Object.assign(publicCircle(row, null, "", { isSuperAdmin: true }), {
      ownerName: row.owner_name || "未设置",
      ownerAccountMasked: maskAccount(row.owner_account),
    }));
    const total = await totalFromWindowPage(
      this.db,
      result,
      offset,
      `
      SELECT count(*)::int AS total
      FROM incircle_circles circle
      LEFT JOIN incircle_users owner ON owner.id = circle.owner_user_id
      ${whereSql}
      `,
      params
    );
    return {
      isSuperAdmin: true,
      circles,
      total,
      limit,
      offset,
      hasMore: offset + circles.length < total,
    };
  }

  async adminListUsers(body) {
    const auth = await this.requireSuperAdmin(body);
    const keyword = normalizeKeyword(body.keyword || body.search);
    const status = String(body.status || "all").trim();
    const limit = normalizeLimit(body.limit, 20);
    const offset = normalizeOffset(body.offset);
    if (!["all", "active", "blocked", "deleted"].includes(status)) {
      throw new AppError("用户筛选参数无效", { statusCode: 400, errCode: "INVALID_USER_STATUS" });
    }
    const params = [];
    const conditions = [];
    if (status === "all") conditions.push("users.status <> 'deleted'");
    else {
      params.push(status);
      conditions.push(`users.status = $${params.length}`);
    }
    if (keyword) {
      params.push(`%${keyword}%`);
      const index = params.length;
      conditions.push(`(users.nickname ILIKE $${index} OR users.account_name ILIKE $${index} OR users.phone ILIKE $${index})`);
    }
    const result = await this.db.query(
      `
      SELECT users.*,
             (SELECT count(*) FROM incircle_circle_members membership
              WHERE membership.user_id = users.id AND membership.status = 'active')::int AS circle_count,
             (SELECT count(*) FROM incircle_circles circle
              WHERE circle.owner_user_id = users.id)::int AS owned_circle_count,
             count(*) OVER()::int AS filtered_total
      FROM incircle_users users
      WHERE ${conditions.join(" AND ")}
      ORDER BY users.created_at DESC, users.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `,
      params.concat([limit, offset])
    );
    const users = result.rows.map((row) => {
      const source = Object.assign({}, row, { is_super_admin: this.isSuperAdmin(row.openid, row) });
      return Object.assign(publicAdminUser(source), { currentAdmin: String(row.id) === String(auth.user.id) });
    });
    const total = await totalFromWindowPage(
      this.db,
      result,
      offset,
      `SELECT count(*)::int AS total FROM incircle_users users WHERE ${conditions.join(" AND ")}`,
      params
    );
    return { users, total, limit, offset, hasMore: offset + users.length < total };
  }

  async adminUserDetail(body) {
    const auth = await this.requireSuperAdmin(body);
    const userId = String(body.userId || body.id || "");
    if (!isUuid(userId)) throw new AppError("用户参数无效", { statusCode: 400, errCode: "INVALID_USER_ID" });
    const result = await this.db.query(
      `
      SELECT users.*,
             (SELECT count(*) FROM incircle_circle_members membership
              WHERE membership.user_id = users.id AND membership.status = 'active')::int AS circle_count,
             (SELECT count(*) FROM incircle_circles circle
              WHERE circle.owner_user_id = users.id)::int AS owned_circle_count
      FROM incircle_users users
      WHERE users.id = $1
      LIMIT 1
      `,
      [userId]
    );
    const row = result.rows[0];
    if (!row) throw new AppError("用户不存在或已被物理删除", { statusCode: 404, errCode: "USER_NOT_FOUND" });
    const memberships = await this.db.query(
      `
      SELECT membership.id, membership.role, membership.status, membership.joined_at,
             membership.last_entered_at, membership.exited_at,
             circle.id AS circle_id, circle.name AS circle_name, circle.status AS circle_status
      FROM incircle_circle_members membership
      LEFT JOIN incircle_circles circle ON circle.id = membership.circle_id
      WHERE membership.user_id = $1
      ORDER BY CASE WHEN membership.status = 'active' THEN 0 ELSE 1 END,
               COALESCE(membership.last_entered_at, membership.joined_at) DESC
      `,
      [userId]
    );
    const protectedAccount = this.isSuperAdmin(row.openid, row);
    const user = publicAdminUser(Object.assign({}, row, { is_super_admin: protectedAccount }), { detailed: true });
    user.currentAdmin = String(row.id) === String(auth.user.id);
    user.canManage = !protectedAccount && !user.currentAdmin && row.status !== "deleted";
    user.confirmationTarget = row.account_name || row.nickname || String(row.id);
    return {
      user,
      circles: memberships.rows.map((membership) => ({
        membershipId: String(membership.id),
        id: membership.circle_id ? String(membership.circle_id) : "",
        name: membership.circle_name || "已删除圈子",
        role: normalizeMemberRole(membership.role),
        status: membership.status || "active",
        circleStatus: membership.circle_status || "deleted",
        joinedAt: membership.joined_at,
        lastEnteredAt: membership.last_entered_at,
        exitedAt: membership.exited_at,
      })),
      deleteImpact: {
        ownedCircleCount: Number(row.owned_circle_count || 0),
        membershipCount: Number(row.circle_count || 0),
      },
    };
  }

  assertAdminTargetAllowed(auth, target, action) {
    if (!target) throw new AppError("用户不存在或已被物理删除", { statusCode: 404, errCode: "USER_NOT_FOUND" });
    if (String(target.id) === String(auth.user.id)) {
      throw new AppError(`不能${action}当前登录的超管`, { statusCode: 409, errCode: "CANNOT_MANAGE_SELF" });
    }
    if (this.isSuperAdmin(target.openid, target)) {
      throw new AppError(`不能${action}超管账号`, { statusCode: 409, errCode: "PROTECTED_SUPER_ADMIN" });
    }
    if (target.status === "deleted") {
      throw new AppError("账号已经注销", { statusCode: 409, errCode: "ACCOUNT_DELETED" });
    }
  }

  async adminUpdateUserStatus(body) {
    const auth = await this.requireSuperAdmin(body);
    const userId = String(body.userId || body.id || "");
    const status = String(body.status || "");
    if (!isUuid(userId) || !["active", "blocked"].includes(status)) {
      throw new AppError("用户状态参数无效", { statusCode: 400, errCode: "INVALID_USER_STATUS" });
    }
    const reason = sanitizeTimelineText(body.reason || "超管手动封禁").slice(0, 200);
    await this.db.withTransaction(async () => {
      const locked = await this.db.query("SELECT * FROM incircle_users WHERE id = $1 FOR UPDATE", [userId]);
      const target = locked.rows[0];
      this.assertAdminTargetAllowed(auth, target, status === "blocked" ? "封禁" : "解封");
      await this.db.query(
        `
        UPDATE incircle_users
        SET status = $2,
            blocked_at = CASE WHEN $2 = 'blocked' THEN now() ELSE NULL END,
            blocked_by_user_id = CASE WHEN $2 = 'blocked' THEN $3::uuid ELSE NULL END,
            blocked_reason = CASE WHEN $2 = 'blocked' THEN $4 ELSE '' END,
            logged_in = false,
            auth_version = auth_version + 1,
            updated_at = now()
        WHERE id = $1
        `,
        [userId, status, auth.user.id, reason]
      );
      await revokeAllAccountSessions(
        this.db,
        userId,
        status === "blocked" ? "账号已被封禁" : "账号状态已更新"
      );
      await this.logOperation(null, auth, status === "blocked" ? "封禁用户" : "解封用户", "user", userId, {
        reason: status === "blocked" ? reason : "",
      });
    });
    return this.adminUserDetail(Object.assign({}, body, { userId }));
  }

  async adminUnbindUserWechat(body) {
    const auth = await this.requireSuperAdmin(body);
    const userId = String(body.userId || body.id || "");
    if (!isUuid(userId)) throw new AppError("用户参数无效", { statusCode: 400, errCode: "INVALID_USER_ID" });
    await this.db.withTransaction(async () => {
      const locked = await this.db.query("SELECT * FROM incircle_users WHERE id = $1 FOR UPDATE", [userId]);
      const target = locked.rows[0];
      this.assertAdminTargetAllowed(auth, target, "解绑");
      await this.db.query(
        `
        UPDATE incircle_users
        SET openid = NULL, unionid = NULL, wechat_bound = false, wechat_nickname = '',
            logged_in = false, auth_version = auth_version + 1,
            wechat_unbound_at = now(), updated_at = now()
        WHERE id = $1
        `,
        [userId]
      );
      await this.db.query("UPDATE incircle_circle_members SET openid = '', updated_at = now() WHERE user_id = $1", [userId]);
      await this.db.query("UPDATE incircle_member_cards SET openid = '', updated_at = now() WHERE user_id = $1", [userId]);
      await revokeAllAccountSessions(this.db, userId, "微信绑定已解除");
      await this.logOperation(null, auth, "解绑用户微信", "user", userId, {});
    });
    return this.adminUserDetail(Object.assign({}, body, { userId }));
  }

  async collectCircleUploadPaths(circleIds) {
    if (!circleIds || !circleIds.length) return [];
    const tables = [
      "incircle_activities", "incircle_bills", "incircle_votes", "incircle_checkins", "incircle_docs", "incircle_decision_makers",
    ];
    const [resultSets, qrCodes] = await Promise.all([
      Promise.all(tables.map((table) => this.db.query(`SELECT payload FROM ${table} WHERE circle_id = ANY($1::uuid[])`, [circleIds]))),
      this.db.query("SELECT relative_path FROM incircle_circle_qr_codes WHERE circle_id = ANY($1::uuid[])", [circleIds]),
    ]);
    const paths = new Set();
    resultSets.forEach((result) => result.rows.forEach((row) => collectUploadRelativePaths(row.payload, paths)));
    qrCodes.rows.forEach((row) => {
      const relativePath = managedUploadRelativePath(row.relative_path);
      if (relativePath) paths.add(relativePath);
    });
    return Array.from(paths);
  }

  async adminDeleteUser(body) {
    const auth = await this.requireSuperAdmin(body);
    const userId = String(body.userId || body.id || "");
    if (!isUuid(userId)) throw new AppError("用户参数无效", { statusCode: 400, errCode: "INVALID_USER_ID" });
    const result = await this.db.withTransaction(async () => {
      const locked = await this.db.query("SELECT * FROM incircle_users WHERE id = $1 FOR UPDATE", [userId]);
      const target = locked.rows[0];
      this.assertAdminTargetAllowed(auth, target, "删除");
      const confirmationTarget = target.account_name || target.nickname || String(target.id);
      if (String(body.confirmation || "").trim() !== confirmationTarget || body.confirmOwnedCircles !== true) {
        throw new AppError("请输入完整账号并确认删除名下圈子", {
          statusCode: 400,
          errCode: "DELETE_USER_CONFIRMATION_REQUIRED",
          details: { confirmationTarget },
        });
      }
      const ownedResult = await this.db.query("SELECT id FROM incircle_circles WHERE owner_user_id = $1 FOR UPDATE", [userId]);
      const ownedCircleIds = ownedResult.rows.map((circle) => String(circle.id));
      const mediaPaths = new Set(await this.collectCircleUploadPaths(ownedCircleIds));
      collectUploadRelativePaths(target.avatar_url, mediaPaths);
      const cardMediaResult = await this.db.query(
        "SELECT avatar_url, payload FROM incircle_member_cards WHERE user_id = $1",
        [userId]
      );
      cardMediaResult.rows.forEach((card) => {
        collectUploadRelativePaths(card.avatar_url, mediaPaths);
        collectUploadRelativePaths(card.payload, mediaPaths);
      });
      const membershipResult = await this.db.query(
        "SELECT count(*)::int AS total FROM incircle_circle_members WHERE user_id = $1 AND status = 'active'",
        [userId]
      );
      if (ownedCircleIds.length) {
        await this.db.query("UPDATE incircle_users SET current_circle_id = NULL, updated_at = now() WHERE current_circle_id = ANY($1::uuid[])", [ownedCircleIds]);
      }
      const businessIdentityPatches = {
        incircle_activities: { creatorName: "已删除用户", createdByName: "已删除用户", hostName: "已删除用户" },
        incircle_bills: { creatorName: "已删除用户", createdByName: "已删除用户" },
        incircle_votes: { creatorName: "已删除用户", createdByName: "已删除用户" },
        incircle_checkins: { creatorName: "已删除用户", createdByName: "已删除用户" },
        incircle_docs: {
          creatorName: "已删除用户",
          createdByName: "已删除用户",
          authorName: "已删除用户",
          ownerName: "已删除用户",
          owner: "已删除用户",
        },
        incircle_decision_makers: { creatorName: "已删除用户", createdByName: "已删除用户" },
      };
      for (const [table, identityPatch] of Object.entries(businessIdentityPatches)) {
        await this.db.query(
          `
          UPDATE ${table}
          SET payload = (payload
                - 'creatorOpenid' - 'ownerOpenid' - 'hostOpenid' - 'authorOpenid'
                - 'createdByOpenid' - '_openid')
              || $3::jsonb,
              updated_at = now()
          WHERE created_by_user_id = $1
            AND NOT (circle_id = ANY($2::uuid[]))
          `,
          [userId, ownedCircleIds, JSON.stringify(identityPatch)]
        );
      }
      await this.db.query(
        "UPDATE incircle_score_logs SET payload = payload || '{\"memberName\":\"已删除用户\",\"avatar\":\"/images/avatar.png\"}'::jsonb WHERE user_id = $1",
        [userId]
      );
      await this.db.query(
        "UPDATE incircle_operation_logs SET payload = payload - 'actorOpenid' || '{\"actorName\":\"已删除用户\"}'::jsonb WHERE actor_user_id = $1",
        [userId]
      );
      if (ownedCircleIds.length) {
        await this.db.query("DELETE FROM incircle_circles WHERE id = ANY($1::uuid[])", [ownedCircleIds]);
      }
      await this.db.query("DELETE FROM incircle_users WHERE id = $1", [userId]);
      await this.logOperation(null, auth, "物理删除用户", "user", userId, {
        ownedCircleCount: ownedCircleIds.length,
        membershipCount: Number((membershipResult.rows[0] && membershipResult.rows[0].total) || 0),
      });
      return {
        deleted: true,
        userId,
        ownedCircleIds,
        ownedCircleCount: ownedCircleIds.length,
        membershipCount: Number((membershipResult.rows[0] && membershipResult.rows[0].total) || 0),
        mediaPaths: Array.from(mediaPaths),
        previousOpenid: target.openid || "",
      };
    });
    const cleanup = bestEffortCleanupManagedUploads(this.config, {
      relativePaths: result.mediaPaths,
      circleIds: result.ownedCircleIds,
      userId,
      openid: result.previousOpenid,
    });
    if (cleanup.failed.length) {
      await this.logOperation(null, auth, "用户媒体清理待处理", "user", userId, { failedCount: cleanup.failed.length }).catch(() => {});
    }
    return Object.assign({}, result, {
      mediaPaths: undefined,
      previousOpenid: undefined,
      mediaCleanupFailedCount: cleanup.failed.length,
    });
  }

  async adminOperationLogs(body) {
    const auth = await this.requireUser(body);
    if (!this.isSuperAdmin(auth.identity.openid, auth.user)) {
      throw new AppError("只有超管可以访问", { statusCode: 403, errCode: "FORBIDDEN" });
    }
    const keyword = normalizeKeyword(body.keyword || body.search);
    const actorUserId = String(body.actorUserId || "").trim();
    const limit = normalizeLimit(body.limit, 20);
    const offset = normalizeOffset(body.offset);
    const params = [];
    const conditions = [];

    if (actorUserId && actorUserId !== "all") {
      if (!isUuid(actorUserId)) throw new AppError("人员筛选参数无效", { statusCode: 400, errCode: "INVALID_ACTOR_ID" });
      params.push(actorUserId);
      conditions.push(`logs.actor_user_id = $${params.length}::uuid`);
    }

    if (keyword) {
      params.push(`%${keyword}%`);
      const index = params.length;
      conditions.push(
        `(logs.action ILIKE $${index} OR logs.target_type ILIKE $${index} OR logs.target_id ILIKE $${index} OR logs.payload::text ILIKE $${index} OR users.nickname ILIKE $${index} OR circles.name ILIKE $${index})`
      );
    }

    const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const listParams = params.concat([limit, offset]);
    const logsResult = await this.db.query(
      `
      SELECT logs.*, users.nickname AS actor_name, circles.name AS circle_name
      FROM incircle_operation_logs logs
      LEFT JOIN incircle_users users ON users.id = logs.actor_user_id
      LEFT JOIN incircle_circles circles ON circles.id = logs.circle_id
      ${whereSql}
      ORDER BY logs.created_at DESC, logs.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `,
      listParams
    );
    const totalResult = await this.db.query(
      `
      SELECT count(*)::int AS total
      FROM incircle_operation_logs logs
      LEFT JOIN incircle_users users ON users.id = logs.actor_user_id
      LEFT JOIN incircle_circles circles ON circles.id = logs.circle_id
      ${whereSql}
      `,
      params
    );
    const actorsResult = await this.db.query(
      `
      SELECT DISTINCT ON (users.id)
        users.id, users.nickname, users.avatar_url
      FROM incircle_operation_logs logs
      JOIN incircle_users users ON users.id = logs.actor_user_id
      ORDER BY users.id, users.nickname ASC
      `
    );
    const total = totalResult.rows[0] ? totalResult.rows[0].total || 0 : 0;
    return {
      logs: logsResult.rows.map(publicAdminOperationLog),
      actors: actorsResult.rows.map((row) => ({
        id: String(row.id),
        name: row.nickname || "用户",
        avatar: safeAvatarUrl(row.avatar_url, "/images/avatar.png"),
      })),
      total,
      limit,
      offset,
      hasMore: offset + logsResult.rows.length < total,
    };
  }

  async adminDeleteOperationLogs(body) {
    const auth = await this.requireUser(body);
    if (!this.isSuperAdmin(auth.identity.openid, auth.user)) {
      throw new AppError("只有超管可以操作", { statusCode: 403, errCode: "FORBIDDEN" });
    }
    const rawIds = Array.isArray(body.ids) ? body.ids : body.id ? [body.id] : [];
    const ids = rawIds.map((id) => String(id || "").trim()).filter(Boolean);
    if (ids.length) {
      const invalidId = ids.find((id) => !isUuid(id));
      if (invalidId) throw new AppError("日志参数无效", { statusCode: 400, errCode: "INVALID_LOG_ID" });
      const result = await this.db.query("DELETE FROM incircle_operation_logs WHERE id = ANY($1::uuid[])", [ids]);
      return { deletedCount: result.rowCount || 0 };
    }

    const keyword = normalizeKeyword(body.keyword || body.search);
    const actorUserId = String(body.actorUserId || "").trim();
    const deleteAll = body.deleteAll === true || body.all === true;
    const params = [];
    const conditions = [];

    if (actorUserId && actorUserId !== "all") {
      if (!isUuid(actorUserId)) throw new AppError("人员筛选参数无效", { statusCode: 400, errCode: "INVALID_ACTOR_ID" });
      params.push(actorUserId);
      conditions.push(`logs.actor_user_id = $${params.length}::uuid`);
    }

    if (keyword) {
      params.push(`%${keyword}%`);
      const index = params.length;
      conditions.push(
        `(logs.action ILIKE $${index} OR logs.target_type ILIKE $${index} OR logs.target_id ILIKE $${index} OR logs.payload::text ILIKE $${index} OR users.nickname ILIKE $${index} OR circles.name ILIKE $${index})`
      );
    }

    if (!conditions.length && !deleteAll) {
      throw new AppError("请指定要删除的日志或确认清空全部日志", {
        statusCode: 400,
        errCode: "DELETE_LOGS_CONFIRM_REQUIRED",
      });
    }

    const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.db.query(
      `
      DELETE FROM incircle_operation_logs
      WHERE id IN (
        SELECT logs.id
        FROM incircle_operation_logs logs
        LEFT JOIN incircle_users users ON users.id = logs.actor_user_id
        LEFT JOIN incircle_circles circles ON circles.id = logs.circle_id
        ${whereSql}
      )
      `,
      params
    );
    return { deletedCount: result.rowCount || 0 };
  }

  async adminUpdateCircleStatus(body) {
    const auth = await this.requireSuperAdmin(body);
    const status = String(body.status || "").trim();
    if (!["active", "frozen", "closed"].includes(status)) {
      throw new AppError("圈子状态参数无效", { statusCode: 400, errCode: "INVALID_CIRCLE_STATUS" });
    }
    const updated = await this.db.query("UPDATE incircle_circles SET status = $2, updated_at = now() WHERE id = $1 RETURNING *", [
      body.circleId,
      status,
    ]);
    if (!updated.rows[0]) throw new AppError("圈子不存在", { statusCode: 404, errCode: "CIRCLE_NOT_FOUND" });
    await this.logOperation(body.circleId, auth, status === "active" ? "超管解冻圈子" : "超管冻结圈子", "circle", body.circleId, {
      status,
    });
    return { circle: publicCircle(updated.rows[0], null, "", { isSuperAdmin: true }) };
  }

  async adminDeleteCircle(body) {
    const auth = await this.requireSuperAdmin(body);
    const circleId = String(body.circleId || "");
    if (!isUuid(circleId)) throw new AppError("圈子参数无效", { statusCode: 400, errCode: "INVALID_CIRCLE_ID" });
    const mediaPaths = await this.collectCircleUploadPaths([circleId]);
    await this.db.withTransaction(async () => {
      const existed = await this.db.query("SELECT id, name FROM incircle_circles WHERE id = $1 FOR UPDATE", [circleId]);
      if (!existed.rows[0]) throw new AppError("圈子不存在", { statusCode: 404, errCode: "CIRCLE_NOT_FOUND" });
      await this.db.query("UPDATE incircle_users SET current_circle_id = NULL, updated_at = now() WHERE current_circle_id = $1", [circleId]);
      await this.logOperation(circleId, auth, "超管删除圈子", "circle", circleId, { circleName: existed.rows[0].name || "" });
      await this.db.query("DELETE FROM incircle_circles WHERE id = $1", [circleId]);
    });
    const cleanup = bestEffortCleanupManagedUploads(this.config, { relativePaths: mediaPaths, circleIds: [circleId] });
    if (cleanup.failed.length) {
      await this.logOperation(null, auth, "圈子媒体清理待处理", "circle", circleId, { failedCount: cleanup.failed.length }).catch(() => {});
    }
    return { deleted: true, circleId, mediaCleanupFailedCount: cleanup.failed.length };
  }

  async removeCircleMember(body) {
    const auth = await this.requireUser(body);
    const circleId = String(body.circleId || "");
    const targetMembershipId = String(body.membershipId || body.targetMembershipId || "");
    if (!isUuid(circleId) || !isUuid(targetMembershipId)) {
      throw new AppError("成员参数无效", { statusCode: 400, errCode: "INVALID_MEMBER_ID" });
    }
    const viewerResult = await this.db.query(
      "SELECT * FROM incircle_circle_members WHERE circle_id = $1 AND user_id = $2 AND status = 'active' LIMIT 1",
      [circleId, auth.user.id]
    );
    const viewer = viewerResult.rows[0];
    if (!viewer || !isOwnerRole(viewer.role)) {
      throw new AppError("只有圈主可以移除成员", { statusCode: 403, errCode: "FORBIDDEN" });
    }
    const targetResult = await this.db.query(
      `
      SELECT membership.*, circle.owner_user_id
      FROM incircle_circle_members membership
      JOIN incircle_circles circle ON circle.id = membership.circle_id
      WHERE membership.circle_id = $1
        AND membership.id = $2
        AND membership.status = 'active'
      LIMIT 1
      `,
      [circleId, targetMembershipId]
    );
    const target = targetResult.rows[0];
    if (!target) throw new AppError("成员不存在或已经离开圈子", { statusCode: 404, errCode: "MEMBER_NOT_FOUND" });
    if (isOwnerRole(target.role) || String(target.user_id) === String(target.owner_user_id)) {
      throw new AppError("圈主不能被移除，只能由圈主解散圈子", { statusCode: 409, errCode: "OWNER_CANNOT_BE_REMOVED" });
    }
    if (String(target.user_id) === String(auth.user.id)) {
      throw new AppError("请使用退出圈子功能离开当前圈子", { statusCode: 409, errCode: "USE_EXIT_CIRCLE" });
    }
    await this.db.withTransaction(async () => {
      await this.db.query("DELETE FROM incircle_ai_reports WHERE circle_id = $1 AND user_id = $2", [circleId, target.user_id]);
      await this.db.query("DELETE FROM incircle_ai_consents WHERE circle_id = $1 AND user_id = $2", [circleId, target.user_id]);
      await this.db.query("DELETE FROM incircle_ai_conversations WHERE circle_id = $1 AND user_id = $2", [circleId, target.user_id]);
      await this.db.query(
        `
        UPDATE incircle_circle_members
        SET status = 'removed',
            removed_by_user_id = $3,
            removed_reason = $2,
            exited_at = now(),
            updated_at = now()
        WHERE id = $1
        `,
        [target.id, body.reason || "圈主移除成员", auth.user.id]
      );
      await this.db.query(
        `
        UPDATE incircle_circles SET
          member_count = (SELECT count(*) FROM incircle_circle_members WHERE circle_id = $1 AND status = 'active'),
          updated_at = now()
        WHERE id = $1
        `,
        [circleId]
      );
      await this.db.query(
        "UPDATE incircle_users SET current_circle_id = NULL, updated_at = now() WHERE id = $1 AND current_circle_id = $2",
        [target.user_id, circleId]
      );
      await this.logOperation(circleId, auth, "移除圈内成员", "member", target.id, {
        targetName: target.member_name || "成员",
        reason: body.reason || "圈主移除成员",
      });
    });
    return this.circleSettings(Object.assign({}, body, { circleId }));
  }

  async inviteQrCode(body) {
    const settings = await this.circleSettings(body);
    const circleId = String(settings.circle && settings.circle.id || "");
    const page = "pages/circle-join/index";
    const envVersion = normalizeQrEnvVersion(this.config.wechatQrEnvVersion);
    const generated = await this.db.withTransaction(async () => {
      const circleResult = await this.db.query(
        "SELECT id, join_code, invite_token FROM incircle_circles WHERE id = $1 FOR UPDATE",
        [circleId]
      );
      const circle = circleResult.rows[0];
      if (!circle) throw new AppError("圈子不存在", { statusCode: 404, errCode: "CIRCLE_NOT_FOUND" });
      if (!isValidInviteToken(circle.invite_token)) {
        throw new AppError("圈子邀请入口尚未初始化", { statusCode: 500, errCode: "INVITE_TOKEN_MISSING" });
      }

      const existingResult = await this.db.query(
        "SELECT * FROM incircle_circle_qr_codes WHERE circle_id = $1 LIMIT 1",
        [circleId]
      );
      const existing = existingResult.rows[0];
      const reusable = existing
        && existing.join_code === circle.join_code
        && existing.invite_token === circle.invite_token
        && existing.page === page
        && existing.env_version === envVersion
        && usableQrCodeFile(this.config, existing.relative_path);
      if (reusable) {
        cleanupOtherCircleQrFiles(this.config, circleId, existing.relative_path);
        return { circle, row: existing, reused: true };
      }

      const miniCode = await this.createMiniProgramCode(this.config, {
        scene: circle.invite_token,
        page,
        envVersion,
      });
      const extension = miniCode.extension === "jpg" ? "jpg" : "png";
      const filename = `${safeFilePart(circle.id, "circle")}-invite-${circle.invite_token.slice(0, 12)}-wxacode.${extension}`;
      const relativePath = path.posix.join("qrcodes", filename);
      writeQrCodeFile(this.config, relativePath, miniCode.buffer);
      const stored = await this.db.query(
        `
        INSERT INTO incircle_circle_qr_codes (
          circle_id, join_code, invite_token, page, env_version, relative_path
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (circle_id) DO UPDATE SET
          join_code = EXCLUDED.join_code,
          invite_token = EXCLUDED.invite_token,
          page = EXCLUDED.page,
          env_version = EXCLUDED.env_version,
          relative_path = EXCLUDED.relative_path,
          updated_at = now()
        RETURNING *
        `,
        [circle.id, circle.join_code, circle.invite_token, page, miniCode.envVersion || envVersion, relativePath]
      );
      cleanupOtherCircleQrFiles(this.config, circleId, stored.rows[0].relative_path);
      return { circle, row: stored.rows[0], reused: false };
    });
    return publicInviteQrCode(this.config, this.request, generated.circle, generated.row, generated.reused);
  }
}

module.exports = {
  InCircleService,
  __test: {
    checkinRuntimeMetrics,
    createInviteToken,
    createJoinCode,
    friendlyTagWallState,
    invitePagePath,
    isValidInviteToken,
    isValidJoinCode,
    memberCardFromRow,
    normalizeCheckinMedia,
    scoreLeaderboard,
    cleanupManagedUploads,
    usableQrCodeFile,
  },
};
