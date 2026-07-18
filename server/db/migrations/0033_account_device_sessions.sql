ALTER TABLE incircle_users
  ADD COLUMN IF NOT EXISTS verify_wechat_on_login boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS incircle_account_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES incircle_users(id) ON DELETE CASCADE,
  device_key_hash text NOT NULL,
  token_version integer NOT NULL DEFAULT 1,
  login_openid_hash text NOT NULL DEFAULT '',
  device_name text NOT NULL DEFAULT '',
  device_brand text NOT NULL DEFAULT '',
  device_model text NOT NULL DEFAULT '',
  platform text NOT NULL DEFAULT '',
  system_version text NOT NULL DEFAULT '',
  wechat_version text NOT NULL DEFAULT '',
  sdk_version text NOT NULL DEFAULT '',
  environment_version text NOT NULL DEFAULT '',
  login_address text NOT NULL DEFAULT '',
  last_login_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_incircle_account_session_device UNIQUE (user_id, device_key_hash),
  CONSTRAINT chk_incircle_account_session_token_version CHECK (token_version >= 1),
  CONSTRAINT chk_incircle_account_session_device_key_hash CHECK (char_length(device_key_hash) = 64),
  CONSTRAINT chk_incircle_account_session_openid_hash CHECK (
    login_openid_hash = '' OR char_length(login_openid_hash) = 64
  )
);

CREATE INDEX IF NOT EXISTS idx_incircle_account_sessions_user_login
  ON incircle_account_sessions(user_id, last_login_at DESC);

CREATE INDEX IF NOT EXISTS idx_incircle_account_sessions_active
  ON incircle_account_sessions(user_id, expires_at DESC)
  WHERE revoked_at IS NULL;

DROP TRIGGER IF EXISTS trg_incircle_account_sessions_updated_at ON incircle_account_sessions;
CREATE TRIGGER trg_incircle_account_sessions_updated_at
BEFORE UPDATE ON incircle_account_sessions
FOR EACH ROW EXECUTE FUNCTION incircle_touch_updated_at();
