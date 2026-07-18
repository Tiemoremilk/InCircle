const api = require("../../utils/api");
const notice = require("../../utils/notice");
const time = require("../../utils/time");
const editIntent = require("../../utils/editIntent");
const dialog = require("../../utils/dialog");
const toolIntent = require("../../utils/toolIntent");
const privateApi = require("../../utils/wechat-private-api");

const TOOL_TABS = [
  { key: "aa", label: "AA", icon: "/images/ui-icons/bill.png" },
  { key: "vote", label: "投票", icon: "/images/ui-icons/vote.png" },
  { key: "checkin", label: "打卡", icon: "/images/ui-icons/checkin.png" },
];
const SPLIT_MODES = ["平均分", "指定参与人", "某人不参与", "发起人免单", "老板请客", "自定义金额"];
const VOTE_TYPES = ["普通投票", "时间投票", "地点投票", "随机抽签", "命运转盘"];
const LOCATION_VOTE_TYPE = "地点投票";
const LOCATION_VOTE_TYPE_INDEX = VOTE_TYPES.indexOf(LOCATION_VOTE_TYPE);
const DEFAULT_VOTE_OPTIONS_TEXT = "火锅\n烧烤\n日料";
const LOCATION_VOTE_OPTIONS_TEXT = "万象城\n球馆\n家里";
const VOTE_VISIBILITIES = ["实名", "匿名"];
const VOTE_CHOICE_MODES = ["单选", "多选"];
const CHECKIN_TYPES = ["学习", "健身", "早睡早起", "阅读", "背单词", "每日拍照", "项目进度"];
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function defaultVoteDeadlineText() {
  const now = Date.now();
  const beijing = new Date(now + BEIJING_OFFSET_MS);
  let deadlineMs =
    Date.UTC(beijing.getUTCFullYear(), beijing.getUTCMonth(), beijing.getUTCDate(), 22, 0, 0) - BEIJING_OFFSET_MS;
  if (deadlineMs <= now) deadlineMs += 24 * 60 * 60 * 1000;
  return time.formatDateTime(deadlineMs);
}

function normalizeVoteDeadlineForSubmit(value) {
  const date = time.parseBeijingDateTime(value, Date.now()) || time.parseBeijingDateTime(defaultVoteDeadlineText(), Date.now());
  if (!date) return null;
  const deadlineAtMs = date.getTime();
  const deadlineDisplay = time.formatDateTime(deadlineAtMs);
  return {
    deadlineAtMs,
    deadlineAt: new Date(deadlineAtMs).toISOString(),
    deadlineDisplay,
    deadlineText: `${deadlineDisplay} 截止`,
  };
}

function voteDeadlineMs(vote) {
  return time.toTimestamp(vote && (vote.deadlineAt || vote.deadlineTime || vote.deadline), vote && vote.deadlineAtMs, vote && vote.id);
}

function decorateTabs(activeTool) {
  return TOOL_TABS.map((tab) =>
    Object.assign({}, tab, {
      activeClass: tab.key === activeTool ? "active" : "",
    })
  );
}

function toMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function memberOptions(members, selected) {
  return members.map((member) => ({
    name: member.name,
    activeClass: selected.indexOf(member.name) !== -1 ? "active" : "",
  }));
}

function parseExpenseItems(text) {
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const matched = line.match(/(\d+(\.\d+)?)/);
      const amount = matched ? toMoney(matched[1]) : 0;
      const name = line.replace(/[:：-]?\s*\d+(\.\d+)?\s*元?/, "").trim() || `消费 ${index + 1}`;
      return { name, amount };
    })
    .filter((item) => item.amount > 0);
}

function parseCustomAmounts(text, participants, payerName) {
  const participantSet = participants.reduce((map, name) => {
    map[name] = true;
    return map;
  }, {});
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const matched = line.match(/(\d+(\.\d+)?)/);
      const amount = matched ? toMoney(matched[1]) : 0;
      const name = line.replace(/[:：-]?\s*\d+(\.\d+)?\s*元?/, "").trim();
      return { name, amount };
    })
    .filter((item) => item.name && item.amount > 0 && item.name !== payerName && participantSet[item.name]);
}

function buildDecisionShareText(maker) {
  if (!maker || !maker.result) return "";
  const options = (maker.options || []).join("、");
  return `【${maker.title}】\n${maker.type || "随机决策"}结果：${maker.result}\n候选项：${options}`;
}

function buildVoteSummaryText(vote, options, winner, deadlineText) {
  const silent = vote.silent && vote.silent.length ? vote.silent.join("、") : "全员已投";
  const optionLines = (options || [])
    .map((option) => `${option.name} ${option.count || 0}票 (${option.percent || 0}%)${option.vetoed ? " / 已否决" : ""}`)
    .join("；");
  return [
    `【${vote.title || "投票"}】摘要分析`,
    "状态：已截止",
    `截止：${String(deadlineText || "").replace(/\s*截止$/, "")}`,
    `结论：${winner || "暂无有效投票"}`,
    `参与：${(vote.records || []).length} 票，未投：${silent}`,
    `明细：${optionLines || "暂无选项"}`,
  ].join("\n");
}

