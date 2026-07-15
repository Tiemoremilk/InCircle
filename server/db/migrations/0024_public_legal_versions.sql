ALTER TABLE incircle_public_legal_profile
  ADD COLUMN IF NOT EXISTS terms_version text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS privacy_version text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS effective_date date;

ALTER TABLE incircle_public_legal_profile
  DROP CONSTRAINT IF EXISTS chk_incircle_public_legal_terms_version;
ALTER TABLE incircle_public_legal_profile
  ADD CONSTRAINT chk_incircle_public_legal_terms_version CHECK (
    char_length(terms_version) <= 40
    AND terms_version !~ '[\r\n]'
  );

ALTER TABLE incircle_public_legal_profile
  DROP CONSTRAINT IF EXISTS chk_incircle_public_legal_privacy_version;
ALTER TABLE incircle_public_legal_profile
  ADD CONSTRAINT chk_incircle_public_legal_privacy_version CHECK (
    char_length(privacy_version) <= 40
    AND privacy_version !~ '[\r\n]'
  );
