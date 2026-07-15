const api = require("../../utils/api");
const avatar = require("../../utils/avatar");
const memberRole = require("../../utils/memberRole");
const time = require("../../utils/time");

const RANK_TABS = [
  { key: "score", label: "活跃榜" },
  { key: "monthActivityCount", label: "本月活动" },
  { key: "checkinDays", label: "打卡榜" },
  { key: "organizerCount", label: "组织者榜" },
  { key: "punctualCount", label: "守时榜" },
  { key: "noShowCount", label: "鸽局榜", sensitive: true },
];
const SCORE_RULE_PREVIEW_COUNT = 8;

function visibleRankTabs(sensitiveRankEnabled) {
  return RANK_TABS.filter((tab) => sensitiveRankEnabled || !tab.sensitive);
}

function decorateRankTabs(activeRank, sensitiveRankEnabled) {
  return visibleRankTabs(sensitiveRankEnabled).map((tab) =>
    Object.assign({}, tab, {
      activeClass: tab.key === activeRank ? "active" : "",
    })
  );
}

function rankTabByKey(key) {
  return RANK_TABS.find((tab) => tab.key === key) || RANK_TABS[0];
}

function decorateMember(member) {
  const role = memberRole.normalizeMemberRole(member.role);
  return Object.assign({}, member, { role, roleClass: memberRole.roleClass(role) });
}

function hasRankData(members, rankKey) {
  const values = (members || []).map((member) => Number(member[rankKey] || 0));
  const maxValue = Math.max.apply(null, values.concat([0]));
  const uniqueValues = values.reduce((list, value) => {
    if (list.indexOf(value) === -1) list.push(value);
    return list;
  }, []);
  return maxValue > 0 && uniqueValues.length > 1;
}

function rankMembers(members, rankKey) {
  return members
    .slice()
    .sort((a, b) => {
      const av = a[rankKey] || 0;
      const bv = b[rankKey] || 0;
      return bv - av;
    })
    .map((member, index) =>
      Object.assign({}, member, {
        rank: index + 1,
        rankValue: member[rankKey] || 0,
      })
    );
}

function buildRankState(members, rankKey) {
  const tab = rankTabByKey(rankKey);
  const hasData = hasRankData(members, rankKey);
  const values = (members || []).map((member) => Number(member[rankKey] || 0));
  const maxValue = Math.max.apply(null, values.concat([0]));
  const copyMap = {
    score: "产生积分动态后，这里会按真实积分展示活跃成员。",
    monthActivityCount: "本月有人参与活动后，再生成本月活动榜。",
    checkinDays: "有人完成打卡后，再生成打卡榜。",
    organizerCount: "有人发起活动后，再生成组织者榜。",
    punctualCount: "有守时记录后，再生成守时榜。",
    noShowCount: "有明确鸽局记录后，再生成敏感榜。",
  };
  return {
    rankedMembers: hasData ? rankMembers(members, rankKey) : [],
    hasRankData: hasData,
    rankEmptyTitle: maxValue > 0 ? "暂无可比较差异" : `暂无${tab.label}数据`,
    rankEmptyCopy: maxValue > 0 ? "当前成员该项数据相同，暂不生成随机排名。" : copyMap[rankKey] || "有可比较的数据后，这里会自动生成榜单。",
  };
}

function decorateScoreRules(rules) {
  return rules.map((rule) =>
    Object.assign({}, rule, {
      label: rule.label || rule.title || "规则",
      value: String(rule.value || `${Number(rule.score || 0) >= 0 ? "+" : ""}${Number(rule.score || 0)}`),
      valueClass: String(rule.value || rule.score || "").indexOf("-") === 0 ? "minus" : "plus",
    })
  );
}

function buildScoreRuleState(scoreRules, expanded) {
  const rules = scoreRules || [];
  const hiddenCount = Math.max(0, rules.length - SCORE_RULE_PREVIEW_COUNT);
  const hasHiddenScoreRules = hiddenCount > 0;
  const scoreRulesExpanded = !!expanded && hasHiddenScoreRules;
  return {
    visibleScoreRules: scoreRulesExpanded || !hasHiddenScoreRules ? rules : rules.slice(0, SCORE_RULE_PREVIEW_COUNT),
    scoreRulesExpanded,
    hasHiddenScoreRules,
    hiddenScoreRuleCount: hiddenCount,
    scoreRuleToggleText: scoreRulesExpanded ? "收起规则" : `展开剩余 ${hiddenCount} 条`,
    scoreRuleToggleMeta: scoreRulesExpanded ? `收起后保留前 ${SCORE_RULE_PREVIEW_COUNT} 条` : `共 ${rules.length} 条规则`,
  };
}

function displayLogTime(log) {
  return time.displayDateTime(log.createdAt, log.createdAtMs, log.id);
}