function memberKeyMap(members) {
  return (members || []).reduce((map, member) => {
    if (!member) return map;
    if (member.id) map[member.id] = member;
    if (member.openid) map[member.openid] = member;
    if (member.name) map[member.name] = member;
    return map;
  }, {});
}

function enrichVoteWithVoters(vote, members) {
  if (!vote || vote.visibility === "匿名") return vote;
  const membersByKey = memberKeyMap(members);
  const records = (vote.records || []).map((record) => {
    const member = membersByKey[record.memberId] || membersByKey[record.openid] || membersByKey[record.memberName] || {};
    return Object.assign({}, record, {
      memberName: record.memberName || member.name || "圈友",
      avatar: record.avatar || member.avatar || "/images/avatar.png",
    });
  });
  const options = (vote.options || []).map((option) => {
    const voters = records.filter((record) => record.optionName === option.name);
    return Object.assign({}, option, {
      voters,
      hasVoters: voters.length > 0,
    });
  });
  return Object.assign({}, vote, {
    records,
    options,
    showVoterAvatars: true,
  });
}

function recordBelongsToMember(record, member) {
  if (!record || !member) return false;
  return !!(
    (member.id && record.memberId === member.id) ||
    (member.openid && record.openid === member.openid) ||
    (member.name && record.memberName === member.name)
  );
}

function optionNamesFromSelectedOptions(vote) {
  return (vote && vote.options ? vote.options : [])
    .filter((option) => option && option.selected)
    .map((option) => option.name);
}

function selectedVoteOptionNames(vote, member) {
  if (!vote) return [];
  if (Array.isArray(vote.myVoteOptionNames)) return vote.myVoteOptionNames;
  const selected = {};
  optionNamesFromSelectedOptions(vote).forEach((name) => {
    selected[name] = true;
  });
  (vote.records || []).forEach((record) => {
    if (recordBelongsToMember(record, member) && record.optionName) {
      selected[record.optionName] = true;
    }
  });
  return Object.keys(selected);
}

function hasSelectedOption(vote, member, name) {
  return selectedVoteOptionNames(vote, member).indexOf(name) !== -1;
}

function isMultiChoiceVote(vote) {
  return vote && vote.choiceMode === "多选";
}

function decorateDecision(maker) {
  const hasResult = !!(maker && maker.result);
  const shareText = hasResult ? buildDecisionShareText(maker) : "";
  return Object.assign({}, maker, {
    hasResult,
    shareText,
    shareTitle: hasResult ? `【${maker.type || "决策结果"}】${maker.title}：${maker.result}` : `来生成：${maker.title}`,
  });
}

function emptyDrafts(members) {
  const names = members.map((member) => member.name);
  return {
    billDraft: {
      title: "",
      amount: "",
      payerName: names[0] || "",
      splitMode: SPLIT_MODES[0],
      participants: names.slice(0, 4),
      memberOptions: memberOptions(members, names.slice(0, 4)),
      expenseText: "",
      customAmountText: "",
      showCustomAmounts: false,
    },
    voteDraft: {
      title: "",
      type: VOTE_TYPES[0],
      typeIndex: 0,
      visibility: VOTE_VISIBILITIES[0],
      choiceMode: VOTE_CHOICE_MODES[0],
      allowVeto: false,
      allowVetoClass: "",
      organizerWeighted: false,
      organizerWeightedClass: "",
      deadline: defaultVoteDeadlineText(),
      optionsText: DEFAULT_VOTE_OPTIONS_TEXT,
      locationText: "",
      locationName: "",
      locationAddress: "",
      latitude: null,
      longitude: null,
      hasMapLocation: false,
      mapLocationLabel: "选择地图位置",
      locationActionText: "地图选点",
      optionPlaceholder: "一行一个选项",
      showLocationField: false,
    },
    checkinDraft: {
      title: "",
      type: CHECKIN_TYPES[0],
      total: "10",
      reward: "",
    },
  };
}

function billToDraft(bill, members) {
  const names = members.map((member) => member.name);
  const participants = (bill.participants || []).filter((name) => names.indexOf(name) !== -1);
  const safeParticipants = participants.length ? participants : names.slice(0, 4);
  const payerName = safeParticipants.indexOf(bill.payerName) !== -1 ? bill.payerName : safeParticipants[0] || "";
  const splitMode = SPLIT_MODES.indexOf(bill.splitMode) !== -1 ? bill.splitMode : SPLIT_MODES[0];
  return {
    title: bill.title || "",
    amount: bill.amount ? String(bill.amount) : "",
    payerName,
    splitMode,
    participants: safeParticipants,
    memberOptions: memberOptions(members, safeParticipants),
    expenseText: (bill.expenseItems || []).map((item) => `${item.name} ${item.amount}`).join("\n"),
    customAmountText: (bill.transfers || []).map((item) => `${item.from} ${item.amount}`).join("\n"),
    showCustomAmounts: splitMode === "自定义金额",
  };
}

