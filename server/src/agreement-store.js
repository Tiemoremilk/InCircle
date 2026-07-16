const { AppError } = require("./errors");
const { currentAgreementVersions } = require("./legal");

function publicAcceptance(row) {
  if (!row) return null;
  return {
    id: row.id,
    subjectId: row.subject_id,
    termsVersion: row.terms_version,
    privacyVersion: row.privacy_version,
    source: row.acceptance_source,
    acceptedAt: row.accepted_at,
  };
}

async function readAgreementAcceptanceState(db, user, publicProfile) {
  const versions = currentAgreementVersions(publicProfile);
  const subjectId = String((user && user.agreement_subject_id) || "");
  if (!subjectId) return { current: null, latest: null };

  const result = await db.query(
    `
    (
      SELECT 'current' AS acceptance_kind, id, subject_id, terms_version,
             privacy_version, acceptance_source, accepted_at
      FROM incircle_account_agreement_acceptances
      WHERE subject_id = $1 AND terms_version = $2 AND privacy_version = $3
      ORDER BY accepted_at DESC, id DESC
      LIMIT 1
    )
    UNION ALL
    (
      SELECT 'latest' AS acceptance_kind, id, subject_id, terms_version,
             privacy_version, acceptance_source, accepted_at
      FROM incircle_account_agreement_acceptances
      WHERE subject_id = $1
      ORDER BY accepted_at DESC, id DESC
      LIMIT 1
    )
    `,
    [subjectId, versions.termsVersion, versions.privacyVersion]
  );
  const current = result.rows.find((row) => row.acceptance_kind === "current") || null;
  const latest = result.rows.find((row) => row.acceptance_kind === "latest") || null;
  return {
    current: publicAcceptance(current),
    latest: publicAcceptance(latest),
  };
}

async function recordAgreementAcceptance(db, userId, agreement) {
  return db.withTransaction(async () => {
    const locked = await db.query(
      "SELECT id, agreement_subject_id FROM incircle_users WHERE id = $1 FOR UPDATE",
      [userId]
    );
    const user = locked.rows[0];
    if (!user) {
      throw new AppError("账号不存在或已删除", { statusCode: 404, errCode: "USER_NOT_FOUND" });
    }

    const inserted = await db.query(
      `
      INSERT INTO incircle_account_agreement_acceptances (
        user_id, subject_id, terms_version, privacy_version, acceptance_source, accepted_at
      )
      VALUES ($1, $2, $3, $4, $5, now())
      ON CONFLICT ON CONSTRAINT uq_incircle_account_acceptance_subject_version DO NOTHING
      RETURNING id, subject_id, terms_version, privacy_version, acceptance_source, accepted_at
      `,
      [
        user.id,
        user.agreement_subject_id,
        agreement.termsVersion,
        agreement.privacyVersion,
        agreement.source,
      ]
    );

    let acceptance = inserted.rows[0] || null;
    if (!acceptance) {
      const existing = await db.query(
        `
        SELECT id, subject_id, terms_version, privacy_version, acceptance_source, accepted_at
        FROM incircle_account_agreement_acceptances
        WHERE subject_id = $1 AND terms_version = $2 AND privacy_version = $3
        LIMIT 1
        `,
        [user.agreement_subject_id, agreement.termsVersion, agreement.privacyVersion]
      );
      acceptance = existing.rows[0] || null;
    }
    if (!acceptance) {
      throw new AppError("协议确认记录保存失败，请重试", {
        statusCode: 500,
        errCode: "AGREEMENT_ACCEPTANCE_SAVE_FAILED",
      });
    }

    const updated = await db.query(
      `
      UPDATE incircle_users SET
        terms_version = $2,
        privacy_version = $3,
        agreements_accepted_at = $4,
        agreement_acceptance_source = $5,
        updated_at = CASE
          WHEN terms_version IS DISTINCT FROM $2
            OR privacy_version IS DISTINCT FROM $3
            OR agreements_accepted_at IS DISTINCT FROM $4
            OR agreement_acceptance_source IS DISTINCT FROM $5
          THEN now() ELSE updated_at
        END
      WHERE id = $1
      RETURNING *
      `,
      [
        user.id,
        acceptance.terms_version,
        acceptance.privacy_version,
        acceptance.accepted_at,
        acceptance.acceptance_source,
      ]
    );

    return {
      user: updated.rows[0],
      acceptance: publicAcceptance(acceptance),
      created: !!inserted.rows[0],
    };
  });
}

module.exports = {
  readAgreementAcceptanceState,
  recordAgreementAcceptance,
};
