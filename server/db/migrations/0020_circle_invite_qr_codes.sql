CREATE TABLE IF NOT EXISTS incircle_circle_qr_codes (
  circle_id uuid PRIMARY KEY REFERENCES incircle_circles(id) ON DELETE CASCADE,
  join_code text NOT NULL,
  page text NOT NULL,
  env_version text NOT NULL,
  relative_path text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_incircle_circle_qr_env_version
    CHECK (env_version IN ('develop', 'trial', 'release'))
);
