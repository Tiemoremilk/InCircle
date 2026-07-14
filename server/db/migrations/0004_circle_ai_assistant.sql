CREATE TABLE IF NOT EXISTS incircle_ai_settings (
  circle_id uuid PRIMARY KEY REFERENCES incircle_circles(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  assistant_name text NOT NULL DEFAULT '圈内 AI',
  system_prompt text NOT NULL DEFAULT '你是一个友善、准确的圈内 AI 助手。回答应简洁、清楚；不确定时明确说明，不编造事实。',
  quick_prompts jsonb NOT NULL DEFAULT '["帮我梳理一下思路","把这段话写得更清楚","给我几个可执行的建议"]'::jsonb,
  member_daily_limit integer NOT NULL DEFAULT 20,
  circle_daily_limit integer NOT NULL DEFAULT 200,
  max_output_tokens integer NOT NULL DEFAULT 2048,
  default_model_id uuid,
  created_by_user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL,
  updated_by_user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_incircle_ai_settings_member_limit CHECK (member_daily_limit BETWEEN 1 AND 200),
  CONSTRAINT chk_incircle_ai_settings_circle_limit CHECK (circle_daily_limit BETWEEN 1 AND 5000),
  CONSTRAINT chk_incircle_ai_settings_output_tokens CHECK (max_output_tokens BETWEEN 128 AND 8192)
);

CREATE TABLE IF NOT EXISTS incircle_ai_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES incircle_circles(id) ON DELETE CASCADE,
  protocol text NOT NULL,
  preset_key text NOT NULL DEFAULT '',
  name text NOT NULL,
  base_url text NOT NULL,
  credential_ciphertext text NOT NULL DEFAULT '',
  credential_last_four text NOT NULL DEFAULT '',
  privacy_url text NOT NULL DEFAULT '',
  privacy_version integer NOT NULL DEFAULT 1,
  api_version text NOT NULL DEFAULT '',
  azure_deployment text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  archived boolean NOT NULL DEFAULT false,
  is_custom boolean NOT NULL DEFAULT false,
  created_by_user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL,
  updated_by_user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL,
  last_test_status text NOT NULL DEFAULT '',
  last_test_error_code text NOT NULL DEFAULT '',
  last_tested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_incircle_ai_provider_protocol CHECK (protocol IN ('openai', 'anthropic', 'gemini', 'azure')),
  CONSTRAINT uq_incircle_ai_provider_id_circle UNIQUE (id, circle_id)
);

CREATE TABLE IF NOT EXISTS incircle_ai_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES incircle_circles(id) ON DELETE CASCADE,
  provider_id uuid NOT NULL,
  model_id text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  archived boolean NOT NULL DEFAULT false,
  supports_stream boolean NOT NULL DEFAULT true,
  context_window integer NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'manual',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_incircle_ai_model_provider_circle
    FOREIGN KEY (provider_id, circle_id)
    REFERENCES incircle_ai_providers(id, circle_id)
    ON DELETE CASCADE,
  CONSTRAINT uq_incircle_ai_model_provider_model UNIQUE (provider_id, model_id),
  CONSTRAINT uq_incircle_ai_model_id_circle UNIQUE (id, circle_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_incircle_ai_settings_default_model_circle'
  ) THEN
    ALTER TABLE incircle_ai_settings
      ADD CONSTRAINT fk_incircle_ai_settings_default_model_circle
      FOREIGN KEY (default_model_id, circle_id)
      REFERENCES incircle_ai_models(id, circle_id)
      ON DELETE SET NULL (default_model_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS incircle_ai_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES incircle_circles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES incircle_users(id) ON DELETE CASCADE,
  model_id uuid,
  title text NOT NULL DEFAULT '新对话',
  model_name_snapshot text NOT NULL DEFAULT '',
  provider_name_snapshot text NOT NULL DEFAULT '',
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_incircle_ai_conversation_model_circle
    FOREIGN KEY (model_id, circle_id)
    REFERENCES incircle_ai_models(id, circle_id)
    ON DELETE SET NULL (model_id),
  CONSTRAINT uq_incircle_ai_conversation_scope UNIQUE (id, circle_id, user_id)
);

CREATE TABLE IF NOT EXISTS incircle_ai_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL,
  content text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'complete',
  request_id text NOT NULL DEFAULT '',
  reply_to_message_id uuid REFERENCES incircle_ai_messages(id) ON DELETE SET NULL,
  model_id_snapshot text NOT NULL DEFAULT '',
  model_name_snapshot text NOT NULL DEFAULT '',
  provider_name_snapshot text NOT NULL DEFAULT '',
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  error_code text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_incircle_ai_message_conversation_scope
    FOREIGN KEY (conversation_id, circle_id, user_id)
    REFERENCES incircle_ai_conversations(id, circle_id, user_id)
    ON DELETE CASCADE,
  CONSTRAINT chk_incircle_ai_message_role CHECK (role IN ('user', 'assistant')),
  CONSTRAINT chk_incircle_ai_message_status CHECK (status IN ('pending', 'generating', 'complete', 'failed', 'cancelled', 'blocked'))
);

CREATE TABLE IF NOT EXISTS incircle_ai_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES incircle_circles(id) ON DELETE CASCADE,
  user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES incircle_ai_conversations(id) ON DELETE SET NULL,
  provider_id uuid REFERENCES incircle_ai_providers(id) ON DELETE SET NULL,
  model_id uuid REFERENCES incircle_ai_models(id) ON DELETE SET NULL,
  request_id text NOT NULL DEFAULT '',
  beijing_date date NOT NULL,
  status text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  latency_ms integer NOT NULL DEFAULT 0,
  error_code text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_incircle_ai_usage_status CHECK (status IN ('success', 'failed', 'cancelled', 'blocked'))
);

