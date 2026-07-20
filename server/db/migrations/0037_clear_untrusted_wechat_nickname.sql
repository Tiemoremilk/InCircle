UPDATE incircle_users
SET wechat_nickname = ''
WHERE wechat_nickname IS DISTINCT FROM '';
