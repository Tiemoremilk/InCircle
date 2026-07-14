DROP INDEX IF EXISTS idx_incircle_bills_home_pending;
DROP INDEX IF EXISTS idx_incircle_votes_home_pending;
DROP INDEX IF EXISTS idx_incircle_checkin_records_circle_created;

INSERT INTO incircle_score_rules (circle_id, key, title, score, enabled, payload)
SELECT
  circle.id,
  rule.key,
  rule.title,
  rule.score,
  true,
  jsonb_build_object(
    'label', rule.title,
    'value', (CASE WHEN rule.score >= 0 THEN '+' ELSE '' END) || rule.score::text
  )
FROM incircle_circles circle
CROSS JOIN (
  VALUES
    ('create_activity', '发起约局', 5),
    ('activity_response', '首次表态活动', 2),
    ('create_vote', '发起投票', 3),
    ('vote_ballot', '参与投票', 1),
    ('create_checkin', '发起打卡挑战', 3),
    ('daily_checkin', '完成每日打卡', 2),
    ('create_bill', '发起 AA', 3),
    ('settle_bill', '完成结算', 2),
    ('create_doc', '沉淀圈内资料', 3),
    ('profile_complete', '完善身份卡', 5),
    ('friendly_impression', '收到友好印象', 1),
    ('friendly_promotion', '友好标签上墙', 2)
) AS rule(key, title, score)
ON CONFLICT (circle_id, key) WHERE circle_id IS NOT NULL AND key <> '' DO NOTHING;