CREATE TABLE IF NOT EXISTS incircle_ai_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES incircle_users(id) ON DELETE CASCADE,
  provider_id uuid NOT NULL,
  privacy_version integer NOT NULL,
  provider_domain text NOT NULL DEFAULT '',
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_incircle_ai_consent_provider_circle
    FOREIGN KEY (provider_id, circle_id)
    REFERENCES incircle_ai_providers(id, circle_id)
    ON DELETE CASCADE,
  CONSTRAINT uq_incircle_ai_consent_scope UNIQUE (circle_id, user_id, provider_id)
);

CREATE TABLE IF NOT EXISTS incircle_ai_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES incircle_circles(id) ON DELETE CASCADE,
  user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES incircle_ai_conversations(id) ON DELETE CASCADE,
  message_id uuid REFERENCES incircle_ai_messages(id) ON DELETE CASCADE,
  reason text NOT NULL DEFAULT '',
  detail text NOT NULL DEFAULT '',
  message_excerpt text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_incircle_ai_report_status CHECK (status IN ('open', 'reviewed', 'closed'))
);

CREATE INDEX IF NOT EXISTS idx_incircle_ai_providers_circle ON incircle_ai_providers(circle_id, archived, created_at);
CREATE INDEX IF NOT EXISTS idx_incircle_ai_models_circle_enabled ON incircle_ai_models(circle_id, enabled, archived, created_at);
CREATE INDEX IF NOT EXISTS idx_incircle_ai_conversations_user_updated ON incircle_ai_conversations(circle_id, user_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_incircle_ai_messages_page ON incircle_ai_messages(conversation_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_incircle_ai_usage_circle_date ON incircle_ai_usage_events(circle_id, beijing_date, status);
CREATE INDEX IF NOT EXISTS idx_incircle_ai_usage_user_date ON incircle_ai_usage_events(circle_id, user_id, beijing_date, status);
CREATE INDEX IF NOT EXISTS idx_incircle_ai_usage_created ON incircle_ai_usage_events(circle_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_incircle_ai_reports_status ON incircle_ai_reports(status, created_at DESC);
DELETE FROM incircle_ai_reports older
USING incircle_ai_reports newer
WHERE older.message_id = newer.message_id
  AND older.user_id = newer.user_id
  AND (older.created_at < newer.created_at OR (older.created_at = newer.created_at AND older.id::text < newer.id::text));
CREATE UNIQUE INDEX IF NOT EXISTS uq_incircle_ai_report_message_user
  ON incircle_ai_reports(message_id, user_id)
  WHERE message_id IS NOT NULL AND user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_incircle_ai_user_request
  ON incircle_ai_messages(circle_id, user_id, request_id)
  WHERE role = 'user' AND request_id <> '';
CREATE UNIQUE INDEX IF NOT EXISTS uq_incircle_ai_usage_request
  ON incircle_ai_usage_events(circle_id, user_id, request_id)
  WHERE request_id <> '';
CREATE UNIQUE INDEX IF NOT EXISTS uq_incircle_ai_conversation_generating
  ON incircle_ai_messages(conversation_id)
  WHERE role = 'assistant' AND status = 'generating';

DROP TRIGGER IF EXISTS trg_incircle_ai_settings_touch ON incircle_ai_settings;
CREATE TRIGGER trg_incircle_ai_settings_touch BEFORE UPDATE ON incircle_ai_settings
FOR EACH ROW EXECUTE FUNCTION incircle_touch_updated_at();
DROP TRIGGER IF EXISTS trg_incircle_ai_providers_touch ON incircle_ai_providers;
CREATE TRIGGER trg_incircle_ai_providers_touch BEFORE UPDATE ON incircle_ai_providers
FOR EACH ROW EXECUTE FUNCTION incircle_touch_updated_at();
DROP TRIGGER IF EXISTS trg_incircle_ai_models_touch ON incircle_ai_models;
CREATE TRIGGER trg_incircle_ai_models_touch BEFORE UPDATE ON incircle_ai_models
FOR EACH ROW EXECUTE FUNCTION incircle_touch_updated_at();
DROP TRIGGER IF EXISTS trg_incircle_ai_conversations_touch ON incircle_ai_conversations;
CREATE TRIGGER trg_incircle_ai_conversations_touch BEFORE UPDATE ON incircle_ai_conversations
FOR EACH ROW EXECUTE FUNCTION incircle_touch_updated_at();
DROP TRIGGER IF EXISTS trg_incircle_ai_messages_touch ON incircle_ai_messages;
CREATE TRIGGER trg_incircle_ai_messages_touch BEFORE UPDATE ON incircle_ai_messages
FOR EACH ROW EXECUTE FUNCTION incircle_touch_updated_at();
DROP TRIGGER IF EXISTS trg_incircle_ai_consents_touch ON incircle_ai_consents;
CREATE TRIGGER trg_incircle_ai_consents_touch BEFORE UPDATE ON incircle_ai_consents
FOR EACH ROW EXECUTE FUNCTION incircle_touch_updated_at();
DROP TRIGGER IF EXISTS trg_incircle_ai_reports_touch ON incircle_ai_reports;
CREATE TRIGGER trg_incircle_ai_reports_touch BEFORE UPDATE ON incircle_ai_reports
FOR EACH ROW EXECUTE FUNCTION incircle_touch_updated_at();