function voteToDraft(vote) {
  const typeIndex = Math.max(0, VOTE_TYPES.indexOf(vote.type));
  const isLocationVote = vote.type === LOCATION_VOTE_TYPE;
  const hasMapLocation = !!(
    isLocationVote &&
    vote.latitude !== null &&
    typeof vote.latitude !== "undefined" &&
    vote.longitude !== null &&
    typeof vote.longitude !== "undefined"
  );
  return {
    title: vote.title || "",
    type: VOTE_TYPES[typeIndex] || VOTE_TYPES[0],
    typeIndex,
    visibility: vote.visibility === "匿名" ? "匿名" : "实名",
    choiceMode: vote.choiceMode === "多选" ? "多选" : "单选",
    allowVeto: !!vote.allowVeto,
    allowVetoClass: vote.allowVeto ? "active" : "",
    organizerWeighted: !!vote.organizerWeighted,
    organizerWeightedClass: vote.organizerWeighted ? "active" : "",
    deadline: vote.deadlineDisplay || String(vote.deadlineText || vote.deadline || "").replace(/\s*截止$/, ""),
    optionsText: (vote.options || []).map((option) => option.name).filter(Boolean).join("\n"),
    locationText: isLocationVote ? vote.locationText || vote.locationName || "" : "",
    locationName: isLocationVote ? vote.locationName || vote.locationText || "" : "",
    locationAddress: isLocationVote ? vote.locationAddress || "" : "",
    latitude: hasMapLocation ? vote.latitude : null,
    longitude: hasMapLocation ? vote.longitude : null,
    hasMapLocation,
    mapLocationLabel: hasMapLocation ? vote.locationName || vote.locationText || "已选地点" : "选择地图位置",
    locationActionText: hasMapLocation ? "重新选点" : "地图选点",
    optionPlaceholder: isLocationVote ? "每行一个地点候选，例如：万象城 / 球馆 / 家里" : "一行一个选项",
    showLocationField: isLocationVote,
  };
}

function checkinToDraft(checkin) {
  return {
    title: checkin.title || "",
    type: checkin.type || CHECKIN_TYPES[0],
    total: String(checkin.total || 10),
    reward: checkin.reward || "",
  };
}

