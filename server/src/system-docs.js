const crypto = require("crypto");

const SYSTEM_DOC_VERSIONS = Object.freeze({
  "incircle-manual": 2,
  "badge-rules": 2,
});

function funBadgeRules() {
  return [
    { id: "badge-profile", key: "badge-profile", label: "身份卡装修师", value: "补全称号和备注" },
    { id: "badge-avatar", key: "badge-avatar", label: "头像营业中", value: "上传可识别头像" },
    { id: "badge-tags", key: "badge-tags", label: "标签批发商", value: "3 个兴趣标签" },
    { id: "badge-tag-rich", key: "badge-tag-rich", label: "标签策展人", value: "6 个圈内标签" },
    { id: "badge-skills", key: "badge-skills", label: "技能工具箱", value: "2 个擅长技能" },
    { id: "badge-skills-pro", key: "badge-skills-pro", label: "万能搭子", value: "4 个擅长技能" },
    { id: "badge-interest", key: "badge-interest", label: "兴趣雷达", value: "3 个兴趣偏好" },
    { id: "badge-boundary", key: "badge-boundary", label: "边界感大师", value: "填写雷点或忌口" },
    { id: "badge-friendly", key: "badge-friendly", label: "好感收集器", value: "收到 3 个友好印象" },
    { id: "badge-friendly-wall", key: "badge-friendly-wall", label: "口碑上墙", value: "2 个友好标签上墙" },
    { id: "badge-organizer", key: "badge-organizer", label: "局子发动机", value: "发起过约局" },
    { id: "badge-organizer-pro", key: "badge-organizer-pro", label: "排局导演", value: "发起 3 次约局" },
    { id: "badge-regular", key: "badge-regular", label: "约局常客", value: "参与 3 次活动" },
    { id: "badge-king", key: "badge-king", label: "局王预备役", value: "参与 8 次活动" },
    { id: "badge-checkin", key: "badge-checkin", label: "七日打卡怪", value: "打卡 7 天" },
    { id: "badge-checkin-pro", key: "badge-checkin-pro", label: "自律上头", value: "打卡 21 天" },
    { id: "badge-punctual", key: "badge-punctual", label: "准点到达术", value: "守时 5 次" },
    { id: "badge-no-show", key: "badge-no-show", label: "不鸽认证", value: "3 次活动零鸽" },
    { id: "badge-score-50", key: "badge-score-50", label: "积分冒泡王", value: "积分 50+" },
    { id: "badge-score", key: "badge-score", label: "圈内发电站", value: "积分 100+" },
    { id: "badge-weekly", key: "badge-weekly", label: "本周小太阳", value: "单周积分 20+" },
  ];
}

