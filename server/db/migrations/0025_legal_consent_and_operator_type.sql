ALTER TABLE incircle_users
  ADD COLUMN IF NOT EXISTS agreement_subject_id uuid;

UPDATE incircle_users
SET agreement_subject_id = gen_random_uuid()
WHERE agreement_subject_id IS NULL;

ALTER TABLE incircle_users
  ALTER COLUMN agreement_subject_id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN agreement_subject_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_incircle_users_agreement_subject_id
  ON incircle_users(agreement_subject_id);

ALTER TABLE incircle_account_agreement_acceptances
  ADD COLUMN IF NOT EXISTS subject_id uuid;

UPDATE incircle_account_agreement_acceptances acceptance
SET subject_id = users.agreement_subject_id
FROM incircle_users users
WHERE acceptance.user_id = users.id
  AND acceptance.subject_id IS NULL;

ALTER TABLE incircle_account_agreement_acceptances
  ALTER COLUMN subject_id SET NOT NULL,
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE incircle_account_agreement_acceptances
  DROP CONSTRAINT IF EXISTS incircle_account_agreement_acceptances_user_id_fkey;
ALTER TABLE incircle_account_agreement_acceptances
  ADD CONSTRAINT incircle_account_agreement_acceptances_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES incircle_users(id) ON DELETE SET NULL;

ALTER TABLE incircle_account_agreement_acceptances
  DROP CONSTRAINT IF EXISTS uq_incircle_account_acceptance_version;
ALTER TABLE incircle_account_agreement_acceptances
  DROP CONSTRAINT IF EXISTS uq_incircle_account_acceptance_subject_version;
ALTER TABLE incircle_account_agreement_acceptances
  ADD CONSTRAINT uq_incircle_account_acceptance_subject_version
  UNIQUE (subject_id, terms_version, privacy_version);

CREATE INDEX IF NOT EXISTS idx_incircle_account_acceptances_subject_time
  ON incircle_account_agreement_acceptances(subject_id, accepted_at DESC);

DROP TRIGGER IF EXISTS trg_incircle_users_record_agreement_acceptance ON incircle_users;
DROP FUNCTION IF EXISTS incircle_record_account_agreement_acceptance();

ALTER TABLE incircle_public_legal_profile
  ADD COLUMN IF NOT EXISTS operator_type text NOT NULL DEFAULT 'individual';

ALTER TABLE incircle_public_legal_profile
  DROP CONSTRAINT IF EXISTS chk_incircle_public_legal_operator_type;
ALTER TABLE incircle_public_legal_profile
  ADD CONSTRAINT chk_incircle_public_legal_operator_type
  CHECK (operator_type IN ('individual', 'enterprise'));
