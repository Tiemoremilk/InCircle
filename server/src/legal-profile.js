const { AppError } = require("./errors");

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OPERATOR_TYPES = new Set(["individual", "enterprise"]);

function normalizeDateOnly(value) {
  if (!value) return "";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return String(value).trim().slice(0, 10);
}

function normalizePublicLegalProfile(source) {
  const profile = source || {};
  return {
    operatorType: String(profile.operatorType || profile.operator_type || "individual").trim().toLowerCase(),
    operatorName: String(profile.operatorName || profile.operator_name || "").trim(),
    contactEmail: String(profile.contactEmail || profile.contact_email || "").trim().toLowerCase(),
    termsVersion: String(profile.termsVersion || profile.terms_version || "").trim(),
    privacyVersion: String(profile.privacyVersion || profile.privacy_version || "").trim(),
    effectiveDate: normalizeDateOnly(profile.effectiveDate || profile.effective_date),
  };
}

function validatePublicLegalProfile(source, options) {
  const profile = normalizePublicLegalProfile(source);
  const allowEmpty = !!(options && options.allowEmpty);
  if (
    allowEmpty
    && !profile.operatorName
    && !profile.contactEmail
    && !profile.termsVersion
    && !profile.privacyVersion
    && !profile.effectiveDate
  ) return profile;
  if (!OPERATOR_TYPES.has(profile.operatorType)) {
    throw new Error("LEGAL_OPERATOR_TYPE must be individual or enterprise.");
  }
  if (!profile.operatorName || profile.operatorName.length > 80 || /[\r\n]/.test(profile.operatorName)) {
    throw new Error("LEGAL_OPERATOR_NAME must contain 1-80 characters without line breaks.");
  }
  if (
    !profile.contactEmail
    || profile.contactEmail.length > 254
    || !EMAIL_PATTERN.test(profile.contactEmail)
  ) {
    throw new Error("LEGAL_CONTACT_EMAIL must be a valid email address.");
  }
  if (!profile.termsVersion || profile.termsVersion.length > 40 || /[\r\n]/.test(profile.termsVersion)) {
    throw new Error("LEGAL_TERMS_VERSION must contain 1-40 characters without line breaks.");
  }
  if (!profile.privacyVersion || profile.privacyVersion.length > 40 || /[\r\n]/.test(profile.privacyVersion)) {
    throw new Error("LEGAL_PRIVACY_VERSION must contain 1-40 characters without line breaks.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(profile.effectiveDate)) {
    throw new Error("LEGAL_EFFECTIVE_DATE must use YYYY-MM-DD.");
  }
  const [year, month, day] = profile.effectiveDate.split("-").map(Number);
  const parsedDate = new Date(Date.UTC(year, month - 1, day));
  if (
    parsedDate.getUTCFullYear() !== year
    || parsedDate.getUTCMonth() !== month - 1
    || parsedDate.getUTCDate() !== day
  ) {
    throw new Error("LEGAL_EFFECTIVE_DATE must be a real calendar date.");
  }
  return profile;
}

function isCompletePublicLegalProfile(profile) {
  return !!(
    profile.operatorName
    && profile.contactEmail
    && profile.termsVersion
    && profile.privacyVersion
    && profile.effectiveDate
  );
}

function hasPublicLegalDetails(profile) {
  return !!(
    profile.operatorName
    || profile.contactEmail
    || profile.termsVersion
    || profile.privacyVersion
    || profile.effectiveDate
  );
}

async function lockPublicLegalProfile(db) {
  let result = await db.query(
    `SELECT operator_type, operator_name, contact_email, terms_version, privacy_version, effective_date, updated_at
     FROM incircle_public_legal_profile WHERE singleton_id = 1 FOR UPDATE`
  );
  if (result.rows[0]) return result.rows[0];
  await db.query(
    "INSERT INTO incircle_public_legal_profile (singleton_id) VALUES (1) ON CONFLICT (singleton_id) DO NOTHING"
  );
  result = await db.query(
    `SELECT operator_type, operator_name, contact_email, terms_version, privacy_version, effective_date, updated_at
     FROM incircle_public_legal_profile WHERE singleton_id = 1 FOR UPDATE`
  );
  return result.rows[0] || {};
}

async function reconcilePublicLegalProfile(db, config, options) {
  const configured = normalizePublicLegalProfile({
    operatorType: config && config.legalOperatorType,
    operatorName: config && config.legalOperatorName,
    contactEmail: config && config.legalContactEmail,
    termsVersion: config && config.legalTermsVersion,
    privacyVersion: config && config.legalPrivacyVersion,
    effectiveDate: config && config.legalEffectiveDate,
  });
  const currentRow = await lockPublicLegalProfile(db);
  const current = normalizePublicLegalProfile(currentRow);
  const initializeOperatorType = !!(options && options.initializeOperatorType);
  const updates = [];
  const values = [];
  const next = Object.assign({}, current);
  const queueUpdate = (key, column, value, cast) => {
    values.push(value);
    updates.push({ key, sql: `${column} = $${values.length}${cast || ""}` });
    next[key] = value;
  };

  if (!OPERATOR_TYPES.has(configured.operatorType)) {
    throw new Error("LEGAL_OPERATOR_TYPE must be individual or enterprise.");
  }
  if (
    (initializeOperatorType || !hasPublicLegalDetails(current))
    && current.operatorType !== configured.operatorType
  ) {
    queueUpdate("operatorType", "operator_type", configured.operatorType);
  }
  if (!current.operatorName && configured.operatorName) {
    queueUpdate("operatorName", "operator_name", configured.operatorName);
  }
  if (!current.contactEmail && configured.contactEmail) {
    queueUpdate("contactEmail", "contact_email", configured.contactEmail);
  }
  if (!current.termsVersion && configured.termsVersion) {
    queueUpdate("termsVersion", "terms_version", configured.termsVersion);
  }
  if (!current.privacyVersion && configured.privacyVersion) {
    queueUpdate("privacyVersion", "privacy_version", configured.privacyVersion);
  }
  if (!current.effectiveDate && configured.effectiveDate) {
    queueUpdate("effectiveDate", "effective_date", configured.effectiveDate, "::date");
  }

  const detailUpdates = updates.some((item) => item.key !== "operatorType");
  if (detailUpdates || isCompletePublicLegalProfile(next)) validatePublicLegalProfile(next);
  if (!updates.length) {
    return { configured: isCompletePublicLegalProfile(current), profile: current, initializedFields: [] };
  }

  const result = await db.query(
    `
    UPDATE incircle_public_legal_profile SET
      ${updates.map((item) => item.sql).join(",\n      ")},
      updated_at = now()
    WHERE singleton_id = 1
    RETURNING operator_type, operator_name, contact_email, terms_version, privacy_version, effective_date, updated_at
    `,
    values
  );
  const profile = normalizePublicLegalProfile(result.rows[0] || next);
  return {
    configured: isCompletePublicLegalProfile(profile),
    profile,
    initializedFields: updates.map((item) => item.key),
  };
}

async function readPublicLegalProfile(db) {
  const result = await db.query(
    `SELECT operator_type, operator_name, contact_email, terms_version, privacy_version, effective_date, updated_at
     FROM incircle_public_legal_profile WHERE singleton_id = 1`
  );
  const row = result.rows[0] || {};
  let profile;
  try {
    profile = validatePublicLegalProfile(row);
  } catch (error) {
    throw new AppError("协议公开信息尚未配置，请稍后再试", {
      statusCode: 503,
      errCode: "PUBLIC_LEGAL_PROFILE_NOT_CONFIGURED",
    });
  }
  return Object.assign(profile, { updatedAt: row.updated_at || null });
}

module.exports = {
  normalizePublicLegalProfile,
  readPublicLegalProfile,
  reconcilePublicLegalProfile,
  validatePublicLegalProfile,
};
