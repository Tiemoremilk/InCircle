const api = require("../../utils/api");
const time = require("../../utils/time");
const editIntent = require("../../utils/editIntent");
const dialog = require("../../utils/dialog");

function buildVoteShareText(vote) {
  if (vote.resultSummary) return vote.resultSummary;
  const options = (vote.options || [])
    .map((option) => `${option.name} ${option.count || 0}票`)
    .join("；");
  return `【${vote.title}】\n结果：${vote.winner || "待出结果"}\n${options}\n${vote.resultText || ""}`;
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

function optionNamesFromSelectedOptions(vote) {
  return (vote && vote.options ? vote.options : [])
    .filter((option) => option && option.selected)
    .map((option) => option.name);
}

function selectedVoteOptionNames(vote) {
  if (!vote) return [];
  if (Array.isArray(vote.myVoteOptionNames)) return vote.myVoteOptionNames;
  return optionNamesFromSelectedOptions(vote);
}

function hasSelectedOption(vote, name) {
  return selectedVoteOptionNames(vote).indexOf(name) !== -1;
}

function isMultiChoiceVote(vote) {
  return vote && vote.choiceMode === "多选";
}

function voteDeadlineMs(vote) {
  return time.toTimestamp(vote && (vote.deadlineAt || vote.deadlineTime || vote.deadline), vote && vote.deadlineAtMs, vote && vote.id);
}

function decorateVote(vote) {
  const selectedNames = selectedVoteOptionNames(vote);
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
  const options = (vote.options || []).map((option, index) =>
    Object.assign({}, option, {
      rank: index + 1,
      barClass: index === 0 ? "primary" : index === 1 ? "amber" : "blue",
      vetoClass: option.vetoed ? "vetoed" : "",
      vetoText: option.vetoed ? "已否决" : "一票否决",
      selected: selectedNames.indexOf(option.name) !== -1,
      selectedClass: selectedNames.indexOf(option.name) !== -1 ? "selected" : "",
      selectedText: vote.choiceMode === "多选" ? "再点取消" : "已选",
    })
  );
  const availableOptions = options.filter((option) => !option.vetoed);
  const topOption = availableOptions.slice().sort((a, b) => b.count - a.count)[0];
  const winner = vote.winner || (topOption && topOption.name) || "待出结果";
  const resultSummary = vote.resultSummary || (isClosed ? buildVoteSummaryText(vote, options, winner, deadlineText) : "");
  const ruleChips = [
    `${vote.visibility || "实名"}${vote.choiceMode || "单选"}`,
    vote.organizerWeighted ? "组织者权重票" : "同票权重",
    vote.allowVeto ? "可一票否决" : "无否决",
  ];
  const hasCoordinates = typeof vote.latitude === "number" && typeof vote.longitude === "number";
  const hasLocation = !!(vote.locationText || vote.locationName || vote.locationAddress);
  return Object.assign({}, vote, {
    deadline: deadlineText,
    deadlineAtMs,
    deadlineText,
    deadlineDisplay,
    isClosed,
    canVote: !isClosed,
    options,
    myVoteOptionNames: selectedNames,
    hasMyVote: selectedNames.length > 0,
    winner,
    resultText: vote.resultText || `${winner} 暂时领先，截止后会生成摘要分析。`,
    resultSummary,
    hasResultSummary: !!(isClosed && resultSummary),
    resultTitle: isClosed ? "摘要详情分析" : "实时趋势",
    silentText: vote.silent && vote.silent.length ? vote.silent.join("、") : "全员已投票",
    statusText: isClosed ? "已截止" : vote.status || "投票中",
    statusClass: isClosed ? "pill-amber" : "pill-blue",
    ruleChips,
    hasVetoRule: !!vote.allowVeto,
    voterModeText: `${vote.visibility || "实名"} · ${vote.choiceMode || "单选"}`,
    weightText: vote.organizerWeighted ? `组织者投票按 ${vote.weightValue || 2} 票计` : "每人按 1 票计",
    hasLocation,
    hasCoordinates,
    locationTitle: vote.locationName || vote.locationText || "地点信息",
    locationCopy: vote.locationAddress || vote.locationText || "发起人只填写了文字地点，可复制后回群确认。",
    locationActionText: hasCoordinates ? "打开地图" : "复制地点",
    vetoText:
      vote.allowVeto && vote.vetoRecords && vote.vetoRecords.length
        ? `已否决：${vote.vetoRecords.map((record) => record.optionName).join("、")}`
        : vote.allowVeto
        ? "发起人可对明显不可行选项使用一票否决。"
        : "本投票未开启否决。",
    features: [
      { title: isClosed ? "摘要已生成" : "截止自动出结果", copy: isClosed ? "结果页优先展示摘要分析，分享也会落到这份详情。" : "最多票且未被否决的选项自动胜出。" },
      { title: "组织者权重票", copy: vote.organizerWeighted ? `组织者按 ${vote.weightValue || 2} 票计。` : "本投票所有成员同票权重。" },
      { title: "一票否决", copy: vote.allowVeto ? "可排除时间冲突或忌口选项。" : "本投票不使用否决。" },
    ],
    shareText: buildVoteShareText(Object.assign({}, vote, { options, winner, resultSummary })),
    shareTitle: isClosed ? `【投票摘要】${vote.title}：${winner}` : `来投票：${vote.title}`,
  });
}

Page({
  data: {
    ready: false,
    vote: null,
    actionLoadingType: "",
    actionLoadingName: "",
    shareMode: "",
  },

  onLoad(options) {
    this.voteId = options.id;
    this.loadVote();
  },

  loadVote() {
    api.getVote(this.voteId).then((vote) => {
      const needsVoterFallback =
        vote && vote.visibility !== "匿名" && (vote.records || []).length && !(vote.options || []).some((option) => option.hasVoters);
      const resolveVote = needsVoterFallback
        ? api.listMembers().then((data) =>
            Object.assign(enrichVoteWithVoters(vote, data.members || []), {
              myVoteOptionNames: selectedVoteOptionNames(vote),
            })
          )
        : Promise.resolve(vote);
      return resolveVote.then((nextVote) => {
        this.setData({
          vote: decorateVote(nextVote),
          ready: true,
        });
      });
    });
  },

  editVote() {
    const vote = this.data.vote || {};
    if (!vote.canEdit) {
      wx.showToast({ title: vote.editDisabledReason || "当前投票不能编辑", icon: "none" });
      return;
    }
    editIntent.setEditIntent("vote", vote.id || this.voteId);
    api.clearCache(["incircleTools"]);
    wx.switchTab({ url: "/pages/tools/index" });
  },

  startAction(type, name) {
    if (this.data.actionLoadingType) return false;
    this.setData({
      actionLoadingType: type,
      actionLoadingName: name || "",
    });
    return true;
  },

  finishAction() {
    this.setData({
      actionLoadingType: "",
      actionLoadingName: "",
    });
  },

  showActionError(error) {
    wx.showToast({
      title: (error && error.message) || "操作失败，请稍后重试",
      icon: "none",
    });
  },

  runAction(type, name, task) {
    if (!this.startAction(type, name)) return Promise.resolve();
    return Promise.resolve()
      .then(task)
      .catch((error) => {
        this.showActionError(error);
      })
      .then(() => {
        this.finishAction();
      });
  },

  voteOption(e) {
    const name = e.currentTarget.dataset.name;
    if (!this.data.vote || this.data.vote.isClosed || this.data.vote.canVote === false) {
      wx.showToast({ title: "投票已截止", icon: "none" });
      return;
    }
    const wasSelected = hasSelectedOption(this.data.vote, name);
    if (wasSelected && !isMultiChoiceVote(this.data.vote)) {
      wx.showToast({ title: "已选择该项", icon: "none" });
      return;
    }
    this.runAction("voteOption", name, () => api.voteOption(this.data.vote.id, name).then((votes) => {
      const vote = votes.find((item) => item.id === this.data.vote.id) || votes[0];
      this.setData({ vote: decorateVote(vote) });
      wx.showToast({ title: wasSelected ? `已取消：${name}` : `已投：${name}`, icon: "none" });
    }));
  },

  vetoOption(e) {
    const name = e.currentTarget.dataset.name;
    if (!this.data.vote || this.data.vote.isClosed || this.data.vote.canVote === false) {
      wx.showToast({ title: "投票已截止", icon: "none" });
      return;
    }
    this.runAction("vetoOption", name, () => api.vetoVoteOption(this.data.vote.id, name).then((votes) => {
      const vote = votes.find((item) => item.id === this.data.vote.id) || votes[0];
      this.setData({ vote: decorateVote(vote) });
      wx.showToast({ title: `已否决：${name}`, icon: "none" });
    }));
  },

  finishVote() {
    if (!this.data.vote || this.data.vote.isClosed) {
      wx.showToast({ title: "摘要已生成", icon: "none" });
      return;
    }
    this.runAction("finishVote", "", () => api.finishVote(this.data.vote.id).then((vote) => {
      this.setData({ vote: decorateVote(vote) });
      wx.showToast({ title: "已提前截止", icon: "success" });
    }));
  },

  copyResult() {
    wx.setClipboardData({
      data: this.data.vote.shareText || `【${this.data.vote.title}】${this.data.vote.resultText}`,
      success: () => {
        wx.showToast({ title: "结果文案已复制", icon: "success" });
      },
    });
  },

  prepareVoteShare() {
    this.setData({ shareMode: "vote-result" });
  },

  deleteVote() {
    const vote = this.data.vote || {};
    if (!vote.canDelete || this.data.actionLoadingType) return;
    dialog.show({
      title: "删除投票",
      content: `确认删除「${vote.title || "这个投票"}」吗？投票记录和结果会一起删除。`,
      confirmText: "删除",
      confirmColor: "#B34A34",
      success: (res) => {
        if (!res.confirm) return;
        this.runAction("deleteVote", "", () =>
          api.deleteVote(vote.id || this.voteId).then(() => {
            wx.showToast({ title: "投票已删除", icon: "success" });
            wx.navigateBack({
              fail: () => wx.switchTab({ url: "/pages/tools/index" }),
            });
          })
        );
      },
    });
  },

  openVoteLocation() {
    const vote = this.data.vote;
    if (!vote || !vote.hasLocation) return;
    if (vote.hasCoordinates && wx.openLocation) {
      wx.openLocation({
        latitude: vote.latitude,
        longitude: vote.longitude,
        name: vote.locationTitle,
        address: vote.locationCopy,
        scale: 16,
      });
      return;
    }
    wx.setClipboardData({
      data: vote.locationCopy || vote.locationTitle,
      success: () => {
        wx.showToast({ title: "地点已复制", icon: "success" });
      },
    });
  },

  onShareAppMessage(options) {
    const vote = this.data.vote || {};
    const dataset = options && options.target && options.target.dataset ? options.target.dataset : {};
    if (dataset.shareType === "vote-result" || this.data.shareMode === "vote-result") {
      return {
        title: vote.shareTitle || (vote.title ? `投票结果：${vote.title}` : "InCircle 投票结果"),
        path: `/pages/vote-detail/index?id=${vote.id || this.voteId}`,
      };
    }
    return {
      title: vote.title ? `来投票：${vote.title}` : "InCircle 投票",
      path: `/pages/vote-detail/index?id=${vote.id || this.voteId}`,
    };
  },
});
