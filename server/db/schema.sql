CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION incircle_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS incircle_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  openid text UNIQUE,
  unionid text,
  account_name text NOT NULL DEFAULT '',
  account_key text UNIQUE,
  password_hash text,
  password_salt text,
  password_iterations integer NOT NULL DEFAULT 0,
  password_digest text NOT NULL DEFAULT '',
  wechat_bound boolean NOT NULL DEFAULT false,
  logged_in boolean NOT NULL DEFAULT false,
  is_super_admin boolean NOT NULL DEFAULT false,
  blocked_at timestamptz,
  blocked_by_user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL,
  blocked_reason text NOT NULL DEFAULT '',
  wechat_unbound_at timestamptz,
  nickname text NOT NULL DEFAULT '',
  wechat_nickname text NOT NULL DEFAULT '',
  avatar_url text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  profile_note text NOT NULL DEFAULT '',
  profile_completed boolean NOT NULL DEFAULT false,
  theme_key text DEFAULT 'forest',
  custom_theme_rgba jsonb NOT NULL DEFAULT '{"r":47,"g":130,"b":89,"a":1}'::jsonb,
  current_circle_id uuid,
  status text NOT NULL DEFAULT 'active',
  deleted_at timestamptz,
  last_login_at timestamptz,
  account_bound_at timestamptz,
  wechat_bound_at timestamptz,
  password_updated_at timestamptz,
  terms_version text NOT NULL DEFAULT '',
  privacy_version text NOT NULL DEFAULT '',
  agreements_accepted_at timestamptz,
  agreement_acceptance_source text NOT NULL DEFAULT '',
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_incircle_user_theme_key CHECK (
    theme_key IN ('forest', 'ocean', 'berry', 'graphite', 'coral', 'peacock', 'cyan', 'mint', 'sky', 'apricot', 'lilac', 'custom')
  )
);

CREATE TABLE IF NOT EXISTS incircle_circles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL,
  join_code text,
  invite_token text NOT NULL,
  name text NOT NULL,
  notice text NOT NULL DEFAULT '',
  slogan text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  member_count integer NOT NULL DEFAULT 0,
  monthly_activity_count integer NOT NULL DEFAULT 0,
  unsettled_count integer NOT NULL DEFAULT 0,
  next_member_no integer NOT NULL DEFAULT 1,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incircle_account_agreement_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES incircle_users(id) ON DELETE CASCADE,
  terms_version text NOT NULL,
  privacy_version text NOT NULL,
  acceptance_source text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_incircle_account_acceptance_source
    CHECK (acceptance_source IN ('login', 'register', 'bind', 'reset', 'session')),
  CONSTRAINT uq_incircle_account_acceptance_version
    UNIQUE (user_id, terms_version, privacy_version)
);

CREATE INDEX IF NOT EXISTS idx_incircle_account_acceptances_user_time
  ON incircle_account_agreement_acceptances(user_id, accepted_at DESC);

CREATE TABLE IF NOT EXISTS incircle_public_legal_profile (
  singleton_id smallint PRIMARY KEY DEFAULT 1,
  operator_name text NOT NULL DEFAULT '',
  contact_email text NOT NULL DEFAULT '',
  terms_version text NOT NULL DEFAULT '',
  privacy_version text NOT NULL DEFAULT '',
  effective_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_incircle_public_legal_profile_singleton CHECK (singleton_id = 1),
  CONSTRAINT chk_incircle_public_legal_operator_name CHECK (
    char_length(operator_name) <= 80
    AND operator_name !~ '[\r\n]'
  ),
  CONSTRAINT chk_incircle_public_legal_contact_email CHECK (
    char_length(contact_email) <= 254
    AND contact_email !~ '[\r\n]'
  ),
  CONSTRAINT chk_incircle_public_legal_terms_version CHECK (
    char_length(terms_version) <= 40
    AND terms_version !~ '[\r\n]'
  ),
  CONSTRAINT chk_incircle_public_legal_privacy_version CHECK (
    char_length(privacy_version) <= 40
    AND privacy_version !~ '[\r\n]'
  )
);

