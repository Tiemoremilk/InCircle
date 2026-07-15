ALTER TABLE incircle_users
  ADD COLUMN IF NOT EXISTS terms_version text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS privacy_version text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS agreements_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS agreement_acceptance_source text NOT NULL DEFAULT '';

ALTER TABLE incircle_users DROP CONSTRAINT IF EXISTS chk_incircle_agreement_acceptance_source;
ALTER TABLE incircle_users
  ADD CONSTRAINT chk_incircle_agreement_acceptance_source
  CHECK (agreement_acceptance_source IN ('', 'login', 'register', 'bind', 'reset', 'session'));

CREATE TABLE IF NOT EXISTS incircle_account_agreement_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES incircle_users(id) ON DELETE CASCADE,
  terms_version text NOT NULL,
  privacy_version text NOT NULL,
  acceptance_source text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_incircle_account_acceptance_source
    CHECK (acceptance_source IN ('login', 'register', 'bind', 'reset', 'session')),
  CONSTRAINT uq_incircle_account_acceptance_version
    UNIQUE (user_id, terms_version, privacy_version)
);

CREATE INDEX IF NOT EXISTS idx_incircle_account_acceptances_user_time
  ON incircle_account_agreement_acceptances(user_id, accepted_at DESC);

CREATE OR REPLACE FUNCTION incircle_record_account_agreement_acceptance()
RETURNS trigger AS $$
BEGIN
  IF NEW.agreements_accepted_at IS NOT NULL
     AND NEW.terms_version <> ''
     AND NEW.privacy_version <> ''
     AND NEW.agreement_acceptance_source <> ''
     AND (
       OLD.agreements_accepted_at IS DISTINCT FROM NEW.agreements_accepted_at
       OR OLD.terms_version IS DISTINCT FROM NEW.terms_version
       OR OLD.privacy_version IS DISTINCT FROM NEW.privacy_version
     ) THEN
    INSERT INTO incircle_account_agreement_acceptances (
      user_id, terms_version, privacy_version, acceptance_source, accepted_at
    ) VALUES (
      NEW.id, NEW.terms_version, NEW.privacy_version,
      NEW.agreement_acceptance_source, NEW.agreements_accepted_at
    ) ON CONFLICT (user_id, terms_version, privacy_version) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_incircle_users_record_agreement_acceptance ON incircle_users;
CREATE TRIGGER trg_incircle_users_record_agreement_acceptance
AFTER UPDATE OF terms_version, privacy_version, agreements_accepted_at ON incircle_users
FOR EACH ROW EXECUTE FUNCTION incircle_record_account_agreement_acceptance();
