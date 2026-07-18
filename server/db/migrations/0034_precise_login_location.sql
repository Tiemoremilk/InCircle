ALTER TABLE incircle_users
  ADD COLUMN IF NOT EXISTS precise_login_location_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE incircle_account_sessions
  ADD COLUMN IF NOT EXISTS login_location_source text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS login_latitude double precision,
  ADD COLUMN IF NOT EXISTS login_longitude double precision,
  ADD COLUMN IF NOT EXISTS login_accuracy_m double precision,
  ADD COLUMN IF NOT EXISTS login_location_province text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS login_location_city text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS login_location_district text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS login_location_detail text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS login_location_captured_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_incircle_account_session_location_source'
  ) THEN
    ALTER TABLE incircle_account_sessions
      ADD CONSTRAINT chk_incircle_account_session_location_source
      CHECK (login_location_source IN ('', 'wx.getLocation'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_incircle_account_session_location_coordinates'
  ) THEN
    ALTER TABLE incircle_account_sessions
      ADD CONSTRAINT chk_incircle_account_session_location_coordinates
      CHECK (
        (login_latitude IS NULL AND login_longitude IS NULL)
        OR (
          login_latitude BETWEEN -90 AND 90
          AND login_longitude BETWEEN -180 AND 180
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_incircle_account_session_location_accuracy'
  ) THEN
    ALTER TABLE incircle_account_sessions
      ADD CONSTRAINT chk_incircle_account_session_location_accuracy
      CHECK (login_accuracy_m IS NULL OR login_accuracy_m BETWEEN 0 AND 100000);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_incircle_account_sessions_location_retention
  ON incircle_account_sessions(login_location_captured_at)
  WHERE login_location_captured_at IS NOT NULL;

-- This one-time legal update is tied to the precise login-location release.
-- A database already moved to another version remains authoritative.
UPDATE incircle_public_legal_profile
SET terms_version = '2026-07-18',
    privacy_version = '2026-07-18',
    effective_date = DATE '2026-07-18',
    updated_at = now()
WHERE singleton_id = 1
  AND terms_version = '2026-07-16'
  AND privacy_version = '2026-07-16';