INSERT INTO incircle_public_legal_profile (singleton_id)
VALUES (1)
ON CONFLICT (singleton_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS incircle_circle_qr_codes (
  circle_id uuid PRIMARY KEY REFERENCES incircle_circles(id) ON DELETE CASCADE,
  join_code text NOT NULL,
  invite_token text,
  page text NOT NULL,
  env_version text NOT NULL,
  relative_path text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_incircle_circle_qr_env_version
    CHECK (env_version IN ('develop', 'trial', 'release'))
);

CREATE TABLE IF NOT EXISTS incircle_circle_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES incircle_circles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES incircle_users(id) ON DELETE CASCADE,
  openid text NOT NULL DEFAULT '',
  member_name text NOT NULL DEFAULT '',
  member_id_text text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT '成员',
  status text NOT NULL DEFAULT 'active',
  removed_by_user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL,
  removed_reason text NOT NULL DEFAULT '',
  joined_at timestamptz NOT NULL DEFAULT now(),
  last_entered_at timestamptz,
  exited_at timestamptz,
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_incircle_circle_member_role CHECK (role IN ('圈主', '超管', '成员')),
  UNIQUE (circle_id, user_id)
);

CREATE TABLE IF NOT EXISTS incircle_member_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES incircle_circles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES incircle_users(id) ON DELETE CASCADE,
  member_id uuid REFERENCES incircle_circle_members(id) ON DELETE SET NULL,
  openid text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT '成员',
  name text NOT NULL DEFAULT '',
  avatar_url text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  profile_note text NOT NULL DEFAULT '',
  score integer NOT NULL DEFAULT 0,
  weekly_score integer NOT NULL DEFAULT 0,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  badges jsonb NOT NULL DEFAULT '[]'::jsonb,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_incircle_member_card_role CHECK (role IN ('圈主', '超管', '成员')),
  UNIQUE (circle_id, user_id)
);

