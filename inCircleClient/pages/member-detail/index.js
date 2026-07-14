const api = require("../../utils/api");
const memberRole = require("../../utils/memberRole");
const time = require("../../utils/time");

const FRIENDLY_TAGS = ["好约", "靠谱", "会组织", "气氛担当", "守时", "会照顾人", "资料达人", "AA清爽"];

function displayLogTime(log) {
  return time.displayDateTime(log.createdAt, log.createdAtMs, log.id);
}

function hasCurrentVoter(voters, memberCardId, userId) {
  const targetMemberId = String(memberCardId || "");
  const targetUserId = String(userId || "");
  if (!targetMemberId && !targetUserId) return false;
  return (voters || []).some((voter) => {
    if (typeof voter === "string") return false;
    const voterMemberId = String(voter.memberId || voter.member_card_id || "");
    const voterUserId = String(voter.userId || voter.user_id || "");
    return (!!targetMemberId && voterMemberId === targetMemberId) || (!!targetUserId && voterUserId === targetUserId);
  });
}

function decorateMember(member) {
  const role = memberRole.normalizeMemberRole(member.role);
  const roleClass = memberRole.roleClass(role);
  const myMemberCardId = member.myMemberCardId || "";
  const myUserId = member.myUserId || "";
  const isSelf =
    (!!myMemberCardId && String(member.id || "") === String(myMemberCardId)) ||
    (!!myUserId && String(member.userId || "") === String(myUserId));
  const friendlyTags = member.friendlyTags || [];
  const friendlyMap = friendlyTags.reduce((map, item) => {
    map[item.tag] = item;
    return map;
  }, {});
  const presets = (member.friendlyTagPresets || FRIENDLY_TAGS).map((item) => (typeof item === "string" ? { tag: item } : item));
  const friendlyTagOptions = presets.map((preset) => {
    const detail = friendlyMap[preset.tag] || {};
    const count = detail.count || 0;
    const active = hasCurrentVoter(detail.voters, myMemberCardId, myUserId);
    return {
      tag: preset.tag,
      count,
      active,
      stateText: active ? `${count || 1} 人认可 · 可取消` : count ? `${count} 人认可` : "轻点背书",
      activeClass: active ? "active" : "",
      threshold: detail.threshold || preset.threshold || 2,
    };
  });
  const scoreLogs = (member.scoreLogs || []).map((log) =>
    Object.assign({}, log, {
      createdAt: displayLogTime(log),
      memberName: log.memberName || member.name || "成员",
      typeText: log.type || "积分变动",
      deltaClass: log.delta > 0 ? "plus" : "minus",
      deltaText: log.delta > 0 ? `+${log.delta}` : String(log.delta),
    })
  );
  const scoreLogTotal = Number(member.scoreLogTotal || scoreLogs.length || 0);
  const tagProposals = (member.tagProposals || []).map((proposal) => {
    const voted = hasCurrentVoter(proposal.voters, myMemberCardId, myUserId);
    return Object.assign({}, proposal, {
      voted,
      voteText: proposal.status === "已上墙" ? "已上墙" : voted ? "取消" : "投一票",
      loadingText: voted ? "取消中..." : "投票中...",
      statusClass: proposal.status === "已上墙" ? "approved" : voted ? "voted" : "",
      metaText: `${proposal.votes || 0}/${proposal.threshold || 2} 票 · ${proposal.proposerName || "圈友"}提名`,
    });
  });
  return Object.assign({}, member, {
    role,
    roleClass,
    skills: member.skills || [],
    interests: member.interests || [],
    taboos: member.taboos || [],
    tags: member.tags || [],
    friendlyTags,
    friendlyTagOptions,
    hasTags: member.tags && member.tags.length > 0,
    tagProposals,
    hasTagProposals: tagProposals.length > 0,
    isSelf,
    canShowFriendlyActions: !isSelf,
    canShowTagProposals: !isSelf,
    recentActivities: member.recentActivities || [],
    scoreLogs: scoreLogs.slice(0, 5),
    scoreLogTotal,
    hasScoreLogs: scoreLogs.length > 0,
    hasMoreScoreLogs: !!member.hasMoreScoreLogs || scoreLogTotal > 5,
    stats: [
      { label: "积分", value: member.score },
      { label: "本周", value: member.weeklyScore },
      { label: "活动", value: member.activityCount },
    ],
  });
}

