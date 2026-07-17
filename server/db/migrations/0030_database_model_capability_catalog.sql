CREATE TABLE IF NOT EXISTS incircle_ai_model_catalog_releases (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  source_name text NOT NULL DEFAULT '',
  source_url text NOT NULL DEFAULT '',
  observed_at timestamptz,
  entry_count integer NOT NULL DEFAULT 0,
  imported_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_incircle_ai_catalog_release_checksum
    CHECK (checksum ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_incircle_ai_catalog_release_count
    CHECK (entry_count >= 0)
);

CREATE TABLE IF NOT EXISTS incircle_ai_model_capability_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key text NOT NULL,
  model_id text NOT NULL,
  model_id_normalized text NOT NULL,
  canonical_model_id text NOT NULL DEFAULT '',
  display_name text NOT NULL DEFAULT '',
  aliases text[] NOT NULL DEFAULT '{}'::text[],
  aliases_normalized text[] NOT NULL DEFAULT '{}'::text[],
  context_window integer NOT NULL DEFAULT 0,
  max_output_tokens integer NOT NULL DEFAULT 0,
  supports_reasoning boolean,
  confidence text NOT NULL DEFAULT 'community',
  source_kind text NOT NULL DEFAULT '',
  source_url text NOT NULL DEFAULT '',
  provider_doc_url text NOT NULL DEFAULT '',
  catalog_version text NOT NULL REFERENCES incircle_ai_model_catalog_releases(version) ON DELETE RESTRICT,
  release_date date,
  source_updated_at date,
  last_verified_at timestamptz,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_incircle_ai_model_catalog_provider_model
    UNIQUE (provider_key, model_id_normalized),
  CONSTRAINT chk_incircle_ai_model_catalog_provider_key
    CHECK (provider_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  CONSTRAINT chk_incircle_ai_model_catalog_model_id
    CHECK (char_length(model_id) BETWEEN 1 AND 240),
  CONSTRAINT chk_incircle_ai_model_catalog_context
    CHECK (context_window = 0 OR context_window BETWEEN 1024 AND 2000000),
  CONSTRAINT chk_incircle_ai_model_catalog_output
    CHECK (max_output_tokens = 0 OR max_output_tokens BETWEEN 128 AND 2000000),
  CONSTRAINT chk_incircle_ai_model_catalog_confidence
    CHECK (confidence IN ('official', 'verified', 'community')),
  CONSTRAINT chk_incircle_ai_model_catalog_status
    CHECK (status IN ('active', 'deprecated'))
);

CREATE INDEX IF NOT EXISTS idx_incircle_ai_model_catalog_active
  ON incircle_ai_model_capability_catalog(provider_key, status, model_id_normalized);

CREATE INDEX IF NOT EXISTS idx_incircle_ai_model_catalog_aliases
  ON incircle_ai_model_capability_catalog USING gin(aliases_normalized);
