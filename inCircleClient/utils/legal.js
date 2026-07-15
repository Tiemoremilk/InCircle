const OPERATOR_TOKEN = "{{INCIRCLE_LEGAL_OPERATOR}}";
const CONTACT_EMAIL_TOKEN = "{{INCIRCLE_LEGAL_CONTACT_EMAIL}}";
const TERMS_VERSION_TOKEN = "{{INCIRCLE_TERMS_VERSION}}";
const PRIVACY_VERSION_TOKEN = "{{INCIRCLE_PRIVACY_VERSION}}";
const EFFECTIVE_DATE_TOKEN = "{{INCIRCLE_LEGAL_EFFECTIVE_DATE}}";
const ACCEPTANCE_STORAGE_KEY = "incircleAgreementAcceptance";

const documents = {
  terms: {
    key: "terms",
    title: "InCircle 用户服务协议",
    shortTitle: "用户服务协议",
    version: TERMS_VERSION_TOKEN,
    effectiveDate: EFFECTIVE_DATE_TOKEN,
    intro: `欢迎使用 InCircle。本协议由用户与个人开发者${OPERATOR_TOKEN}共同订立，用于说明双方在使用熟人圈协作服务时的权利、义务与责任边界。`,
    sections: [
      {
        title: "一、协议确认与适用范围",
        paragraphs: [
          "在注册、登录、绑定账号或继续使用 InCircle 前，请完整阅读并理解本协议及《InCircle 隐私政策》。当你主动勾选并继续，即表示你已阅读、理解并同意受本协议约束。",
          "InCircle 是面向现实熟人关系的小圈子协作工具，不提供陌生人匹配、公开广场、支付结算、借贷、征信或专业咨询服务。",
        ],
      },
      {
        title: "二、账号注册与安全",
        bullets: [
          "你需要使用账号密码并绑定当前微信身份。一个账号只能绑定一个有效微信身份。",
          "你应提供真实、合法且必要的资料，并妥善保管账号密码，不得出借、出售或以其他方式转让账号。",
          "发现账号被冒用或存在异常时，应及时修改密码或通过本协议所列邮箱联系我们。",
          "因用户主动泄露密码、共用设备未退出登录等自身原因造成的损失，由用户依法承担相应责任。",
        ],
      },
      {
        title: "三、圈子与成员规则",
        paragraphs: [
          "所有活动、AA、投票、打卡、资料、成员卡、积分和圈内 AI 均归属于特定圈子。用户只有在有效加入该圈子后，才能访问相应的圈内内容。",
        ],
        bullets: [
          "圈主负责创建圈子并维护圈内秩序；成员应遵守圈主公布且不违反法律法规的圈内规则。",
          "邀请码、分享卡片和入圈码仅应提供给认识并信任的人。更换邀请码后，旧邀请码和旧邀请入口将失效。",
          "圈主不能直接退出或注销账号，应先解散其拥有的圈子。普通账号可拥有的圈子数量以页面提示为准。",
          "平台可对违法、侵权、欺诈或严重影响服务安全的账号与圈子采取限制、封禁或删除措施。",
        ],
      },
      {
        title: "四、用户内容与行为规范",
        paragraphs: [
          "用户保留其依法享有的内容权利，同时授予 InCircle 为提供存储、展示、分享、备份与安全审核所必需的有限使用权限。该权限仅用于运行和改进本服务。",
        ],
        bullets: [
          "不得发布违法违规、侵犯他人隐私或知识产权、欺诈、骚扰、歧视、暴力及其他有害内容。",
          "不得上传身份证件、支付密码、银行卡完整信息等与圈内协作无关的高敏感信息。",
          "不得通过自动化脚本、恶意请求、伪造身份、越权访问等方式干扰服务或获取他人数据。",
          "分享圈内内容前，应确保已获得内容涉及人员的必要同意。",
        ],
      },
      {
        title: "五、AA、活动与投票说明",
        paragraphs: [
          "AA 功能仅用于记录消费明细、分摊结果和结清状态，不代收、代付、担保或确认真实资金已经转移。用户应自行核对金额并通过合法支付渠道完成付款。",
          "活动报名、投票、打卡、积分和榜单是圈内协作记录，不构成合同担保、征信评价或对人员能力与品行的专业判断。",
        ],
      },
      {
        title: "六、圈内 AI 服务",
        bullets: [
          "AI 功能由圈主选择并配置第三方模型服务商，默认关闭，且仅在用户另行授权后使用。",
          "用户输入及必要会话上下文会发送至页面明确展示的模型服务商，相关处理同时受该服务商条款与隐私政策约束。",
          "AI 输出可能存在错误、遗漏或偏差，仅供参考。医疗、法律、财务、安全等重要决定应咨询具备资质的专业人士。",
          "第一版 AI 不会自动执行圈内操作。用户不得利用 AI 生成或传播违法、侵权和有害内容。",
        ],
      },
      {
        title: "七、服务变更、中断与数据处理",
        paragraphs: [
          "我们会尽力保障服务稳定，但网络、微信平台、云服务、第三方模型、设备兼容或维护升级可能导致短暂中断。对于可预见的重要变更，我们会通过页面提示等合理方式告知。",
          "账号注销将按产品规则删除或匿名化个人数据。为保持其他成员共同业务记录的完整性，用户在他人圈子中创建的活动、账单、投票等共享记录可能保留，但创建者身份会被匿名化。",
        ],
      },
      {
        title: "八、知识产权",
        paragraphs: [
          "InCircle 的程序、界面、品牌标识、文档及由运营者制作的内容受法律保护。未经许可，不得复制、出售、反向利用或用于与本服务竞争的产品。用户依法享有其自行上传内容的权利。",
        ],
      },
      {
        title: "九、责任边界",
        paragraphs: [
          "用户之间因线下活动、费用分摊、内容真实性、人身财产或其他现实交往产生的争议，应由相关用户依法协商或解决。InCircle 仅提供信息记录与协作工具，但会在法律要求和合理能力范围内提供必要协助。",
          "任何免责或责任限制均不排除法律规定不得排除或限制的责任。",
        ],
      },
      {
        title: "十、未成年人保护",
        paragraphs: [
          "未满 18 周岁的用户应在监护人阅读并同意本协议后使用服务。我们不建议未成年人填写手机号以外的敏感个人信息或独自参加缺乏监护的线下活动。",
        ],
      },
      {
        title: "十一、协议更新与争议解决",
        paragraphs: [
          "协议发生实质变化时，我们会更新版本并重新征得同意。若你不同意更新内容，可以停止使用并依照产品流程注销账号。",
          "本协议适用中华人民共和国法律。争议应先友好协商；协商不成的，依法向有管辖权的人民法院提起诉讼。",
        ],
      },
      {
        title: "十二、联系我们",
        paragraphs: [
          `个人开发者：${OPERATOR_TOKEN}`,
          `联系邮箱：${CONTACT_EMAIL_TOKEN}`,
          "我们会在核验请求人与账号关系后处理账号、安全、协议及其他服务问题。",
        ],
      },
    ],
  },
  privacy: {
    key: "privacy",
    title: "InCircle 隐私政策",
    shortTitle: "隐私政策",
    version: PRIVACY_VERSION_TOKEN,
    effectiveDate: EFFECTIVE_DATE_TOKEN,
    intro: `本政策说明个人开发者${OPERATOR_TOKEN}在运营 InCircle 时如何收集、使用、共享、存储和保护个人信息，以及用户如何行使相关权利。`,
    sections: [
      {
        title: "一、我们如何收集和使用信息",
        paragraphs: [
          "我们遵循合法、正当、必要和诚信原则，仅处理实现明确功能所需的信息。拒绝提供非必要信息不会影响基础浏览，但可能导致对应功能无法使用。",
        ],
        bullets: [
          "账号与身份：账号名、经安全哈希处理的密码、微信 OpenID/UnionID、绑定状态、登录时间，用于注册、登录、找回密码、防止冒用及维持会话。我们不保存明文密码。",
          "个人资料：昵称、头像、手机号、圈内称呼、个人备注，用于建立账号和圈内身份卡。手机号用于熟人圈结款与必要联系，默认不在普通成员详情接口公开。",
          "圈子关系：创建或加入的圈子、角色、加入及最近进入时间，用于权限校验、圈子切换和常用圈子排序。",
          "协作内容：活动、报名、AA 明细与结清状态、投票、打卡、资料、标签、积分、举报及相关操作记录，用于实现用户主动使用的圈内功能。",
          "设备与安全信息：请求时间、网络地址、接口错误、令牌状态及必要运行日志，用于防攻击、限流、故障排查和审计，不用于建立商业广告画像。",
        ],
      },
      {
        title: "二、系统权限与用户主动提供的信息",
        bullets: [
          "头像和昵称：仅在用户点击头像选择或昵称输入控件时获取，用于注册资料或圈内身份卡。",
          "位置：仅在用户主动创建地点投票或约局并选择位置时调用微信位置选择能力，保存所选地点名称、地址及坐标。我们不持续追踪位置。",
          "图片与相册：仅在用户主动上传头像、活动照片、打卡图片或保存入圈码时使用相应能力。",
          "订阅通知：仅在用户主动触发并由微信确认授权后使用；未配置模板时不会发送通知。",
        ],
      },
      {
        title: "三、圈内可见范围",
        paragraphs: [
          "用户提交的圈内内容会按照功能目的向同一圈子的有效成员展示。例如活动报名需要展示参与状态，AA 需要展示分摊结果，身份卡需要展示用户选择公开的圈内资料。非成员不能仅凭业务 ID 获取这些内容。",
          "圈主和圈内管理者可按产品规则管理成员与业务，但不能查看其他成员未举报的 AI 私聊正文。平台管理能力仅用于安全、合规和账号处理。",
        ],
      },
      {
        title: "四、AI 与第三方处理",
        paragraphs: [
          "圈内 AI 开启后，我们会在首次使用具体供应商前另行展示供应商名称、域名和隐私政策，并征得单独同意。只有同意后，用户输入、圈级系统提示和当前会话必要上下文才会发送给该供应商。",
          "AI 请求与回答会经过微信文本内容安全能力检查。供应商或其隐私政策发生变化时，会重新征得同意。用户可删除自己的会话；圈主和普通成员不能查看其他人的聊天正文。",
        ],
      },
      {
        title: "五、共享、委托处理与公开披露",
        bullets: [
          "微信平台：用于身份登录、头像昵称选择、位置选择、小程序码、订阅通知及内容安全等能力。",
          "云服务器与数据库服务：用于托管接口、数据库、上传媒体、日志与备份，并按必要范围处理数据。",
          "圈子配置的 AI 服务商：仅在用户单独授权后处理对应 AI 会话内容。",
          "法律要求：根据有效法律程序、监管要求或为保护用户及公众重大权益而进行必要披露。",
        ],
        paragraphs: [
          "我们不出售个人信息，不将个人信息用于与本产品无关的广告定向。除上述情形、用户主动分享或法律另有规定外，不向无关第三方提供个人信息。",
        ],
      },
      {
        title: "六、信息存储与保留",
        paragraphs: [
          "数据主要存储于自建后端使用的服务器与 PostgreSQL 数据库，并在实现功能、保障安全及满足法律要求所需的最短期限内保留。传输使用 HTTPS，密码使用高强度哈希保存，AI 密钥使用认证加密保存。",
          "用户注销后，账号身份、个人成员关系、选票、打卡和 AI 会话会按产品规则删除或匿名化；其他成员共同依赖的活动、账单、资料等记录可能保留匿名化创建者。备份中的残留数据将在正常备份轮换周期内被覆盖，法律要求保留的安全审计记录除外。",
        ],
      },
      {
        title: "七、信息安全",
        bullets: [
          "使用账号密码、微信绑定、短期令牌和权限校验保护账号及圈子边界。",
          "对上传、AI、自定义模型地址和管理操作实施鉴权、限流、内容检查与操作审计。",
          "发生可能影响用户权益的安全事件时，将依法采取补救措施并以合理方式通知。",
        ],
        paragraphs: [
          "互联网服务无法保证绝对安全。请勿在身份卡、账单备注、打卡图片、资料或 AI 对话中填写身份证号、支付密码、银行卡验证码等非必要敏感信息。",
        ],
      },
      {
        title: "八、用户的个人信息权利",
        bullets: [
          "访问与更正：可在身份卡、圈子设置或账号相关页面查看和修改相应资料。",
          "删除：可删除本人有权管理的业务内容、AI 会话，或按产品规则注销账号。圈主需先解散名下圈子。",
          "撤回授权：可在微信系统设置中关闭位置、相册等权限；撤回不影响此前基于授权进行的合法处理。",
          "解释与投诉：可通过联系邮箱提出访问、更正、删除、注销、撤回同意或投诉请求。我们会先核验账号关系。",
        ],
      },
      {
        title: "九、未成年人信息",
        paragraphs: [
          "未成年人应在监护人指导下使用服务并提供信息。如果监护人发现未成年人未经同意提供了个人信息，可通过联系邮箱提出处理请求。",
        ],
      },
      {
        title: "十、政策更新",
        paragraphs: [
          "当处理目的、信息类型、共享对象或用户权利发生实质变化时，我们会更新政策版本，通过登录页或其他显著方式提示，并在继续处理前重新征得同意。",
        ],
      },
      {
        title: "十一、联系我们",
        paragraphs: [
          `个人信息处理者：${OPERATOR_TOKEN}`,
          `联系邮箱：${CONTACT_EMAIL_TOKEN}`,
          "请在邮件中说明请求类型及可用于核验账号关系的信息。为保护账号安全，我们不会要求你提供密码、支付验证码或完整身份证件。",
        ],
      },
    ],
  },
};