function decorateScoreLogs(logs) {
  return (logs || []).map((log) =>
    Object.assign({}, log, {
      createdAt: displayLogTime(log),
      typeText: log.type || "积分变动",
      deltaClass: log.delta > 0 ? "plus" : "minus",
      deltaText: log.delta > 0 ? `+${log.delta}` : String(log.delta),
    })
  );
}

function listToText(list) {
  return (list || []).join("、");
}

function textToList(text) {
  return String(text || "")
    .split(/[\n,，、/]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeBadgeName(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text === "已更新" || text === "已更新资料" || text === "资料已更新" || text === "身份卡已更新") {
    return "身份卡装修师";
  }
  return text;
}

function normalizeBadges(list) {
  const badges = [];
  (list || []).forEach((item) => {
    const badge = normalizeBadgeName(item);
    if (badge && badges.indexOf(badge) === -1) badges.push(badge);
  });
  return badges;
}

function draftFromCard(card) {
  const safeCard = card || {};
  const storedAvatar = safeCard.avatarFileID || safeCard.avatar || "/images/avatar.png";
  return {
    name: safeCard.name || "",
    avatar: storedAvatar,
    avatarDisplayUrl: safeCard.avatar || storedAvatar,
    title: safeCard.title || "",
    availability: safeCard.availability || "",
    note: safeCard.note || "",
    tagsText: listToText(safeCard.tags),
    skillsText: listToText(safeCard.skills),
    interestsText: listToText(safeCard.interests),
    taboosText: listToText(safeCard.taboos),
  };
}

Page({
  data: {
    loading: true,
    myCard: null,
    members: [],
    rankedMembers: [],
    hasRankData: false,
    rankEmptyTitle: "暂无榜单数据",
    rankEmptyCopy: "有可比较的数据后，这里会自动生成榜单。",
    scoreRules: [],
    visibleScoreRules: [],
    scoreRulesExpanded: false,
    hasHiddenScoreRules: false,
    hiddenScoreRuleCount: 0,
    scoreRuleToggleText: "",
    scoreRuleToggleMeta: "",
    recentScoreLogs: [],
    scoreLogTotal: 0,
    hasMoreScoreLogs: false,
    monthlyHonors: [],
    rankTabs: decorateRankTabs("score", false),
    activeRank: "score",
    sensitiveRankEnabled: false,
    sensitiveRankText: "开启敏感榜",
    showEditSheet: false,
    avatarUploading: false,
    cardSaving: false,
    cardDraft: {
      name: "",
      avatar: "/images/avatar.png",
      avatarDisplayUrl: "/images/avatar.png",
      title: "",
      availability: "",
      note: "",
      tagsText: "",
      skillsText: "",
      interestsText: "",
      taboosText: "",
    },
  },

  onShow() {
    this.setTabBarHidden(!!this.data.showEditSheet);
    this.loadMembers();
  },

  onHide() {
    this.setTabBarHidden(false);
  },

  onUnload() {
    this.setTabBarHidden(false);
  },

  setTabBarHidden(hidden) {
    const tabBar = typeof this.getTabBar === "function" ? this.getTabBar() : null;
    if (!tabBar || typeof tabBar.setData !== "function" || tabBar.data.hidden === !!hidden) return;
    tabBar.setData({ hidden: !!hidden });
  },

  loadMembers() {
    api.listMembers().then((data) => {
      const members = data.members.map(decorateMember);
      const scoreLogs = decorateScoreLogs(data.scoreLogs || []);
      const scoreLogTotal = data.scoreLogTotal || scoreLogs.length;
      const scoreRules = decorateScoreRules(data.scoreRules || []);
      this.setData({
        myCard: decorateMember(data.myCard),
        members,
        ...buildRankState(members, this.data.activeRank),
        scoreRules,
        ...buildScoreRuleState(scoreRules, this.data.scoreRulesExpanded),
        recentScoreLogs: scoreLogs.slice(0, 5),
        scoreLogTotal,
        hasMoreScoreLogs: !!data.hasMoreScoreLogs || scoreLogTotal > 5,
        monthlyHonors: data.monthlyHonors || [],
        cardDraft: draftFromCard(data.myCard),
        loading: false,
      });
    });
  },

  switchRank(e) {
    const activeRank = e.currentTarget.dataset.key;
    this.setData({
      activeRank,
      rankTabs: decorateRankTabs(activeRank, this.data.sensitiveRankEnabled),
      ...buildRankState(this.data.members, activeRank),
    });
  },

  toggleSensitiveRank() {
    const sensitiveRankEnabled = !this.data.sensitiveRankEnabled;
    const activeRank = sensitiveRankEnabled || this.data.activeRank !== "noShowCount" ? this.data.activeRank : "score";
    this.setData({
      sensitiveRankEnabled,
      sensitiveRankText: sensitiveRankEnabled ? "关闭敏感榜" : "开启敏感榜",
      activeRank,
      rankTabs: decorateRankTabs(activeRank, sensitiveRankEnabled),
      ...buildRankState(this.data.members, activeRank),
    });
  },

  toggleScoreRules() {
    if (!this.data.hasHiddenScoreRules) return;
    this.setData(buildScoreRuleState(this.data.scoreRules, !this.data.scoreRulesExpanded));
  },

  editCard() {
    this.setTabBarHidden(true);
    this.setData({
      showEditSheet: true,
      cardDraft: draftFromCard(this.data.myCard),
    });
  },

  closeEditSheet() {
    if (this.data.avatarUploading || this.data.cardSaving) return;
    this.setData({
      showEditSheet: false,
    }, () => this.setTabBarHidden(false));
  },

  noop() {},

  onCardInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({
      [`cardDraft.${field}`]: e.detail.value,
    });
  },

  onChooseCardAvatar(e) {
    if (this.data.avatarUploading || this.data.cardSaving) return;
    const avatarUrl = e.detail && e.detail.avatarUrl ? e.detail.avatarUrl : "";
    if (!avatarUrl) {
      wx.showToast({ title: "未选择头像", icon: "none" });
      return;
    }
    const previousAvatar = this.data.cardDraft.avatar || "/images/avatar.png";
    const previousAvatarDisplay = this.data.cardDraft.avatarDisplayUrl || previousAvatar;
    this.setData({
      "cardDraft.avatar": avatarUrl,
      "cardDraft.avatarDisplayUrl": avatarUrl,
      avatarUploading: true,
    });
    avatar
      .uploadAvatar(avatarUrl, {
        circleId: this.data.myCard && this.data.myCard.circleId,
        userId: this.data.myCard && this.data.myCard.userId,
        cardId: this.data.myCard && this.data.myCard.id,
        openid: this.data.myCard && this.data.myCard.openid,
      })
      .then((nextAvatar) => avatar.resolveAvatarUrl(nextAvatar).then((displayUrl) => ({ nextAvatar, displayUrl })))
      .then(({ nextAvatar, displayUrl }) => {
        this.setData({
          "cardDraft.avatar": nextAvatar,
          "cardDraft.avatarDisplayUrl": displayUrl || nextAvatar,
          avatarUploading: false,
        });
        wx.showToast({ title: "头像已上传", icon: "success" });
      })
      .catch((error) => {
        this.setData({
          "cardDraft.avatar": previousAvatar,
          "cardDraft.avatarDisplayUrl": previousAvatarDisplay,
          avatarUploading: false,
        });
        wx.showToast({
          title: (error && error.message) || "头像上传失败",
          icon: "none",
        });
      });
  },

  submitCard() {
    if (this.data.avatarUploading) {
      wx.showToast({ title: "头像还在上传", icon: "none" });
      return;
    }
    if (this.data.cardSaving) return;
    const badge = "身份卡装修师";
    const badges = normalizeBadges(this.data.myCard.badges || []);
    const hasBadge = badges.indexOf(badge) !== -1;
    const draft = this.data.cardDraft;
    const name = String(draft.name || "").trim();
    if (!name || name.length < 2) {
      wx.showToast({ title: "请填写至少 2 个字的昵称", icon: "none" });
      return;
    }
    if (avatar.isTemporaryAvatar(draft.avatar)) {
      wx.showToast({ title: "请等头像上传成功后再保存", icon: "none" });
      return;
    }
    const patch = {
      score: this.data.myCard.score + (hasBadge ? 0 : 5),
      badges: hasBadge ? badges : [badge].concat(badges),
      name,
      avatar: draft.avatar || this.data.myCard.avatar || "/images/avatar.png",
      title: draft.title || this.data.myCard.title,
      availability: draft.availability || this.data.myCard.availability,
      note: draft.note || this.data.myCard.note,
      tags: textToList(draft.tagsText),
      skills: textToList(draft.skillsText),
      interests: textToList(draft.interestsText),
      taboos: textToList(draft.taboosText),
      safetyNote: "身份卡已更新：标签仅娱乐展示，不合适可以删除或申诉。",
    };
    this.setData({ cardSaving: true });
    api.updateMyCard(patch).then((data) => {
      const members = data.members.map(decorateMember);
      this.setData({
        myCard: decorateMember(data.myCard),
        members,
        ...buildRankState(members, this.data.activeRank),
        cardDraft: draftFromCard(data.myCard),
        showEditSheet: false,
        cardSaving: false,
      }, () => this.setTabBarHidden(false));
      wx.showToast({
        title: "身份卡已更新",
        icon: "success",
      });
    })
      .catch((error) => {
        this.setData({ cardSaving: false });
        wx.showToast({
          title: (error && error.message) || "保存失败，请稍后重试",
          icon: "none",
        });
      });
  },

  openMember(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/member-detail/index?id=${id}`,
    });
  },

  openScoreLogs() {
    wx.navigateTo({
      url: "/pages/score-logs/index",
    });
  },

  onShareAppMessage() {
    return {
      title: "周末不宅小队成员图鉴：看看本月荣誉和身份卡",
      path: "/pages/members/index",
    };
  },
});
