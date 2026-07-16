const { AppError } = require("./errors");

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

async function reconcilePublicLegalProfile(db, config) {
  const configured = normalizePublicLegalProfile({
    operatorName: config && config.legalOperatorName,
    contactEmail: config && config.legalContactEmail,
    termsVersion: config && config.legalTermsVersion,
    privacyVersion: config && config.legalPrivacyVersion,
    effectiveDate: config && config.legalEffectiveDate,
  });
  if (
    !configured.operatorName
    && !configured.contactEmail
    && !configured.termsVersion
    && !configured.privacyVersion
    && !configured.effectiveDate
  ) {
    const current = await db.query(
      `SELECT operator_name, contact_email, terms_version, privacy_version, effective_date, updated_at
       FROM incircle_public_legal_profile WHERE singleton_id = 1`
    );
    const profile = normalizePublicLegalProfile(current.rows[0]);
    const complete = !!(
      profile.operatorName
      && profile.contactEmail
      && profile.termsVersion
      && profile.privacyVersion
      && profile.effectiveDate
    );
    return { configured: complete, profile };
  }

  const profile = validatePublicLegalProfile(configured);
  const result = await db.query(
    `
    INSERT INTO incircle_public_legal_profile (
      singleton_id, operator_name, contact_email, terms_version, privacy_version, effective_date
    )
    VALUES (1, $1, $2, $3, $4, $5::date)
    ON CONFLICT (singleton_id) DO UPDATE SET
      operator_name = EXCLUDED.operator_name,
      contact_email = EXCLUDED.contact_email,
      terms_version = EXCLUDED.terms_version,
      privacy_version = EXCLUDED.privacy_version,
      effective_date = EXCLUDED.effective_date,
      updated_at = now()
    RETURNING operator_name, contact_email, terms_version, privacy_version, effective_date, updated_at
    `,
    [
      profile.operatorName,
      profile.contactEmail,
      profile.termsVersion,
      profile.privacyVersion,
      profile.effectiveDate,
    ]
  );
  return { configured: true, profile: normalizePublicLegalProfile(result.rows[0]) };
}

async function readPublicLegalProfile(db) {
  const result = await db.query(
    `SELECT operator_name, contact_email, terms_version, privacy_version, effective_date, updated_at
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
