CREATE TABLE IF NOT EXISTS incircle_public_legal_profile (
  singleton_id smallint PRIMARY KEY DEFAULT 1,
  operator_name text NOT NULL DEFAULT '',
  contact_email text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_incircle_public_legal_profile_singleton CHECK (singleton_id = 1),
  CONSTRAINT chk_incircle_public_legal_operator_name CHECK (
    char_length(operator_name) <= 80
    AND operator_name !~ '[\r\n]'
  ),
  CONSTRAINT chk_incircle_public_legal_contact_email CHECK (
    char_length(contact_email) <= 254
    AND contact_email !~ '[\r\n]'
  )
);

INSERT INTO incircle_public_legal_profile (singleton_id)
VALUES (1)
ON CONFLICT (singleton_id) DO NOTHING;

DROP TRIGGER IF EXISTS trg_incircle_public_legal_profile_touch ON incircle_public_legal_profile;
CREATE TRIGGER trg_incircle_public_legal_profile_touch
BEFORE UPDATE ON incircle_public_legal_profile
FOR EACH ROW EXECUTE FUNCTION incircle_touch_updated_at();