function storageGet() {
  try {
    return typeof wx !== "undefined" && wx.getStorageSync ? wx.getStorageSync(ACCEPTANCE_STORAGE_KEY) || {} : {};
  } catch (error) {
    return {};
  }
}

function isLocallyAccepted(publicProfile) {
  const stored = storageGet();
  const profile = normalizePublicLegalProfile(publicProfile);
  return !!(
    profile.termsVersion
    && profile.privacyVersion
    && stored.termsVersion === profile.termsVersion
    && stored.privacyVersion === profile.privacyVersion
  );
}

function markLocallyAccepted(publicProfile) {
  const profile = normalizePublicLegalProfile(publicProfile);
  if (!profile.termsVersion || !profile.privacyVersion) return false;
  try {
    if (typeof wx !== "undefined" && wx.setStorageSync) {
      wx.setStorageSync(ACCEPTANCE_STORAGE_KEY, {
        termsVersion: profile.termsVersion,
        privacyVersion: profile.privacyVersion,
        acceptedAt: new Date().toISOString(),
      });
    }
  } catch (error) {
    // Server-side acceptance remains authoritative when local storage is unavailable.
  }
  return true;
}

function acceptancePayload(accepted, publicProfile) {
  const profile = normalizePublicLegalProfile(publicProfile);
  return {
    accepted: accepted === true,
    termsVersion: profile.termsVersion,
    privacyVersion: profile.privacyVersion,
  };
}

