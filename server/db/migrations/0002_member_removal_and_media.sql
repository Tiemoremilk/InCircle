ALTER TABLE incircle_circle_members ADD COLUMN IF NOT EXISTS removed_by_user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL;
ALTER TABLE incircle_circle_members ADD COLUMN IF NOT EXISTS removed_reason text NOT NULL DEFAULT '';
ALTER TABLE incircle_circle_members ADD COLUMN IF NOT EXISTS exited_at timestamptz;

ALTER TABLE incircle_score_rules ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE incircle_score_logs ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE incircle_operation_logs ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;
