ALTER TABLE incircle_ai_models
  ADD COLUMN IF NOT EXISTS last_test_status text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS last_test_error_code text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS last_test_latency_ms integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_tested_at timestamptz;