function normalizePublicLegalProfile(source) {
  const profile = source || {};
  return {
    operatorName: String(profile.operatorName || "").trim(),
    contactEmail: String(profile.contactEmail || "").trim().toLowerCase(),
    termsVersion: String(profile.termsVersion || "").trim(),
    privacyVersion: String(profile.privacyVersion || "").trim(),
    effectiveDate: String(profile.effectiveDate || "").trim().slice(0, 10),
  };
}

function isPublicLegalProfileComplete(source) {
  const profile = normalizePublicLegalProfile(source);
  return !!(
    profile.operatorName
    && profile.contactEmail
    && profile.termsVersion
    && profile.privacyVersion
    && /^\d{4}-\d{2}-\d{2}$/.test(profile.effectiveDate)
  );
}

function effectiveDateText(value) {
  const matched = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!matched) return "未配置";
  return `${Number(matched[1])} 年 ${Number(matched[2])} 月 ${Number(matched[3])} 日`;
}

function replaceProfileTokens(value, profile) {
  if (Array.isArray(value)) return value.map((item) => replaceProfileTokens(item, profile));
  if (value && typeof value === "object") {
    return Object.keys(value).reduce((result, key) => {
      result[key] = replaceProfileTokens(value[key], profile);
      return result;
    }, {});
  }
  if (typeof value !== "string") return value;
  return value
    .split(OPERATOR_TOKEN).join(profile.operatorName || "未配置")
    .split(CONTACT_EMAIL_TOKEN).join(profile.contactEmail || "未配置")
    .split(TERMS_VERSION_TOKEN).join(profile.termsVersion || "未配置")
    .split(PRIVACY_VERSION_TOKEN).join(profile.privacyVersion || "未配置")
    .split(EFFECTIVE_DATE_TOKEN).join(effectiveDateText(profile.effectiveDate));
}

function getDocument(type, publicProfile) {
  const document = documents[type === "privacy" ? "privacy" : "terms"];
  return replaceProfileTokens(document, normalizePublicLegalProfile(publicProfile));
}

module.exports = {
  acceptancePayload,
  getDocument,
  isPublicLegalProfileComplete,
  isLocallyAccepted,
  markLocallyAccepted,
  normalizePublicLegalProfile,
};