CREATE TABLE IF NOT EXISTS incircle_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES incircle_circles(id) ON DELETE CASCADE,
  created_by_user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL,
  title text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incircle_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES incircle_circles(id) ON DELETE CASCADE,
  created_by_user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL,
  title text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incircle_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES incircle_circles(id) ON DELETE CASCADE,
  created_by_user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL,
  title text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incircle_checkins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES incircle_circles(id) ON DELETE CASCADE,
  created_by_user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL,
  title text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incircle_docs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES incircle_circles(id) ON DELETE CASCADE,
  created_by_user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL,
  title text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incircle_decision_makers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES incircle_circles(id) ON DELETE CASCADE,
  created_by_user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL,
  title text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incircle_score_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid REFERENCES incircle_circles(id) ON DELETE CASCADE,
  key text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  score integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incircle_score_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid REFERENCES incircle_circles(id) ON DELETE CASCADE,
  user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL,
  member_card_id uuid REFERENCES incircle_member_cards(id) ON DELETE SET NULL,
  delta integer NOT NULL DEFAULT 0,
  reason text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incircle_operation_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid REFERENCES incircle_circles(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text NOT NULL DEFAULT '',
  target_id text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Existing deployments may have tables created by an older self-hosted draft.
-- CREATE TABLE IF NOT EXISTS will not add missing columns, so keep this schema
-- idempotent by patching the baseline columns before indexes/triggers run.
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS openid text;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS unionid text;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS account_name text NOT NULL DEFAULT '';
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS account_key text;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS password_salt text;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS password_iterations integer NOT NULL DEFAULT 0;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS password_digest text NOT NULL DEFAULT '';
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS wechat_bound boolean NOT NULL DEFAULT false;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS logged_in boolean NOT NULL DEFAULT false;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS is_super_admin boolean NOT NULL DEFAULT false;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS blocked_at timestamptz;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS blocked_by_user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS blocked_reason text NOT NULL DEFAULT '';
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS wechat_unbound_at timestamptz;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS nickname text NOT NULL DEFAULT '';
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS wechat_nickname text NOT NULL DEFAULT '';
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS avatar_url text NOT NULL DEFAULT '';
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS phone text NOT NULL DEFAULT '';
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS profile_note text NOT NULL DEFAULT '';
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS profile_completed boolean NOT NULL DEFAULT false;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS theme_key text;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS custom_theme_rgba jsonb NOT NULL DEFAULT '{"r":47,"g":130,"b":89,"a":1}'::jsonb;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS current_circle_id uuid;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS account_bound_at timestamptz;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS wechat_bound_at timestamptz;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS password_updated_at timestamptz;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS terms_version text NOT NULL DEFAULT '';
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS privacy_version text NOT NULL DEFAULT '';
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS agreements_accepted_at timestamptz;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS agreement_acceptance_source text NOT NULL DEFAULT '';
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS raw_data jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE incircle_users ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE incircle_users SET theme_key = 'forest' WHERE theme_key = 'iris';
ALTER TABLE incircle_users DROP CONSTRAINT IF EXISTS chk_incircle_user_theme_key;
ALTER TABLE incircle_users
  ADD CONSTRAINT chk_incircle_user_theme_key CHECK (
    theme_key IS NULL
    OR theme_key IN ('forest', 'ocean', 'berry', 'graphite', 'coral', 'peacock', 'cyan', 'mint', 'sky', 'apricot', 'lilac', 'custom')
  );

ALTER TABLE incircle_users DROP CONSTRAINT IF EXISTS chk_incircle_agreement_acceptance_source;
ALTER TABLE incircle_users
  ADD CONSTRAINT chk_incircle_agreement_acceptance_source
  CHECK (agreement_acceptance_source IN ('', 'login', 'register', 'bind', 'reset', 'session'));

CREATE OR REPLACE FUNCTION incircle_record_account_agreement_acceptance()
RETURNS trigger AS $$
BEGIN
  IF NEW.agreements_accepted_at IS NOT NULL
     AND NEW.terms_version <> ''
     AND NEW.privacy_version <> ''
     AND NEW.agreement_acceptance_source <> ''
     AND (
       OLD.agreements_accepted_at IS DISTINCT FROM NEW.agreements_accepted_at
       OR OLD.terms_version IS DISTINCT FROM NEW.terms_version
       OR OLD.privacy_version IS DISTINCT FROM NEW.privacy_version
     ) THEN
    INSERT INTO incircle_account_agreement_acceptances (
      user_id, terms_version, privacy_version, acceptance_source, accepted_at
    ) VALUES (
      NEW.id, NEW.terms_version, NEW.privacy_version,
      NEW.agreement_acceptance_source, NEW.agreements_accepted_at
    ) ON CONFLICT (user_id, terms_version, privacy_version) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_incircle_users_record_agreement_acceptance ON incircle_users;
CREATE TRIGGER trg_incircle_users_record_agreement_acceptance
AFTER UPDATE OF terms_version, privacy_version, agreements_accepted_at ON incircle_users
FOR EACH ROW EXECUTE FUNCTION incircle_record_account_agreement_acceptance();

ALTER TABLE incircle_circles ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL;
ALTER TABLE incircle_circles ADD COLUMN IF NOT EXISTS join_code text;
ALTER TABLE incircle_circles ADD COLUMN IF NOT EXISTS invite_token text;
ALTER TABLE incircle_circles ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT '新的熟人圈';
ALTER TABLE incircle_circles ADD COLUMN IF NOT EXISTS notice text NOT NULL DEFAULT '';
ALTER TABLE incircle_circles ADD COLUMN IF NOT EXISTS slogan text NOT NULL DEFAULT '';
ALTER TABLE incircle_circles ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE incircle_circles ADD COLUMN IF NOT EXISTS member_count integer NOT NULL DEFAULT 0;
ALTER TABLE incircle_circles ADD COLUMN IF NOT EXISTS monthly_activity_count integer NOT NULL DEFAULT 0;
ALTER TABLE incircle_circles ADD COLUMN IF NOT EXISTS unsettled_count integer NOT NULL DEFAULT 0;
ALTER TABLE incircle_circles ADD COLUMN IF NOT EXISTS next_member_no integer NOT NULL DEFAULT 1;
ALTER TABLE incircle_circles ADD COLUMN IF NOT EXISTS stats jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE incircle_circles ADD COLUMN IF NOT EXISTS raw_data jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE incircle_circles ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE incircle_circles ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE incircle_circle_members ADD COLUMN IF NOT EXISTS circle_id uuid REFERENCES incircle_circles(id) ON DELETE CASCADE;
ALTER TABLE incircle_circle_members ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES incircle_users(id) ON DELETE CASCADE;
ALTER TABLE incircle_circle_members ADD COLUMN IF NOT EXISTS openid text NOT NULL DEFAULT '';
ALTER TABLE incircle_circle_members ADD COLUMN IF NOT EXISTS member_name text NOT NULL DEFAULT '';
ALTER TABLE incircle_circle_members ADD COLUMN IF NOT EXISTS member_id_text text NOT NULL DEFAULT '';
ALTER TABLE incircle_circle_members ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT '成员';
ALTER TABLE incircle_circle_members ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE incircle_circle_members ADD COLUMN IF NOT EXISTS removed_by_user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL;
ALTER TABLE incircle_circle_members ADD COLUMN IF NOT EXISTS removed_reason text NOT NULL DEFAULT '';
ALTER TABLE incircle_circle_members ADD COLUMN IF NOT EXISTS joined_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE incircle_circle_members ADD COLUMN IF NOT EXISTS last_entered_at timestamptz;
ALTER TABLE incircle_circle_members ADD COLUMN IF NOT EXISTS exited_at timestamptz;
ALTER TABLE incircle_circle_members ADD COLUMN IF NOT EXISTS raw_data jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE incircle_circle_members ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE incircle_circle_members ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE incircle_member_cards ADD COLUMN IF NOT EXISTS circle_id uuid REFERENCES incircle_circles(id) ON DELETE CASCADE;
ALTER TABLE incircle_member_cards ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES incircle_users(id) ON DELETE CASCADE;
ALTER TABLE incircle_member_cards ADD COLUMN IF NOT EXISTS member_id uuid REFERENCES incircle_circle_members(id) ON DELETE SET NULL;
ALTER TABLE incircle_member_cards ADD COLUMN IF NOT EXISTS openid text NOT NULL DEFAULT '';
ALTER TABLE incircle_member_cards ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT '成员';
ALTER TABLE incircle_member_cards ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT '';
ALTER TABLE incircle_member_cards ADD COLUMN IF NOT EXISTS avatar_url text NOT NULL DEFAULT '';
ALTER TABLE incircle_member_cards ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';
ALTER TABLE incircle_member_cards ADD COLUMN IF NOT EXISTS profile_note text NOT NULL DEFAULT '';
ALTER TABLE incircle_member_cards ADD COLUMN IF NOT EXISTS score integer NOT NULL DEFAULT 0;
ALTER TABLE incircle_member_cards ADD COLUMN IF NOT EXISTS weekly_score integer NOT NULL DEFAULT 0;
ALTER TABLE incircle_member_cards ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE incircle_member_cards ADD COLUMN IF NOT EXISTS badges jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE incircle_member_cards ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE incircle_member_cards ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE incircle_member_cards ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE incircle_circle_members ALTER COLUMN role SET DEFAULT '成员';
ALTER TABLE incircle_member_cards ALTER COLUMN role SET DEFAULT '成员';

WITH normalized_member_roles AS (
  SELECT
    member.id,
    CASE
      WHEN circle.owner_user_id = member.user_id
        OR lower(btrim(member.role)) IN ('圈主', 'owner', 'circle_owner', 'circle-owner', 'creator')
        THEN '圈主'
      WHEN lower(btrim(member.role)) IN (
        '超管', '管理员', '超级管理员', 'admin', 'administrator', 'manager',
        'circle_admin', 'circle-admin', 'super_admin', 'super-admin', 'superadmin'
      )
        THEN '超管'
      ELSE '成员'
    END AS role
  FROM incircle_circle_members member
  JOIN incircle_circles circle ON circle.id = member.circle_id
)
UPDATE incircle_circle_members member
SET role = normalized.role
FROM normalized_member_roles normalized
WHERE member.id = normalized.id
  AND member.role IS DISTINCT FROM normalized.role;

UPDATE incircle_member_cards card
SET role = member.role
FROM incircle_circle_members member
WHERE member.circle_id = card.circle_id
  AND member.user_id = card.user_id
  AND card.role IS DISTINCT FROM member.role;

UPDATE incircle_member_cards card
SET role = '圈主'
FROM incircle_circles circle
WHERE circle.id = card.circle_id
  AND circle.owner_user_id = card.user_id
  AND card.role IS DISTINCT FROM '圈主';

UPDATE incircle_member_cards
SET role = CASE
  WHEN lower(btrim(role)) IN ('圈主', 'owner', 'circle_owner', 'circle-owner', 'creator') THEN '圈主'
  WHEN lower(btrim(role)) IN (
    '超管', '管理员', '超级管理员', 'admin', 'administrator', 'manager',
    'circle_admin', 'circle-admin', 'super_admin', 'super-admin', 'superadmin'
  ) THEN '超管'
  ELSE '成员'
END
WHERE role NOT IN ('圈主', '超管', '成员');

ALTER TABLE incircle_circle_members DROP CONSTRAINT IF EXISTS chk_incircle_circle_member_role;
ALTER TABLE incircle_circle_members
  ADD CONSTRAINT chk_incircle_circle_member_role CHECK (role IN ('圈主', '超管', '成员'));
ALTER TABLE incircle_member_cards DROP CONSTRAINT IF EXISTS chk_incircle_member_card_role;
ALTER TABLE incircle_member_cards
  ADD CONSTRAINT chk_incircle_member_card_role CHECK (role IN ('圈主', '超管', '成员'));

ALTER TABLE incircle_activities ADD COLUMN IF NOT EXISTS circle_id uuid REFERENCES incircle_circles(id) ON DELETE CASCADE;
ALTER TABLE incircle_activities ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL;
ALTER TABLE incircle_activities ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';
ALTER TABLE incircle_activities ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE incircle_activities ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE incircle_activities ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE incircle_activities ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE incircle_bills ADD COLUMN IF NOT EXISTS circle_id uuid REFERENCES incircle_circles(id) ON DELETE CASCADE;
ALTER TABLE incircle_bills ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL;
ALTER TABLE incircle_bills ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';
ALTER TABLE incircle_bills ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE incircle_bills ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE incircle_bills ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE incircle_bills ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE incircle_votes ADD COLUMN IF NOT EXISTS circle_id uuid REFERENCES incircle_circles(id) ON DELETE CASCADE;
ALTER TABLE incircle_votes ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL;
ALTER TABLE incircle_votes ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';
ALTER TABLE incircle_votes ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE incircle_votes ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE incircle_votes ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE incircle_votes ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE incircle_checkins ADD COLUMN IF NOT EXISTS circle_id uuid REFERENCES incircle_circles(id) ON DELETE CASCADE;
ALTER TABLE incircle_checkins ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL;
ALTER TABLE incircle_checkins ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';
ALTER TABLE incircle_checkins ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE incircle_checkins ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE incircle_checkins ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE incircle_checkins ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE incircle_docs ADD COLUMN IF NOT EXISTS circle_id uuid REFERENCES incircle_circles(id) ON DELETE CASCADE;
ALTER TABLE incircle_docs ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL;
ALTER TABLE incircle_docs ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';
ALTER TABLE incircle_docs ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT '';
ALTER TABLE incircle_docs ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE incircle_docs ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE incircle_docs ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE incircle_docs ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

WITH refreshed_manual AS (
  SELECT
    docs.id,
    jsonb_agg(
      CASE
        WHEN entry.value #>> '{}' = '圈主和管理员可以维护圈子资料、移除成员、删除圈内业务；圈主不能退出，只能解散圈子。'
          THEN to_jsonb('圈主和超管可以维护圈子资料、移除成员、删除圈内业务；圈主不能退出，只能解散圈子。'::text)
        ELSE entry.value
      END
      ORDER BY entry.ordinality
    ) AS body
  FROM incircle_docs docs
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(docs.payload->'body') = 'array' THEN docs.payload->'body' ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS entry(value, ordinality)
  WHERE docs.payload->>'systemKey' = 'incircle-manual'
    AND jsonb_typeof(docs.payload->'body') = 'array'
  GROUP BY docs.id
)
UPDATE incircle_docs docs
SET payload = jsonb_set(docs.payload, '{body}', refreshed_manual.body, true),
    updated_at = now()
FROM refreshed_manual
WHERE docs.id = refreshed_manual.id
  AND docs.payload->'body' IS DISTINCT FROM refreshed_manual.body;

ALTER TABLE incircle_decision_makers ADD COLUMN IF NOT EXISTS circle_id uuid REFERENCES incircle_circles(id) ON DELETE CASCADE;
ALTER TABLE incircle_decision_makers ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL;
ALTER TABLE incircle_decision_makers ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';
ALTER TABLE incircle_decision_makers ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE incircle_decision_makers ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE incircle_decision_makers ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE incircle_score_rules ADD COLUMN IF NOT EXISTS circle_id uuid REFERENCES incircle_circles(id) ON DELETE CASCADE;
ALTER TABLE incircle_score_rules ADD COLUMN IF NOT EXISTS key text NOT NULL DEFAULT '';
ALTER TABLE incircle_score_rules ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';
ALTER TABLE incircle_score_rules ADD COLUMN IF NOT EXISTS score integer NOT NULL DEFAULT 0;
ALTER TABLE incircle_score_rules ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE incircle_score_rules ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE incircle_score_rules ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE incircle_score_rules ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE incircle_score_logs ADD COLUMN IF NOT EXISTS circle_id uuid REFERENCES incircle_circles(id) ON DELETE CASCADE;
ALTER TABLE incircle_score_logs ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL;
ALTER TABLE incircle_score_logs ADD COLUMN IF NOT EXISTS member_card_id uuid REFERENCES incircle_member_cards(id) ON DELETE SET NULL;
ALTER TABLE incircle_score_logs ADD COLUMN IF NOT EXISTS delta integer NOT NULL DEFAULT 0;
ALTER TABLE incircle_score_logs ADD COLUMN IF NOT EXISTS reason text NOT NULL DEFAULT '';
ALTER TABLE incircle_score_logs ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE incircle_score_logs ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE incircle_score_logs ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE incircle_operation_logs ADD COLUMN IF NOT EXISTS circle_id uuid REFERENCES incircle_circles(id) ON DELETE SET NULL;
ALTER TABLE incircle_operation_logs ADD COLUMN IF NOT EXISTS actor_user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL;
ALTER TABLE incircle_operation_logs ADD COLUMN IF NOT EXISTS action text NOT NULL DEFAULT '';
ALTER TABLE incircle_operation_logs ADD COLUMN IF NOT EXISTS target_type text NOT NULL DEFAULT '';
ALTER TABLE incircle_operation_logs ADD COLUMN IF NOT EXISTS target_id text NOT NULL DEFAULT '';
ALTER TABLE incircle_operation_logs ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE incircle_operation_logs ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE incircle_operation_logs ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE incircle_users SET openid = NULL WHERE openid = '';
UPDATE incircle_users SET account_key = NULL WHERE account_key = '';
UPDATE incircle_circles SET join_code = NULL WHERE join_code = '';

DO $$
DECLARE
  target record;
  candidate text;
BEGIN
  FOR target IN
    SELECT id
    FROM incircle_circles
    WHERE join_code IS NULL
       OR char_length(join_code) <> 8
       OR join_code !~ '^[A-Za-z0-9@#￥%&]{8}$'
  LOOP
    LOOP
      candidate := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
      EXIT WHEN NOT EXISTS (
        SELECT 1
        FROM incircle_circles
        WHERE (join_code COLLATE "C") = (candidate COLLATE "C")
      );
    END LOOP;
    UPDATE incircle_circles SET join_code = candidate WHERE id = target.id;
  END LOOP;

  FOR target IN
    SELECT id
    FROM incircle_circles
    WHERE invite_token IS NULL
       OR invite_token !~ '^[a-f0-9]{32}$'
  LOOP
    LOOP
      candidate := replace(gen_random_uuid()::text, '-', '');
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM incircle_circles WHERE invite_token = candidate
      );
    END LOOP;
    UPDATE incircle_circles SET invite_token = candidate WHERE id = target.id;
  END LOOP;
