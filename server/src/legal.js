const { AppError } = require("./errors");

const ACCEPTANCE_SOURCES = new Set(["login", "register", "bind", "reset", "session"]);

function currentAgreementVersions(publicProfile) {
  const profile = publicProfile || {};
  const termsVersion = String(profile.termsVersion || "").trim();
  const privacyVersion = String(profile.privacyVersion || "").trim();
  if (!termsVersion || !privacyVersion) {
    throw new AppError("协议版本尚未配置，请稍后再试", {
      statusCode: 503,
      errCode: "PUBLIC_LEGAL_PROFILE_NOT_CONFIGURED",
    });
  }
  return { termsVersion, privacyVersion };
}

function agreementStatus(user, publicProfile, acceptanceState) {
  const versions = currentAgreementVersions(publicProfile);
  const state = acceptanceState || {};
  const current = state.current || null;
  const latest = state.latest || null;
  const accepted = !!current;
  const required = !!user && !accepted;
  const changedDocuments = [];
  if (required && latest) {
    if (latest.termsVersion !== versions.termsVersion) changedDocuments.push("terms");
    if (latest.privacyVersion !== versions.privacyVersion) changedDocuments.push("privacy");
  }
  return {
    accepted,
    required,
    reason: required ? (latest ? "updated" : "missing") : "",
    termsVersion: versions.termsVersion,
    privacyVersion: versions.privacyVersion,
    acceptedTermsVersion: latest ? latest.termsVersion : "",
    acceptedPrivacyVersion: latest ? latest.privacyVersion : "",
    changedDocuments,
    acceptedAt: accepted ? current.acceptedAt : null,
    lastAcceptedAt: latest ? latest.acceptedAt : null,
  };
}

function requireAgreementAcceptance(body, source, publicProfile) {
  const payload = (body && body.agreementAcceptance) || {};
  const versions = currentAgreementVersions(publicProfile);
  const normalizedSource = ACCEPTANCE_SOURCES.has(source) ? source : "login";
  if (
    payload.accepted !== true ||
    String(payload.termsVersion || "") !== versions.termsVersion ||
    String(payload.privacyVersion || "") !== versions.privacyVersion
  ) {
    throw new AppError("请先阅读并同意《用户服务协议》和《隐私政策》", {
      statusCode: 428,
      errCode: "AGREEMENT_ACCEPTANCE_REQUIRED",
      details: {
        termsVersion: versions.termsVersion,
        privacyVersion: versions.privacyVersion,
      },
    });
  }
  return {
    termsVersion: versions.termsVersion,
    privacyVersion: versions.privacyVersion,
    source: normalizedSource,
  };
}

module.exports = {
  agreementStatus,
  currentAgreementVersions,
  requireAgreementAcceptance,
};
