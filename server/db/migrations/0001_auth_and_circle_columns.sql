ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS account_name text NOT NULL DEFAULT '';
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS password_iterations integer NOT NULL DEFAULT 0;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS password_digest text NOT NULL DEFAULT '';
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS logged_in boolean NOT NULL DEFAULT false;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS account_bound_at timestamptz;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS wechat_bound_at timestamptz;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS password_updated_at timestamptz;

ALTER TABLE incircle_circle_members ADD COLUMN IF NOT EXISTS openid text NOT NULL DEFAULT '';
ALTER TABLE incircle_circle_members ADD COLUMN IF NOT EXISTS member_name text NOT NULL DEFAULT '';
ALTER TABLE incircle_circle_members ADD COLUMN IF NOT EXISTS member_id_text text NOT NULL DEFAULT '';

ALTER TABLE incircle_member_cards ADD COLUMN IF NOT EXISTS openid text NOT NULL DEFAULT '';
ALTER TABLE incircle_member_cards ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT '成员';

CREATE INDEX IF NOT EXISTS idx_incircle_users_account_key ON incircle_users(account_key);
CREATE INDEX IF NOT EXISTS idx_incircle_members_openid ON incircle_circle_members(openid);
CREATE INDEX IF NOT EXISTS idx_incircle_member_cards_openid ON incircle_member_cards(openid);