END $$;

ALTER TABLE incircle_circles
  ALTER COLUMN join_code SET NOT NULL,
  ALTER COLUMN invite_token SET NOT NULL;

ALTER TABLE incircle_circles DROP CONSTRAINT IF EXISTS chk_incircle_circle_join_code;
ALTER TABLE incircle_circles
  ADD CONSTRAINT chk_incircle_circle_join_code
  CHECK (char_length(join_code) = 8 AND join_code ~ '^[A-Za-z0-9@#￥%&]{8}$');

ALTER TABLE incircle_circles DROP CONSTRAINT IF EXISTS chk_incircle_circle_invite_token;
ALTER TABLE incircle_circles
  ADD CONSTRAINT chk_incircle_circle_invite_token
  CHECK (invite_token ~ '^[a-f0-9]{32}$');

ALTER TABLE incircle_circle_qr_codes ADD COLUMN IF NOT EXISTS invite_token text;
ALTER TABLE incircle_circle_qr_codes DROP CONSTRAINT IF EXISTS chk_incircle_circle_qr_invite_token;
DELETE FROM incircle_circle_qr_codes WHERE invite_token IS NULL;
ALTER TABLE incircle_circle_qr_codes ALTER COLUMN invite_token SET NOT NULL;
ALTER TABLE incircle_circle_qr_codes
  ADD CONSTRAINT chk_incircle_circle_qr_invite_token
  CHECK (invite_token ~ '^[a-f0-9]{32}$');