function defaultSystemDocs() {
  const badgeRuleText = funBadgeRules().map((rule) => `${rule.label}：${rule.value}`);
  return [
    {
      systemKey: "incircle-manual",
      systemVersion: SYSTEM_DOC_VERSIONS["incircle-manual"],
      systemManaged: true,
      title: "InCircle 使用手册",
      category: "指南",
      summary: "从入圈、身份卡到约局、AA、投票、打卡、资料与圈内 AI，一份可随时查阅的操作指南。",
      pinned: true,
      owner: "系统",
      ownerOpenid: "",
      creatorName: "系统",
      creatorOpenid: "",
      readTime: "8 分钟",
      body: [
        "从这里开始｜登录后可以创建自己的熟人圈，也可以通过入圈码或微信入圈码加入已有圈子。加入多个圈子后，可在首页切换当前圈子；页面中的活动、账单、投票、打卡、资料和成员内容始终归属于当前圈子。",
        "首页与导航｜首页汇总圈内公告、最近活动、待投票、AA 待结清、打卡挑战和积分榜。底部五个入口分别用于查看首页、约局活动、圈内工具、资料库和成员图鉴。",
        "邀请与圈子设置｜圈主可以更新圈子名称、公告和介绍，生成入圈码邀请熟人，并管理圈内成员。邀请码固定为 8 位且区分大小写；更换邀请码后，旧邀请码、旧分享入口和旧入圈码图片都会立即失效。入圈信息请勿公开发布；圈主不再保留圈子时，需要先妥善处理圈内资料，再从圈子设置中解散。",
        "身份卡与圈友互动｜每位成员在每个圈子都有一张独立身份卡，可维护头像、圈内昵称、称号、介绍、技能、兴趣和边界信息。可以给其他圈友留下友好印象或参与圈友提名，再次点击已选择的印象可以取消；同一标签获得至少两位圈友认可后会进入标签墙。勋章会根据真实参与记录自动点亮。",
        "约局活动｜在活动页填写主题、时间、地点、人数和费用说明后发起约局，地点既可手动输入，也可从地图选择。成员可在详情中报名或取消；活动结束前，发起人或圈主可以编辑，结束后可查看参与情况和复盘，已结束内容不再编辑。",
        "AA 账单｜可以单独发起 AA，也可以从活动详情带入参与成员。保存前请核对付款人、参与人、总金额、费用明细和分摊结果；详情页用于查看应付关系和结清进度。AA 仅提供圈内记录与提醒，不会代替微信支付或自动转账。账单结清后不能继续修改。",
        "投票决策｜支持普通投票和地点投票，可设置候选项、选择方式与明确的截止时间。地点投票可保留手动地点和地图坐标。到达北京时间截止点后会自动变为已截止并停止投票；提前生成结果代表提前结束。结束后的入口统一查看结果摘要，分享时也分享这份摘要。没有有效票数时不会虚构胜出项。",
        "打卡挑战｜可创建文字、图片或数值打卡。每位成员在同一挑战中按北京时间自然日记录一次，过了 00:00 即进入新的打卡日期；历史记录保留完整年月日时分秒。请假或补签能力以页面显示的可用规则为准，图片和文字请避免包含他人隐私。",
        "圈内资料｜资料库适合保存规则、攻略、链接、活动复盘和长期可查的说明。普通资料可由发起人或圈主在有效状态下编辑；系统内置资料用于说明功能与规则，只读且不会占用成员的发布记录。重要内容可以分享给已入圈成员。",
        "积分、榜单与勋章｜发起活动、参与投票、完成打卡、沉淀资料等有效行为会按圈内积分规则形成流水。积分规则、成员榜单和勋章墙用于记录参与度与圈内荣誉，不代表金钱，也不会改变成员权限；各圈积分彼此独立。",
        "圈内 AI｜平台开放该能力后，圈主可自主接入其合法开通并有权使用的第三方模型服务，再按圈开启。完成配置后，五个主页面会出现可拖动的 AI 入口；平台关闭时，入口和圈内设置会统一隐藏，但已有配置会保留。每位成员拥有彼此独立的会话，发送前需阅读并确认对应服务商提示。输入内容会提供给所选第三方模型服务商，回答由该服务商生成，重要信息需要自行核实。其他成员和圈主不能查看你的聊天正文。",
        "分享与隐私｜活动、投票结果、资料等内容可以通过微信分享，但接收者仍需登录并加入对应圈子后才能查看圈内详情。不要在身份卡、打卡图片、资料、账单或 AI 对话中填写身份证号、支付密码等敏感信息。所有业务日期与统计统一按北京时间处理。",
      ],
      checklist: [
        "操作前确认当前圈子，避免把内容发到另一个圈子",
        "完善本圈身份卡，再邀请熟人通过入圈码加入",
        "发起约局时写清时间、地点、人数和费用说明",
        "发起 AA 前逐项核对付款人、参与人、金额与分摊结果",
        "投票设置明确截止时间，提前生成结果会立即结束投票",
        "打卡、资料和分享内容避免包含自己或他人的敏感信息",
        "遇到 AI 回答时先核实事实，再用于实际决定",
      ],
      related: ["勋章达成条件", "成员图鉴", "圈内积分", "圈子设置"],
    },
    {
      systemKey: "badge-rules",
      systemVersion: SYSTEM_DOC_VERSIONS["badge-rules"],
      systemManaged: true,
      title: "勋章达成条件",
      category: "规则",
      summary: "勋章会根据身份卡、积分、友好印象、活动和打卡记录自动点亮。",
      pinned: true,
      owner: "系统",
      ownerOpenid: "",
      creatorName: "系统",
      creatorOpenid: "",
      readTime: "3 分钟",
      body: [
        "勋章是轻荣誉，不影响权限；它用于帮助圈友快速理解一个人的参与方式和圈内特色。",
        "身份资料类勋章来自头像、称号、备注、标签、技能、兴趣和边界信息。",
        "互动类勋章来自友好印象、标签上墙、活动参与、活动发起、打卡和积分表现。",
      ].concat(badgeRuleText),
      checklist: ["完善身份卡", "参加或发起圈内活动", "给圈友留下友好印象", "保持资料和规则可复用"],
      related: ["InCircle 使用手册", "成员图鉴", "友好印象"],
    },
  ];
}

