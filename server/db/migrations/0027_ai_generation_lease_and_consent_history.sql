ALTER TABLE incircle_ai_messages
  ADD COLUMN IF NOT EXISTS generation_owner_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS generation_lease_expires_at timestamptz;

UPDATE incircle_ai_messages
SET status = 'failed',
    error_code = 'AI_SERVER_RESTARTED',
    generation_owner_id = '',
    generation_lease_expires_at = NULL
WHERE role = 'assistant' AND status = 'generating';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_incircle_ai_generation_owner_length'
  ) THEN
    ALTER TABLE incircle_ai_messages
      ADD CONSTRAINT chk_incircle_ai_generation_owner_length
      CHECK (char_length(generation_owner_id) <= 128);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_incircle_ai_messages_generation_lease
  ON incircle_ai_messages(generation_lease_expires_at)
  WHERE role = 'assistant' AND status = 'generating';

CREATE TABLE IF NOT EXISTS incircle_ai_consent_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id uuid NOT NULL,
  user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL,
  circle_id uuid REFERENCES incircle_circles(id) ON DELETE SET NULL,
  circle_scope_id uuid NOT NULL,
  provider_id uuid REFERENCES incircle_ai_providers(id) ON DELETE SET NULL,
  provider_scope_id uuid NOT NULL,
  provider_name_snapshot text NOT NULL DEFAULT '',
  provider_domain_snapshot text NOT NULL DEFAULT '',
  privacy_url_snapshot text NOT NULL DEFAULT '',
  privacy_version integer NOT NULL CHECK (privacy_version >= 1),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_incircle_ai_consent_acceptance_version
    UNIQUE (subject_id, circle_scope_id, provider_scope_id, privacy_version)
);

CREATE INDEX IF NOT EXISTS idx_incircle_ai_consent_acceptances_subject
  ON incircle_ai_consent_acceptances(subject_id, accepted_at DESC);

INSERT INTO incircle_ai_consent_acceptances (
  subject_id, user_id, circle_id, circle_scope_id, provider_id, provider_scope_id,
  provider_name_snapshot, provider_domain_snapshot, privacy_url_snapshot,
  privacy_version, accepted_at, created_at
)
SELECT users.agreement_subject_id, consent.user_id, consent.circle_id, consent.circle_id,
  consent.provider_id, consent.provider_id, provider.name, consent.provider_domain,
  provider.privacy_url, consent.privacy_version, consent.granted_at, consent.created_at
FROM incircle_ai_consents consent
JOIN incircle_users users ON users.id = consent.user_id
JOIN incircle_ai_providers provider ON provider.id = consent.provider_id
ON CONFLICT ON CONSTRAINT uq_incircle_ai_consent_acceptance_version DO NOTHING;
