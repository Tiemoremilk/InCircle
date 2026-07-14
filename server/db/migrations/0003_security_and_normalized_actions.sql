ALTER TABLE incircle_users
  ADD COLUMN IF NOT EXISTS auth_version integer NOT NULL DEFAULT 1;

ALTER TABLE incircle_activities
  ADD COLUMN IF NOT EXISTS starts_at timestamptz;

ALTER TABLE incircle_votes
  ADD COLUMN IF NOT EXISTS deadline_at timestamptz;

ALTER TABLE incircle_bills
  ADD COLUMN IF NOT EXISTS source_activity_id uuid REFERENCES incircle_activities(id) ON DELETE SET NULL;

ALTER TABLE incircle_score_logs
  ADD COLUMN IF NOT EXISTS event_key text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_incircle_bills_source_activity
  ON incircle_bills(source_activity_id)
  WHERE source_activity_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_incircle_score_logs_event
  ON incircle_score_logs(circle_id, event_key)
  WHERE event_key IS NOT NULL AND event_key <> '';

CREATE UNIQUE INDEX IF NOT EXISTS uq_incircle_score_rules_circle_key
  ON incircle_score_rules(circle_id, key)
  WHERE circle_id IS NOT NULL AND key <> '';

CREATE TABLE IF NOT EXISTS incircle_activity_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES incircle_circles(id) ON DELETE CASCADE,
  activity_id uuid NOT NULL REFERENCES incircle_activities(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES incircle_users(id) ON DELETE CASCADE,
  member_card_id uuid REFERENCES incircle_member_cards(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('我来', '带一人', '待定', '不来', '候补')),
  plus_one_count integer NOT NULL DEFAULT 0 CHECK (plus_one_count >= 0 AND plus_one_count <= 10),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (activity_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_incircle_activity_responses_activity
  ON incircle_activity_responses(activity_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS incircle_vote_ballots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES incircle_circles(id) ON DELETE CASCADE,
  vote_id uuid NOT NULL REFERENCES incircle_votes(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES incircle_users(id) ON DELETE CASCADE,
  member_card_id uuid REFERENCES incircle_member_cards(id) ON DELETE SET NULL,
  option_name text NOT NULL,
  weight integer NOT NULL DEFAULT 1 CHECK (weight >= 1 AND weight <= 10),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vote_id, user_id, option_name)
);

CREATE INDEX IF NOT EXISTS idx_incircle_vote_ballots_vote
  ON incircle_vote_ballots(vote_id, created_at ASC);

CREATE TABLE IF NOT EXISTS incircle_vote_vetoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES incircle_circles(id) ON DELETE CASCADE,
  vote_id uuid NOT NULL REFERENCES incircle_votes(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES incircle_users(id) ON DELETE CASCADE,
  member_card_id uuid REFERENCES incircle_member_cards(id) ON DELETE SET NULL,
  option_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vote_id, user_id, option_name)
);

CREATE TABLE IF NOT EXISTS incircle_checkin_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES incircle_circles(id) ON DELETE CASCADE,
  checkin_id uuid NOT NULL REFERENCES incircle_checkins(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES incircle_users(id) ON DELETE CASCADE,
  member_card_id uuid REFERENCES incircle_member_cards(id) ON DELETE SET NULL,
  checkin_date date NOT NULL,
  record_type text NOT NULL DEFAULT '文字',
  value text NOT NULL DEFAULT '已完成',
  note text NOT NULL DEFAULT '',
  media jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (checkin_id, user_id, checkin_date)
);

CREATE INDEX IF NOT EXISTS idx_incircle_checkin_records_challenge_date
  ON incircle_checkin_records(checkin_id, checkin_date, created_at ASC);

CREATE TABLE IF NOT EXISTS incircle_checkin_card_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES incircle_circles(id) ON DELETE CASCADE,
  checkin_id uuid NOT NULL REFERENCES incircle_checkins(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES incircle_users(id) ON DELETE CASCADE,
  member_card_id uuid REFERENCES incircle_member_cards(id) ON DELETE SET NULL,
  card_type text NOT NULL CHECK (card_type IN ('leave', 'makeup')),
  week_key text NOT NULL,
  target_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (checkin_id, user_id, card_type, week_key)
);

CREATE TABLE IF NOT EXISTS incircle_member_tag_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES incircle_circles(id) ON DELETE CASCADE,
  target_member_card_id uuid NOT NULL REFERENCES incircle_member_cards(id) ON DELETE CASCADE,
  voter_user_id uuid NOT NULL REFERENCES incircle_users(id) ON DELETE CASCADE,
  tag text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_member_card_id, voter_user_id, tag)
);

CREATE TABLE IF NOT EXISTS incircle_member_tag_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES incircle_circles(id) ON DELETE CASCADE,
  target_member_card_id uuid NOT NULL REFERENCES incircle_member_cards(id) ON DELETE CASCADE,
  proposed_by_user_id uuid NOT NULL REFERENCES incircle_users(id) ON DELETE CASCADE,
  tag text NOT NULL,
  threshold integer NOT NULL DEFAULT 2 CHECK (threshold >= 2 AND threshold <= 20),
  status text NOT NULL DEFAULT 'voting' CHECK (status IN ('voting', 'approved')),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_member_card_id, tag)
);

CREATE TABLE IF NOT EXISTS incircle_member_tag_proposal_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES incircle_member_tag_proposals(id) ON DELETE CASCADE,
  voter_user_id uuid NOT NULL REFERENCES incircle_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (proposal_id, voter_user_id)
);

CREATE TABLE IF NOT EXISTS incircle_member_tag_appeals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES incircle_circles(id) ON DELETE CASCADE,
  target_member_card_id uuid NOT NULL REFERENCES incircle_member_cards(id) ON DELETE CASCADE,
  appellant_user_id uuid NOT NULL REFERENCES incircle_users(id) ON DELETE CASCADE,
  tag text NOT NULL,
  reason text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  resolved_by_user_id uuid REFERENCES incircle_users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_incircle_pending_tag_appeal
  ON incircle_member_tag_appeals(target_member_card_id, appellant_user_id, tag)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS incircle_migration_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_key text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  reason text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (migration_key, entity_type, entity_id, reason)
);
