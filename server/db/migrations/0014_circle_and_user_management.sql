CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE incircle_circle_members
  ADD COLUMN IF NOT EXISTS last_entered_at timestamptz;

UPDATE incircle_circle_members membership
SET last_entered_at = COALESCE(
  CASE
    WHEN users.current_circle_id = membership.circle_id
      THEN GREATEST(membership.joined_at, users.last_login_at)
    ELSE NULL
  END,
  membership.joined_at,
  membership.created_at,
  now()
)
FROM incircle_users users
WHERE users.id = membership.user_id
  AND membership.last_entered_at IS NULL;

UPDATE incircle_circle_members
SET last_entered_at = COALESCE(joined_at, created_at, now())
WHERE last_entered_at IS NULL;

ALTER TABLE incircle_users
  ADD COLUMN IF NOT EXISTS blocked_at timestamptz,
  ADD COLUMN IF NOT EXISTS blocked_by_user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS blocked_reason text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS wechat_unbound_at timestamptz;

UPDATE incircle_users
SET status = 'active'
WHERE status NOT IN ('active', 'blocked', 'deleted');

ALTER TABLE incircle_users DROP CONSTRAINT IF EXISTS chk_incircle_user_status;
ALTER TABLE incircle_users
  ADD CONSTRAINT chk_incircle_user_status CHECK (status IN ('active', 'blocked', 'deleted'));

CREATE INDEX IF NOT EXISTS idx_incircle_members_user_recent
  ON incircle_circle_members(user_id, status, last_entered_at DESC);
CREATE INDEX IF NOT EXISTS idx_incircle_users_status_created
  ON incircle_users(status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_incircle_users_admin_search_trgm
  ON incircle_users USING gin (
    (COALESCE(nickname, '') || ' ' || COALESCE(account_name, '') || ' ' || COALESCE(phone, '')) gin_trgm_ops
  );
CREATE INDEX IF NOT EXISTS idx_incircle_circles_admin_search_trgm
  ON incircle_circles USING gin (
    (COALESCE(name, '') || ' ' || COALESCE(slogan, '') || ' ' || COALESCE(join_code, '')) gin_trgm_ops
  );