CREATE INDEX IF NOT EXISTS idx_incircle_users_openid ON incircle_users(openid);
CREATE INDEX IF NOT EXISTS idx_incircle_users_account_key ON incircle_users(account_key);
CREATE INDEX IF NOT EXISTS idx_incircle_circles_join_code ON incircle_circles(join_code);
CREATE INDEX IF NOT EXISTS idx_incircle_circles_owner_user_id ON incircle_circles(owner_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_incircle_users_openid ON incircle_users(openid);
CREATE UNIQUE INDEX IF NOT EXISTS uq_incircle_users_account_key ON incircle_users(account_key);
ALTER TABLE incircle_circles DROP CONSTRAINT IF EXISTS incircle_circles_join_code_key;
DROP INDEX IF EXISTS uq_incircle_circles_join_code;
CREATE UNIQUE INDEX IF NOT EXISTS uq_incircle_circles_join_code_case ON incircle_circles ((join_code COLLATE "C"));
CREATE UNIQUE INDEX IF NOT EXISTS uq_incircle_circles_invite_token ON incircle_circles(invite_token);
CREATE UNIQUE INDEX IF NOT EXISTS uq_incircle_members_circle_user ON incircle_circle_members(circle_id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_incircle_member_cards_circle_user ON incircle_member_cards(circle_id, user_id);
CREATE INDEX IF NOT EXISTS idx_incircle_members_circle_status ON incircle_circle_members(circle_id, status);
CREATE INDEX IF NOT EXISTS idx_incircle_members_user_recent ON incircle_circle_members(user_id, status, last_entered_at DESC);
CREATE INDEX IF NOT EXISTS idx_incircle_users_status_created ON incircle_users(status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_incircle_users_admin_search_trgm
  ON incircle_users USING gin (
    (COALESCE(nickname, '') || ' ' || COALESCE(account_name, '') || ' ' || COALESCE(phone, '')) gin_trgm_ops
  );
CREATE INDEX IF NOT EXISTS idx_incircle_circles_admin_search_trgm
  ON incircle_circles USING gin (
    (COALESCE(name, '') || ' ' || COALESCE(slogan, '') || ' ' || COALESCE(notice, '') || ' ' || COALESCE(join_code, '')) gin_trgm_ops
  );
CREATE INDEX IF NOT EXISTS idx_incircle_members_openid ON incircle_circle_members(openid);
CREATE INDEX IF NOT EXISTS idx_incircle_member_cards_circle ON incircle_member_cards(circle_id);
CREATE INDEX IF NOT EXISTS idx_incircle_member_cards_openid ON incircle_member_cards(openid);
CREATE INDEX IF NOT EXISTS idx_incircle_activities_circle_created ON incircle_activities(circle_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_incircle_bills_circle_created ON incircle_bills(circle_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_incircle_votes_circle_created ON incircle_votes(circle_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_incircle_checkins_circle_created ON incircle_checkins(circle_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_incircle_docs_circle_created ON incircle_docs(circle_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_incircle_score_logs_circle_created ON incircle_score_logs(circle_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_incircle_score_logs_circle_member_created ON incircle_score_logs(circle_id, member_card_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_incircle_operation_logs_created ON incircle_operation_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_incircle_operation_logs_actor_created ON incircle_operation_logs(actor_user_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_incircle_users_touch ON incircle_users;
CREATE TRIGGER trg_incircle_users_touch
BEFORE UPDATE ON incircle_users
FOR EACH ROW EXECUTE FUNCTION incircle_touch_updated_at();

DROP TRIGGER IF EXISTS trg_incircle_public_legal_profile_touch ON incircle_public_legal_profile;
CREATE TRIGGER trg_incircle_public_legal_profile_touch
BEFORE UPDATE ON incircle_public_legal_profile
FOR EACH ROW EXECUTE FUNCTION incircle_touch_updated_at();

DROP TRIGGER IF EXISTS trg_incircle_circles_touch ON incircle_circles;
CREATE TRIGGER trg_incircle_circles_touch
BEFORE UPDATE ON incircle_circles
FOR EACH ROW EXECUTE FUNCTION incircle_touch_updated_at();

DROP TRIGGER IF EXISTS trg_incircle_circle_members_touch ON incircle_circle_members;
CREATE TRIGGER trg_incircle_circle_members_touch
BEFORE UPDATE ON incircle_circle_members
FOR EACH ROW EXECUTE FUNCTION incircle_touch_updated_at();

DROP TRIGGER IF EXISTS trg_incircle_member_cards_touch ON incircle_member_cards;
CREATE TRIGGER trg_incircle_member_cards_touch
BEFORE UPDATE ON incircle_member_cards
FOR EACH ROW EXECUTE FUNCTION incircle_touch_updated_at();

DROP TRIGGER IF EXISTS trg_incircle_activities_touch ON incircle_activities;
CREATE TRIGGER trg_incircle_activities_touch
BEFORE UPDATE ON incircle_activities
FOR EACH ROW EXECUTE FUNCTION incircle_touch_updated_at();

DROP TRIGGER IF EXISTS trg_incircle_bills_touch ON incircle_bills;
CREATE TRIGGER trg_incircle_bills_touch
BEFORE UPDATE ON incircle_bills
FOR EACH ROW EXECUTE FUNCTION incircle_touch_updated_at();

DROP TRIGGER IF EXISTS trg_incircle_votes_touch ON incircle_votes;
CREATE TRIGGER trg_incircle_votes_touch
BEFORE UPDATE ON incircle_votes
FOR EACH ROW EXECUTE FUNCTION incircle_touch_updated_at();

DROP TRIGGER IF EXISTS trg_incircle_checkins_touch ON incircle_checkins;
CREATE TRIGGER trg_incircle_checkins_touch
BEFORE UPDATE ON incircle_checkins
FOR EACH ROW EXECUTE FUNCTION incircle_touch_updated_at();

DROP TRIGGER IF EXISTS trg_incircle_docs_touch ON incircle_docs;
CREATE TRIGGER trg_incircle_docs_touch
BEFORE UPDATE ON incircle_docs
FOR EACH ROW EXECUTE FUNCTION incircle_touch_updated_at();

DROP TRIGGER IF EXISTS trg_incircle_decision_makers_touch ON incircle_decision_makers;
CREATE TRIGGER trg_incircle_decision_makers_touch
BEFORE UPDATE ON incircle_decision_makers
FOR EACH ROW EXECUTE FUNCTION incircle_touch_updated_at();

DROP TRIGGER IF EXISTS trg_incircle_score_rules_touch ON incircle_score_rules;
CREATE TRIGGER trg_incircle_score_rules_touch
BEFORE UPDATE ON incircle_score_rules
FOR EACH ROW EXECUTE FUNCTION incircle_touch_updated_at();

DROP TRIGGER IF EXISTS trg_incircle_score_logs_touch ON incircle_score_logs;
CREATE TRIGGER trg_incircle_score_logs_touch
BEFORE UPDATE ON incircle_score_logs
FOR EACH ROW EXECUTE FUNCTION incircle_touch_updated_at();

DROP TRIGGER IF EXISTS trg_incircle_operation_logs_touch ON incircle_operation_logs;
CREATE TRIGGER trg_incircle_operation_logs_touch
BEFORE UPDATE ON incircle_operation_logs
FOR EACH ROW EXECUTE FUNCTION incircle_touch_updated_at();

-- Circle-level AI assistant baseline. Keep this idempotent for fresh databases.
CREATE TABLE IF NOT EXISTS incircle_ai_settings (
  circle_id uuid PRIMARY KEY REFERENCES incircle_circles(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  assistant_name text NOT NULL DEFAULT '圈内 AI',
  system_prompt text NOT NULL DEFAULT '你是一个友善、准确的圈内 AI 助手。回答应简洁、清楚；不确定时明确说明，不编造事实。',
  quick_prompts jsonb NOT NULL DEFAULT '["帮我梳理一下思路","把这段话写得更清楚","给我几个可执行的建议"]'::jsonb,
  member_daily_limit integer NOT NULL DEFAULT 20,
  circle_daily_limit integer NOT NULL DEFAULT 200,
  max_output_tokens integer NOT NULL DEFAULT 8192,
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
  last_test_status text NOT NULL DEFAULT '',
  last_test_error_code text NOT NULL DEFAULT '',
  last_test_latency_ms integer NOT NULL DEFAULT 0,
  last_tested_at timestamptz,
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
  reasoning_content text NOT NULL DEFAULT '',
  reasoning_duration_ms integer NOT NULL DEFAULT 0 CHECK (reasoning_duration_ms >= 0 AND reasoning_duration_ms <= 3600000),
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