Page({
  data: {
    loading: true,
    activeTool: "aa",
    toolTabs: decorateTabs("aa"),
    showAA: true,
    showVote: false,
    showCheckin: false,
    bills: [],
    votes: [],
    checkins: [],
    decisionMakers: [],
    members: [],
    memberNames: [],
    splitModes: SPLIT_MODES,
    voteTypes: VOTE_TYPES,
    voteVisibilities: VOTE_VISIBILITIES,
    voteChoiceModes: VOTE_CHOICE_MODES,
    checkinTypes: CHECKIN_TYPES,
    showCreateSheet: false,
    showCreateAA: true,
    showCreateVote: false,
    showCreateCheckin: false,
    createTitle: "创建工具",
    formKicker: "新建工具",
    createMode: "aa",
    editingBusinessId: "",
    showShareSheet: false,
    shareTargetBill: null,
    billDraft: emptyDrafts([]).billDraft,
    voteDraft: emptyDrafts([]).voteDraft,
    checkinDraft: emptyDrafts([]).checkinDraft,
    myCard: null,
    actionLoadingType: "",
    actionLoadingId: "",
    actionLoadingName: "",
    shareDecisionId: "",
  },

  onShow() {
    this.applyPendingToolIntent();
    this.loadTools();
  },

  applyPendingToolIntent() {
    const activeTool = toolIntent.consumeToolIntent();
    if (activeTool) this.setActiveTool(activeTool);
  },

  loadTools() {
    api.listTools().then((tools) => {
      const resolveMembers = tools.members ? Promise.resolve(tools) : api.listMembers();
      return resolveMembers.then((memberData) => {
        const members = memberData.members || [];
        const drafts = emptyDrafts(members);
        const keepDrafts = this.data.showCreateSheet;
        this.setData({
          bills: tools.bills || [],
          votes: (tools.votes || []).map((vote) =>
            this.decorateVote(enrichVoteWithVoters(vote, members), memberData.myCard || null)
          ),
          checkins: (tools.checkins || []).map(this.decorateCheckin),
          decisionMakers: (tools.decisionMakers || []).map(decorateDecision),
          members,
          memberNames: members.map((member) => member.name),
          myCard: memberData.myCard || null,
          billDraft: keepDrafts ? this.data.billDraft : drafts.billDraft,
          voteDraft: keepDrafts ? this.data.voteDraft : drafts.voteDraft,
          checkinDraft: keepDrafts ? this.data.checkinDraft : drafts.checkinDraft,
          loading: false,
        }, () => this.openPendingEdit());
      });
    });
  },

  openPendingEdit() {
    const intent = editIntent.consumeEditIntent(["bill", "vote", "checkin"]);
    if (!intent) return;
    const handlers = {
      bill: "editBill",
      vote: "editVote",
      checkin: "editCheckin",
    };
    const handler = handlers[intent.kind];
    if (handler && typeof this[handler] === "function") {
      this[handler]({ currentTarget: { dataset: { id: intent.id } } });
    }
  },

  decorateVote(vote, myCard) {
    const selectedNames = selectedVoteOptionNames(vote, myCard || this.data.myCard);
    const deadlineAtMs = voteDeadlineMs(vote);
    const deadlineDisplay =
      vote.deadlineDisplay ||
      time.displayDateTime(vote.deadlineAt || vote.deadlineTime || vote.deadline, deadlineAtMs, vote.id);
    const deadlineText = vote.deadlineText || (deadlineDisplay ? `${deadlineDisplay} 截止` : vote.deadline || "");
    const isClosed =
      !!vote.isClosed ||
      vote.status === "已截止" ||
      vote.status === "已出结果" ||
      !!(deadlineAtMs && deadlineAtMs <= Date.now());
    const decoratedOptions = (vote.options || []).map((option) =>
      Object.assign({}, option, {
        selected: selectedNames.indexOf(option.name) !== -1,
        selectedClass: selectedNames.indexOf(option.name) !== -1 ? "selected" : "",
        selectedText: vote.choiceMode === "多选" ? "再点取消" : "已选",
      })
    );
    const availableOptions = decoratedOptions.filter((option) => !option.vetoed);
    const topOption = availableOptions.slice().sort((a, b) => (b.weightedCount || b.count || 0) - (a.weightedCount || a.count || 0))[0];
    const winner = vote.winner || (topOption && topOption.name) || "";
    const resultSummary = vote.resultSummary || (isClosed ? buildVoteSummaryText(vote, decoratedOptions, winner, deadlineText) : "");
    return Object.assign({}, vote, {
      deadline: deadlineText,
      deadlineAtMs,
      deadlineText,
      deadlineDisplay,
      isClosed,
      canVote: !isClosed,
      statusText: isClosed ? "已截止" : vote.status || "投票中",
      statusClass: isClosed ? "pill-amber" : "pill-blue",
      resultSummary,
      hasResultSummary: !!(isClosed && resultSummary),
      myVoteOptionNames: selectedNames,
      hasMyVote: selectedNames.length > 0,
      options: decoratedOptions,
      silentText: vote.silent && vote.silent.length ? vote.silent.join("、") : "全员已投票",
      ruleChips: [
        `${vote.visibility || "实名"}${vote.choiceMode || "单选"}`,
        vote.organizerWeighted ? "组织者权重票" : "同票权重",
        vote.allowVeto ? "可一票否决" : "无否决",
      ],
    });
  },

  decorateCheckin(checkin) {
    return Object.assign({}, checkin, {
      percent: checkin.total ? Math.round((checkin.done / checkin.total) * 100) : 0,
      buttonText: checkin.checked ? "已打卡" : "去打卡",
      buttonClass: checkin.checked ? "disabled" : "",
      statusText: checkin.checked ? "已打卡" : "待打卡",
      statusClass: checkin.checked ? "is-complete" : "is-pending",
    });
  },

  startAction(type, id, name) {
    if (this.data.actionLoadingType) return false;
    this.setData({
      actionLoadingType: type,
      actionLoadingId: id || "",
      actionLoadingName: name || "",
    });
    return true;
  },

  finishAction() {
    this.setData({
      actionLoadingType: "",
      actionLoadingId: "",
      actionLoadingName: "",
    });
  },

  showActionError(error) {
    wx.showToast({
      title: (error && error.message) || "操作失败，请稍后重试",
      icon: "none",
    });
  },

  runAction(type, id, name, task) {
    if (!this.startAction(type, id, name)) return Promise.resolve();
    return Promise.resolve()
      .then(task)
      .catch((error) => {
        this.showActionError(error);
      })
      .then(() => {
        this.finishAction();
      });
  },

  switchTool(e) {
    this.setActiveTool(e.currentTarget.dataset.key);
  },

  setActiveTool(activeTool) {
    if (!TOOL_TABS.some((tab) => tab.key === activeTool)) return;
    this.setData({
      activeTool,
      toolTabs: decorateTabs(activeTool),
      showAA: activeTool === "aa",
      showVote: activeTool === "vote",
      showCheckin: activeTool === "checkin",
    });
  },

  remindBill(e) {
    const id = e.currentTarget.dataset.id;
    this.runAction("remindBill", id, "", () =>
      notice.requestSettlementReminder().then((noticeOptions) =>
        api.remindBill(id, noticeOptions).then((bill) => {
        const bills = this.data.bills.map((item) => (item.id === id ? bill : item));
        this.setData({ bills });
        wx.showToast({
          title: noticeOptions.accepted ? "已发送服务通知" : bill ? `已提醒 ${bill.debtors.length} 人结清` : "已提醒",
          icon: "none",
        });
        })
      )
    );
  },

  openBill(e) {
    wx.navigateTo({
      url: `/pages/bill-detail/index?id=${e.currentTarget.dataset.id}`,
    });
  },

  openVote(e) {
    wx.navigateTo({
      url: `/pages/vote-detail/index?id=${e.currentTarget.dataset.id}`,
    });
  },

  openCheckin(e) {
    wx.navigateTo({
      url: `/pages/checkin-detail/index?id=${e.currentTarget.dataset.id}`,
    });
  },

  markSettled(e) {
    const id = e.currentTarget.dataset.id;
    this.runAction("settleBill", id, "", () => api.settleBill(id).then((bills) => {
      this.setData({ bills });
      wx.showToast({
        title: "已标记结清",
        icon: "success",
      });
    }));
  },

  deleteBill(e) {
    const id = e.currentTarget.dataset.id;
    const bill = this.data.bills.find((item) => item.id === id) || {};
    if (!bill.canDelete) return;
    dialog.show({
      title: "删除 AA",
      content: `确认删除「${bill.title || "这个 AA 账单"}」吗？`,
      confirmText: "删除",
      confirmColor: "#B34A34",
      success: (res) => {
        if (!res.confirm) return;
        this.runAction("deleteBill", id, "", () => api.deleteBill(id).then((bills) => {
          this.setData({ bills });
          wx.showToast({ title: "AA 已删除", icon: "success" });
        }));
      },
    });
  },

  voteOption(e) {
    const { id, name } = e.currentTarget.dataset;
    const vote = this.data.votes.find((item) => item.id === id);
    if (!vote || vote.isClosed || vote.canVote === false) {
      wx.showToast({ title: "投票已截止", icon: "none" });
      return;
    }
    const wasSelected = hasSelectedOption(vote, this.data.myCard, name);
    if (wasSelected && !isMultiChoiceVote(vote)) {
      wx.showToast({ title: "已选择该项", icon: "none" });
      return;
    }
    this.runAction("voteOption", id, name, () => api.voteOption(id, name).then((votes) => {
      this.setData({
        votes: votes.map((item) => this.decorateVote(item, this.data.myCard)),
      });
      wx.showToast({
        title: wasSelected ? `已取消：${name}` : `已投：${name}`,
        icon: "none",
      });
    }));
  },

  deleteVote(e) {
    const id = e.currentTarget.dataset.id;
    const vote = this.data.votes.find((item) => item.id === id) || {};
    if (!vote.canDelete) return;
    dialog.show({
      title: "删除投票",
      content: `确认删除「${vote.title || "这个投票"}」吗？`,
      confirmText: "删除",
      confirmColor: "#B34A34",
      success: (res) => {
        if (!res.confirm) return;
        this.runAction("deleteVote", id, "", () => api.deleteVote(id).then((votes) => {
          this.setData({
            votes: votes.map((item) => this.decorateVote(item, this.data.myCard)),
          });
          wx.showToast({ title: "投票已删除", icon: "success" });
        }));
      },
    });
  },

  checkIn(e) {
    const id = e.currentTarget.dataset.id;
    const target = this.data.checkins.find((item) => item.id === id);
    if (target && target.checked) return;
    this.runAction("checkIn", id, "", () => api.checkIn(id).then((checkins) => {
      this.setData({
        checkins: checkins.map(this.decorateCheckin),
      });
      wx.showToast({
        title: "已打卡",
        icon: "success",
      });
    }));
  },

  deleteCheckin(e) {
    const id = e.currentTarget.dataset.id;
    const checkin = this.data.checkins.find((item) => item.id === id) || {};
    if (!checkin.canDelete) return;
    dialog.show({
      title: "删除打卡挑战",
      content: `确认删除「${checkin.title || "这个打卡挑战"}」吗？`,
      confirmText: "删除",
      confirmColor: "#B34A34",
      success: (res) => {
        if (!res.confirm) return;
        this.runAction("deleteCheckin", id, "", () => api.deleteCheckin(id).then((checkins) => {
          this.setData({
            checkins: checkins.map(this.decorateCheckin),
          });
          wx.showToast({ title: "打卡已删除", icon: "success" });
        }));
      },
    });
  },

  createCurrentTool() {
    const titles = {
      aa: "创建 AA 账单",
      vote: "创建投票",
      checkin: "创建打卡挑战",
    };
    const drafts = emptyDrafts(this.data.members);
    this.setData({
      showCreateSheet: true,
      createMode: this.data.activeTool,
      createTitle: titles[this.data.activeTool],
      formKicker: "新建工具",
      editingBusinessId: "",
      showCreateAA: this.data.activeTool === "aa",
      showCreateVote: this.data.activeTool === "vote",
      showCreateCheckin: this.data.activeTool === "checkin",
      billDraft: drafts.billDraft,
      voteDraft: drafts.voteDraft,
      checkinDraft: drafts.checkinDraft,
    });
  },

  editBill(e) {
    const id = e.currentTarget.dataset.id;
    const bill = this.data.bills.find((item) => item.id === id);
    if (!bill || this.data.actionLoadingType) return;
    if (!bill.canEdit) {
      wx.showToast({ title: bill.editDisabledReason || "当前 AA 不能编辑", icon: "none" });
      return;
    }
    this.setData({
      activeTool: "aa",
      toolTabs: decorateTabs("aa"),
      showAA: true,
      showVote: false,
      showCheckin: false,
      showCreateSheet: true,
      showCreateAA: true,
      showCreateVote: false,
      showCreateCheckin: false,
      createMode: "aa",
      createTitle: "编辑 AA 账单",
      formKicker: "编辑工具",
      editingBusinessId: id,
      billDraft: billToDraft(bill, this.data.members),
    });
  },

  editVote(e) {
    const id = e.currentTarget.dataset.id;
    const vote = this.data.votes.find((item) => item.id === id);
    if (!vote || this.data.actionLoadingType) return;
    if (!vote.canEdit) {
      wx.showToast({ title: vote.editDisabledReason || "当前投票不能编辑", icon: "none" });
      return;
    }
    this.setData({
      activeTool: "vote",
      toolTabs: decorateTabs("vote"),
      showAA: false,
      showVote: true,
      showCheckin: false,
      showCreateSheet: true,
      showCreateAA: false,
      showCreateVote: true,
      showCreateCheckin: false,
      createMode: "vote",
      createTitle: "编辑投票",
      formKicker: "编辑工具",
      editingBusinessId: id,
      voteDraft: voteToDraft(vote),
    });
  },

  editCheckin(e) {
    const id = e.currentTarget.dataset.id;
    const checkin = this.data.checkins.find((item) => item.id === id);
    if (!checkin || this.data.actionLoadingType) return;
    if (!checkin.canEdit) {
      wx.showToast({ title: checkin.editDisabledReason || "当前挑战不能编辑", icon: "none" });
      return;
    }
    this.setData({
      activeTool: "checkin",
      toolTabs: decorateTabs("checkin"),
      showAA: false,
      showVote: false,
      showCheckin: true,
      showCreateSheet: true,
      showCreateAA: false,
      showCreateVote: false,
      showCreateCheckin: true,
      createMode: "checkin",
      createTitle: "编辑打卡挑战",
      formKicker: "编辑工具",
      editingBusinessId: id,
      checkinDraft: checkinToDraft(checkin),
    });
  },

  closeCreateSheet() {
    this.setData({
      showCreateSheet: false,
      editingBusinessId: "",
    });
  },

  closeShareSheet() {
    this.setData({
      showShareSheet: false,
      shareTargetBill: null,
    });
  },

  noop() {},

  onBillInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({
      [`billDraft.${field}`]: e.detail.value,
    });
  },

  onVoteInput(e) {
    const field = e.currentTarget.dataset.field;
    if (field === "locationText") {
      this.setData({
        "voteDraft.locationText": e.detail.value,
        "voteDraft.locationName": e.detail.value,
      });
      return;
    }
    this.setData({
      [`voteDraft.${field}`]: e.detail.value,
    });
  },

  onCheckinInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({
      [`checkinDraft.${field}`]: e.detail.value,
    });
  },

  onPayerChange(e) {
    this.setData({
      "billDraft.payerName": this.data.memberNames[Number(e.detail.value)],
    });
  },

  onSplitModeChange(e) {
    const splitMode = SPLIT_MODES[Number(e.detail.value)];
    this.setData({
      "billDraft.splitMode": splitMode,
      "billDraft.showCustomAmounts": splitMode === "自定义金额",
    });
  },

  onVoteTypeChange(e) {
    const nextIndex = Number(e.detail.value);
    const typeIndex = Number.isFinite(nextIndex) ? nextIndex : 0;
    const type = VOTE_TYPES[typeIndex] || VOTE_TYPES[0];
    const isLocationVote = type === LOCATION_VOTE_TYPE;
    const nextData = {
      "voteDraft.type": type,
      "voteDraft.typeIndex": typeIndex,
      "voteDraft.showLocationField": isLocationVote,
      "voteDraft.optionPlaceholder": isLocationVote ? "每行一个地点候选，例如：万象城 / 球馆 / 家里" : "一行一个选项",
    };
    if (isLocationVote && this.data.voteDraft.optionsText === DEFAULT_VOTE_OPTIONS_TEXT) {
      nextData["voteDraft.optionsText"] = LOCATION_VOTE_OPTIONS_TEXT;
    }
    if (!isLocationVote && this.data.voteDraft.optionsText === LOCATION_VOTE_OPTIONS_TEXT) {
      nextData["voteDraft.optionsText"] = DEFAULT_VOTE_OPTIONS_TEXT;
    }
    this.setData(nextData);
  },

  chooseVoteLocation() {
    if (!wx.chooseLocation) {
      wx.showToast({ title: "当前基础库暂不支持地图选点", icon: "none" });
      return;
    }
    wx.chooseLocation({
      success: (location) => {
        const name = location.name || location.address || "已选地点";
        this.setData({
          "voteDraft.type": LOCATION_VOTE_TYPE,
          "voteDraft.typeIndex": LOCATION_VOTE_TYPE_INDEX,
          "voteDraft.showLocationField": true,
          "voteDraft.locationName": name,
          "voteDraft.locationAddress": location.address || "",
          "voteDraft.locationText": name,
          "voteDraft.latitude": location.latitude,
          "voteDraft.longitude": location.longitude,
          "voteDraft.hasMapLocation": true,
          "voteDraft.mapLocationLabel": name,
          "voteDraft.locationActionText": "重新选点",
          "voteDraft.optionPlaceholder": "每行一个地点候选，例如：万象城 / 球馆 / 家里",
        });
      },
      fail: (error) => {
        const privacyReason = privateApi.classifyPrivacyFailure(error);
        if (privacyReason) {
          if (privacyReason === "privacy-config-error") {
            privateApi.logPrivateApiFailure("wx.chooseLocation", error);
          }
          wx.showToast({
            title: privateApi.privateApiFailureMessage(error, "暂时无法选择地图位置"),
            icon: "none",
          });
          return;
        }
        if (error && error.errMsg && error.errMsg.indexOf("cancel") !== -1) return;
        wx.showToast({ title: "暂时无法选择地图位置", icon: "none" });
      },
    });
  },

  onVoteVisibilityChange(e) {
    this.setData({
      "voteDraft.visibility": VOTE_VISIBILITIES[Number(e.detail.value)],
    });
  },

  onVoteChoiceModeChange(e) {
    this.setData({
      "voteDraft.choiceMode": VOTE_CHOICE_MODES[Number(e.detail.value)],
    });
  },

  toggleVoteRule(e) {
    const field = e.currentTarget.dataset.field;
    const nextValue = !this.data.voteDraft[field];
    this.setData({
      [`voteDraft.${field}`]: nextValue,
      [`voteDraft.${field}Class`]: nextValue ? "active" : "",
    });
  },

  onCheckinTypeChange(e) {
    this.setData({
      "checkinDraft.type": CHECKIN_TYPES[Number(e.detail.value)],
    });
  },

  toggleParticipant(e) {
    const name = e.currentTarget.dataset.name;
    const participants = this.data.billDraft.participants.slice();
    const index = participants.indexOf(name);
    if (index === -1) {
      participants.push(name);
    } else if (participants.length > 1) {
      participants.splice(index, 1);
    }
    this.setData({
      "billDraft.participants": participants,
      "billDraft.memberOptions": memberOptions(this.data.members, participants),
    });
  },

  submitCreateTool(e) {
    if (this.data.createMode === "aa") {
      this.submitBill(e);
      return;
    }
    if (this.data.createMode === "vote") {
      this.submitVote();
      return;
    }
    this.submitCheckin();
  },

  submitBill(e) {
    const draft = this.data.billDraft;
    const shareAfterSave = !!(e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.shareAfter);
    const expenseItems = parseExpenseItems(draft.expenseText);
    const expenseTotal = toMoney(expenseItems.reduce((sum, item) => sum + item.amount, 0));
    const customAmounts = parseCustomAmounts(draft.customAmountText, draft.participants, draft.payerName);
    const customTotal = toMoney(customAmounts.reduce((sum, item) => sum + item.amount, 0));
    const amount = draft.splitMode === "自定义金额" ? expenseTotal || toMoney(draft.amount) || customTotal : expenseTotal || toMoney(draft.amount);
    if (!draft.title || !amount || !draft.payerName || !draft.participants.length) {
      wx.showToast({ title: "补全账单信息", icon: "none" });
      return;
    }
    if (draft.splitMode === "自定义金额" && !customAmounts.length) {
      wx.showToast({ title: "填写自定义金额明细", icon: "none" });
      return;
    }

    let debtors = draft.participants.filter((name) => name !== draft.payerName);
    let perPerson = toMoney(amount / draft.participants.length);
    let status = "结算中";
    if (draft.splitMode === "发起人免单") {
      debtors = draft.participants.filter((name) => name !== draft.payerName);
      perPerson = debtors.length ? toMoney(amount / debtors.length) : amount;
    }
    if (draft.splitMode === "老板请客") {
      debtors = [];
      perPerson = 0;
      status = "已结清";
    }
    if (draft.splitMode === "自定义金额") {
      debtors = customAmounts.map((item) => item.name);
      perPerson = debtors.length ? toMoney(customTotal / debtors.length) : 0;
    }

    const transfers =
      draft.splitMode === "自定义金额"
        ? customAmounts.map((item) => ({ from: item.name, to: draft.payerName, amount: item.amount }))
        : debtors.map((name) => ({ from: name, to: draft.payerName, amount: perPerson }));
    const bill = {
      id: `local-bill-${Date.now()}`,
      title: draft.title,
      amount,
      payerName: draft.payerName,
      perPerson,
      unsettledCount: debtors.length,
      status,
      splitMode: draft.splitMode,
      participants: draft.participants,
      expenseItems: expenseItems.length ? expenseItems : [{ name: draft.title, amount }],
      debtors,
      transfers,
      punchline: debtors.length
        ? draft.splitMode === "自定义金额"
          ? `自定义金额已算好：${transfers[0].from} 转 ${transfers[0].amount} 元。`
          : `${debtors[0]} 欠 ${perPerson} 元，已进入记仇本。`
        : `${draft.payerName} 老板请客，本局全员轻装上阵。`,
    };

    const editingId = this.data.editingBusinessId;
    this.runAction("saveTool", this.data.createMode, "", () => {
      const saveTask = editingId ? api.updateBill(editingId, bill) : api.createBill(bill);
      return saveTask.then((bills) => {
        const saved = editingId ? bills.find((item) => item.id === editingId) : bills[0];
        const drafts = emptyDrafts(this.data.members);
        this.setData({
          bills,
          billDraft: drafts.billDraft,
          showCreateSheet: false,
          editingBusinessId: "",
          showShareSheet: !!(shareAfterSave && saved),
          shareTargetBill: shareAfterSave && saved ? saved : null,
        });
        wx.showToast({ title: editingId ? "AA 已更新" : "账单已创建", icon: "success" });
      });
    });
  },

  submitVote() {
    const draft = this.data.voteDraft;
    const isLocationVote =
      draft.showLocationField &&
      (draft.typeIndex === LOCATION_VOTE_TYPE_INDEX || draft.type === LOCATION_VOTE_TYPE || draft.hasMapLocation);
    const voteType = isLocationVote ? LOCATION_VOTE_TYPE : draft.type;
    const options = draft.optionsText
      .split(/[\n,，、/]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (!draft.title || options.length < 2) {
      wx.showToast({ title: "至少填写标题和两个选项", icon: "none" });
      return;
    }
    const deadline = normalizeVoteDeadlineForSubmit(draft.deadline);
    if (!deadline) {
      wx.showToast({ title: "截止时间格式不对", icon: "none" });
      return;
    }
    if (deadline.deadlineAtMs <= Date.now()) {
      wx.showToast({ title: "截止时间不能早于现在", icon: "none" });
      return;
    }

    const vote = this.decorateVote({
      id: `local-vote-${Date.now()}`,
      title: draft.title,
      deadline: deadline.deadlineText,
      deadlineAt: deadline.deadlineAt,
      deadlineAtMs: deadline.deadlineAtMs,
      deadlineDisplay: deadline.deadlineDisplay,
      deadlineText: deadline.deadlineText,
      type: voteType,
      visibility: draft.visibility,
      choiceMode: draft.choiceMode,
      allowVeto: draft.allowVeto,
      organizerWeighted: draft.organizerWeighted,
      weightValue: 2,
      locationText: isLocationVote ? draft.locationText : "",
      locationName: isLocationVote ? draft.locationName : "",
      locationAddress: isLocationVote ? draft.locationAddress : "",
      latitude: isLocationVote ? draft.latitude : null,
      longitude: isLocationVote ? draft.longitude : null,
      rule: [
        `${draft.visibility}${draft.choiceMode}`,
        draft.organizerWeighted ? "组织者权重票" : "同票权重",
        draft.allowVeto ? "可一票否决" : "无否决",
        voteType === "时间投票" ? "最多人可来自动胜出" : "结果可回群公布",
      ].join(" · "),
      options: options.map((name) => ({ name, count: 0, percent: 0 })),
      records: [],
      vetoRecords: [],
      silent: this.data.memberNames.slice(1),
    });
    const editingId = this.data.editingBusinessId;
    this.runAction("saveTool", this.data.createMode, "", () => {
      const saveTask = editingId ? api.updateVote(editingId, vote) : api.createVote(vote);
      return saveTask.then((votes) => {
        const drafts = emptyDrafts(this.data.members);
        this.setData({
          votes: votes.map((item) => this.decorateVote(item, this.data.myCard)),
          voteDraft: drafts.voteDraft,
          showCreateSheet: false,
          editingBusinessId: "",
        });
        wx.showToast({ title: editingId ? "投票已更新" : "投票已创建", icon: "success" });
      });
    });
  },

  submitCheckin() {
    const draft = this.data.checkinDraft;
    const total = Number(draft.total || 0);
    if (!draft.title || !total) {
      wx.showToast({ title: "补全挑战标题和人数", icon: "none" });
      return;
    }

    const checkin = this.decorateCheckin({
      id: `local-checkin-${Date.now()}`,
      title: draft.title,
      done: 0,
      total,
      type: draft.type,
      reward: draft.reward || "每周总结自动生成，断签可用补签卡",
      checked: false,
    });
    const editingId = this.data.editingBusinessId;
    this.runAction("saveTool", this.data.createMode, "", () => {
      const saveTask = editingId ? api.updateCheckin(editingId, checkin) : api.createCheckin(checkin);
      return saveTask.then((checkins) => {
        const drafts = emptyDrafts(this.data.members);
        this.setData({
          checkins: checkins.map(this.decorateCheckin),
          checkinDraft: drafts.checkinDraft,
          showCreateSheet: false,
          editingBusinessId: "",
        });
        wx.showToast({ title: editingId ? "挑战已更新" : "挑战已创建", icon: "success" });
      });
    });
  },

  runDecision(e) {
    const id = e.currentTarget.dataset.id;
    this.runAction("runDecision", id, "", () => api.runDecision(id).then((decisionMakers) => {
      const nextDecisionMakers = decisionMakers.map(decorateDecision);
      this.setData({ decisionMakers: nextDecisionMakers, shareDecisionId: id });
      const target = nextDecisionMakers.find((item) => item.id === id);
      wx.showToast({
        title: target ? `结果：${target.result}` : "已生成结果",
        icon: "none",
      });
    }));
  },

  prepareDecisionShare(e) {
    const target = this.data.decisionMakers.find((item) => item.id === e.currentTarget.dataset.id);
    if (!target || !target.hasResult) return;
    this.setData({ shareDecisionId: target.id });
  },

  onShareAppMessage(options) {
    const dataset = options && options.target && options.target.dataset ? options.target.dataset : {};
    if (dataset.shareType === "bill") {
      const target = this.data.bills.find((item) => item.id === dataset.id) || this.data.shareTargetBill;
      if (target) {
        setTimeout(() => this.closeShareSheet(), 0);
        return {
          title: `${target.title}：¥${target.amount}，查看 AA 结算详情`,
          path: `/pages/bill-detail/index?id=${target.id}&circleId=${target.circleId || ""}`,
        };
      }
    }
    if (dataset.shareType === "decision") {
      const target = this.data.decisionMakers.find((item) => item.id === dataset.id) ||
        this.data.decisionMakers.find((item) => item.id === this.data.shareDecisionId);
      if (target && target.hasResult) {
        return {
          title: target.shareTitle,
          path: `/pages/tools/index?tool=vote&decisionId=${target.id}`,
        };
      }
    }
    return {
      title: "圈内工具箱：AA、投票和打卡都在这里",
      path: "/pages/tools/index",
    };
  },
});