Page({
  data: {
    ready: false,
    member: null,
    tagDraft: "",
    actionLoadingType: "",
    actionLoadingId: "",
  },

  onLoad(options) {
    this.memberId = options.id;
    this.loadMember();
  },

  loadMember() {
    api.getMember(this.memberId).then((member) => {
      this.setData({
        member: decorateMember(member),
        ready: true,
      });
    });
  },

  startAction(type, id) {
    if (this.data.actionLoadingType) return false;
    this.setData({
      actionLoadingType: type,
      actionLoadingId: id || "",
    });
    return true;
  },

  finishAction() {
    this.setData({
      actionLoadingType: "",
      actionLoadingId: "",
    });
  },

  showActionError(error) {
    wx.showToast({
      title: (error && error.message) || "操作失败，请稍后重试",
      icon: "none",
    });
  },

  runAction(type, id, task) {
    if (!this.startAction(type, id)) return Promise.resolve();
    return Promise.resolve()
      .then(task)
      .catch((error) => {
        this.showActionError(error);
      })
      .then(() => {
        this.finishAction();
      });
  },

  addFriendlyTag(e) {
    const tag = e.currentTarget.dataset.tag;
    if (!tag) return;
    const option = (this.data.member.friendlyTagOptions || []).find((item) => item.tag === tag);
    this.runAction("addTag", tag, () => api.addMemberTag(this.data.member.id, tag, { source: "friendly" }).then((member) => {
      const action = member.friendlyAction || {};
      const canceled = action.added === false || (typeof action.added === "undefined" && option && option.active);
      const toastTitle = canceled ? "已取消印象" : action.becamePromoted ? "已加入标签墙" : "已记录友好印象";
      this.setData({ member: decorateMember(member) });
      wx.showToast({
        title: toastTitle,
        icon: "none",
      });
    }));
  },

  onTagDraftInput(e) {
    this.setData({
      tagDraft: e.detail.value,
    });
  },

  proposeTag() {
    const tag = String(this.data.tagDraft || "").trim();
    if (!tag) {
      wx.showToast({ title: "先写一个标签", icon: "none" });
      return;
    }
    this.runAction("proposeTag", "", () => api.proposeMemberTag(this.data.member.id, tag).then((member) => {
      this.setData({
        member: decorateMember(member),
        tagDraft: "",
      });
      wx.showToast({
        title: "标签已进入投票",
        icon: "success",
      });
    }));
  },

  voteTagProposal(e) {
    const proposalId = e.currentTarget.dataset.id;
    if (e.currentTarget.dataset.status === "已上墙") return;
    const proposal = (this.data.member.tagProposals || []).find((item) => item.id === proposalId);
    this.runAction("voteTag", proposalId, () => api.voteMemberTagProposal(this.data.member.id, proposalId).then((member) => {
      this.setData({ member: decorateMember(member) });
      wx.showToast({
        title: proposal && proposal.voted ? "已取消投票" : "已投一票",
        icon: "success",
      });
    }));
  },

  removeTag(e) {
    const tag = e.currentTarget.dataset.tag;
    if (!this.data.member.canEditTags) {
      this.appealTag(tag);
      return;
    }
    this.runAction("removeTag", tag, () => api.removeMemberTag(this.data.member.id, tag).then((member) => {
      this.setData({ member: decorateMember(member) });
      wx.showToast({
        title: "标签已删除",
        icon: "success",
      });
    }));
  },

  appealTag(tag) {
    const targetTag = typeof tag === "string" ? tag : "";
    this.runAction("appealTag", targetTag || "标签墙", () =>
      api.appealMemberTag(this.data.member.id, targetTag, "成员认为该标签不合适").then(() => {
        wx.showToast({ title: "申诉已提交", icon: "success" });
      })
    );
  },

  openScoreLogs() {
    const member = this.data.member || {};
    wx.navigateTo({
      url: `/pages/score-logs/index?memberId=${member.id || this.memberId}&lockMember=1`,
    });
  },

  onShareAppMessage() {
    const member = this.data.member || {};
    return {
      title: member.name ? `${member.name} 的圈内身份卡` : "周末不宅小队成员图鉴",
      path: `/pages/member-detail/index?id=${member.id || this.memberId}`,
    };
  },
});
