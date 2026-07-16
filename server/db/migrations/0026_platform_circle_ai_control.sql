CREATE TABLE IF NOT EXISTS incircle_platform_settings (
  singleton_id smallint PRIMARY KEY DEFAULT 1,
  circle_ai_enabled boolean NOT NULL DEFAULT true,
  updated_by_user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_incircle_platform_settings_singleton CHECK (singleton_id = 1)
);

INSERT INTO incircle_platform_settings (singleton_id, circle_ai_enabled)
VALUES (1, true)
ON CONFLICT (singleton_id) DO NOTHING;

DROP TRIGGER IF EXISTS trg_incircle_platform_settings_touch ON incircle_platform_settings;
CREATE TRIGGER trg_incircle_platform_settings_touch
BEFORE UPDATE ON incircle_platform_settings
FOR EACH ROW EXECUTE FUNCTION incircle_touch_updated_at();