function shouldRefreshSystemDoc(row, template) {
  const payload = row && row.payload && typeof row.payload === "object" ? row.payload : {};
  return Number(payload.systemVersion || 0) < Number(template.systemVersion || 0);
}

function mergedSystemDocPayload(row, template, circleId) {
  const current = row && row.payload && typeof row.payload === "object" ? row.payload : {};
  const now = new Date();
  return Object.assign({}, current, template, {
    id: String(row.id),
    circleId: String(circleId),
    status: "active",
    createdAt: current.createdAt || row.created_at || now.toISOString(),
    createdAtMs: current.createdAtMs || (row.created_at ? new Date(row.created_at).getTime() : now.getTime()),
    updatedAt: now.toISOString(),
    updatedAtMs: now.getTime(),
  });
}

async function ensureDefaultSystemDocsForCircle(db, circleId, userId) {
  const result = await db.query(
    `
    SELECT id, created_by_user_id, title, category, status, payload, created_at, updated_at
    FROM incircle_docs
    WHERE circle_id = $1 AND COALESCE(payload->>'systemKey', '') <> ''
    ORDER BY created_at ASC, id ASC
    `,
    [circleId]
  );
  const existing = new Map();
  result.rows.forEach((row) => {
    const systemKey = row.payload && row.payload.systemKey;
    if (systemKey && !existing.has(systemKey)) existing.set(systemKey, row);
  });

  const summary = { inserted: 0, updated: 0, unchanged: 0 };
  for (const template of defaultSystemDocs()) {
    const row = existing.get(template.systemKey);
    if (!row) {
      const id = crypto.randomUUID();
      const now = new Date();
      const payload = Object.assign({}, template, {
        id,
        circleId: String(circleId),
        status: "active",
        createdAt: now.toISOString(),
        createdAtMs: now.getTime(),
      });
      const inserted = await db.query(
        `
        INSERT INTO incircle_docs (id, circle_id, created_by_user_id, title, category, status, payload)
        VALUES ($1, $2, $3, $4, $5, 'active', $6::jsonb)
        ON CONFLICT DO NOTHING
        RETURNING id
        `,
        [id, circleId, userId || null, template.title, template.category, JSON.stringify(payload)]
      );
      if (inserted.rowCount) summary.inserted += 1;
      else summary.unchanged += 1;
      continue;
    }

    if (!shouldRefreshSystemDoc(row, template)) {
      summary.unchanged += 1;
      continue;
    }

    const payload = mergedSystemDocPayload(row, template, circleId);
    await db.query(
      `
      UPDATE incircle_docs
      SET title = $2,
          category = $3,
          status = 'active',
          payload = $4::jsonb,
          updated_at = now()
      WHERE id = $1
      `,
      [row.id, template.title, template.category, JSON.stringify(payload)]
    );
    summary.updated += 1;
  }
  return summary;
}

async function reconcileDefaultSystemDocs(db) {
  const circles = await db.query("SELECT id, owner_user_id FROM incircle_circles ORDER BY created_at ASC");
  const summary = { circles: circles.rows.length, inserted: 0, updated: 0, unchanged: 0 };
  for (const circle of circles.rows) {
    const circleSummary = await ensureDefaultSystemDocsForCircle(db, circle.id, circle.owner_user_id || null);
    summary.inserted += circleSummary.inserted;
    summary.updated += circleSummary.updated;
    summary.unchanged += circleSummary.unchanged;
  }
  return summary;
}

module.exports = {
  SYSTEM_DOC_VERSIONS,
  defaultSystemDocs,
  ensureDefaultSystemDocsForCircle,
  funBadgeRules,
  reconcileDefaultSystemDocs,
  shouldRefreshSystemDoc,
};
