const api = require("../../utils/api");
const media = require("../../utils/media");
const time = require("../../utils/time");
const editIntent = require("../../utils/editIntent");
const dialog = require("../../utils/dialog");

const RECORD_TYPES = ["文字", "图片", "数字"];

function stableText(value) {
  const text = String(value || "").trim();
  return text && !/\b(?:undefined|null)\b/i.test(text) ? text : "";
}

function recordImageSource(record) {
  const direct = stableText(record && (record.src || record.url));
  if (direct) return direct;
  const first = record && Array.isArray(record.media) ? record.media[0] : null;
  return stableText(typeof first === "string" ? first : first && (first.src || first.url));
}

function decorateCheckin(checkin) {
  const source = checkin || {};
  const done = Math.max(0, Number(source.done || 0));
  const total = Math.max(1, Number(source.total || 1));
  const percent = Math.min(100, Math.max(0, Math.round((done / total) * 100)));
  const rankings = source.rankings || {};
  const rankSections = [
    { title: "卷王榜", action: "记录最多", items: rankings.rollKing || [] },
    { title: "摸鱼榜", action: "未打卡", items: rankings.fishRank || [] },
    { title: "断签榜", action: "娱乐提醒", items: rankings.breakRank || [] },
    { title: "连续打卡王", action: "坚持天数", items: rankings.streakKing || [] },
    { title: "最早打卡", action: "抢第一", items: rankings.earliest || [] },
    { title: "失败惩罚抽签", action: "娱乐模式", items: rankings.punishment || [] },
  ].map((section) =>
    Object.assign({}, section, {
      hasItems: section.items && section.items.length > 0,
    })
  );
  const records = (source.records || []).map((record) => {
    const src = recordImageSource(record);
    const isImage = record.type === "图片" || !!src;
    const note = stableText(record.note);
    const createdAt = time.displayDateTime(record.createdAt, record.createdAtMs, record.id) || "时间未记录";
    return Object.assign({}, record, {
      src,
      isImage,
      hasImage: !!src,
      canRepairImage: isImage && !src && !!record.isMine,
      createdAt,
      noteLine: note ? `${note} · ${createdAt}` : createdAt,
    });
  });
  const weeklySummary =
    stableText(source.weeklySummary) ||
    (records.length ? `本周已有 ${records.length} 条打卡记录。` : "本周还没有打卡记录。");
  return Object.assign({}, source, {
    percent,
    done,
    total,
    buttonText: source.checked ? "已打卡" : "去打卡",
    statusText: source.checked ? "已打卡" : "待打卡",
    statusClass: source.checked ? "is-complete" : "is-pending",
    weeklySummary,
    leaveCardsUsed: source.leaveCardsUsed || 0,
    makeupCardsUsed: source.makeupCardsUsed || 0,
    records,
    hasRecords: records.length > 0,
    rankSections,
    punishmentText:
      source.punishmentResult && source.punishmentResult.memberName
        ? `${source.punishmentResult.memberName}：${source.punishmentResult.task}`
        : "还没抽，先看看谁还没打卡。",
  });
}

Page({
  data: {
    ready: false,
    checkin: null,
    actionLoadingType: "",
    repairLoadingId: "",
    recordTypes: RECORD_TYPES,
    recordDraft: {
      type: "文字",
      value: "",
      note: "",
      src: "",
      fileId: "",
      path: "",
      source: "",
      isImage: false,
      hasImage: false,
      imageLabel: "选择图片",
    },
  },

  onLoad(options) {
    this.checkinId = options.id;
    this.loadCheckin();
  },

  loadCheckin() {
    api.getCheckin(this.checkinId).then((checkin) => {
      this.setData({
        checkin: decorateCheckin(checkin),
        ready: true,
      });
    });
  },

  editCheckin() {
    const checkin = this.data.checkin || {};
    if (!checkin.canEdit) {
      wx.showToast({ title: checkin.editDisabledReason || "当前挑战不能编辑", icon: "none" });
      return;
    }
    editIntent.setEditIntent("checkin", checkin.id || this.checkinId);
    api.clearCache(["incircleTools"]);
    wx.switchTab({ url: "/pages/tools/index" });
  },

  resetRecordDraft() {
    this.setData({
      recordDraft: this.buildRecordDraft({
        type: "文字",
        value: "",
        note: "",
        src: "",
        fileId: "",
        path: "",
        source: "",
      }),
    });
  },

  startAction(type) {
    if (this.data.actionLoadingType) return false;
    this.setData({ actionLoadingType: type });
    return true;
  },

  finishAction() {
    this.setData({ actionLoadingType: "" });
  },

  showActionError(error) {
    wx.showToast({
      title: (error && error.message) || "操作失败，请稍后重试",
      icon: "none",
    });
  },

  runAction(type, task) {
    if (!this.startAction(type)) return Promise.resolve();
    return Promise.resolve()
      .then(task)
      .catch((error) => {
        this.showActionError(error);
      })
      .then(() => {
        this.finishAction();
      });
  },

  buildRecordDraft(patch) {
    const draft = Object.assign({}, this.data.recordDraft || {}, patch || {});
    draft.isImage = draft.type === "图片";
    draft.hasImage = !!draft.src;
    draft.imageLabel = draft.hasImage ? "已选择图片" : "选择图片";
    return draft;
  },

  submitRecord(record) {
    if (this.data.checkin && this.data.checkin.checked) return Promise.resolve();
    return this.runAction("checkIn", () => api.checkIn(this.data.checkin.id, record).then((checkins) => {
      const checkin = checkins.find((item) => item.id === this.data.checkin.id) || checkins[0];
      this.setData({
        checkin: decorateCheckin(checkin),
      });
      this.resetRecordDraft();
      wx.showToast({ title: "已打卡", icon: "success" });
    }));
  },

  checkIn() {
    if (this.data.checkin && this.data.checkin.checked) return;
    const draft = this.data.recordDraft;
    if (draft.isImage && !draft.src) {
      wx.showToast({ title: "先选择一张图片", icon: "none" });
      return;
    }
    this.submitRecord({
      type: draft.type,
      value: draft.value || (draft.isImage ? "图片打卡" : "已完成"),
      note: draft.note || "来自打卡详情",
      src: draft.src,
      fileId: draft.fileId,
      source: draft.source,
      media: draft.src
        ? [{ src: draft.src, fileId: draft.fileId, source: draft.source, path: draft.path || "" }]
        : [],
    });
  },

  onRecordTypeChange(e) {
    this.setData({
      recordDraft: this.buildRecordDraft({
        type: RECORD_TYPES[Number(e.detail.value)],
        src: "",
        fileId: "",
        path: "",
        source: "",
      }),
    });
  },

  onRecordInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({
      recordDraft: this.buildRecordDraft({
        [field]: e.detail.value,
      }),
    });
  },

  chooseRecordImage() {
    media
      .chooseImages({ count: 1 })
      .then((files) => media.prepareImages(files, `checkins-${this.data.checkin.id}`))
      .then((images) => {
        const image = images && images[0];
        if (!image) return;
        this.setData({
          recordDraft: this.buildRecordDraft(
            Object.assign(
              {
                value: this.data.recordDraft.value || "图片打卡",
              },
              image
            )
          ),
        });
        wx.showToast({ title: "图片已选择", icon: "success" });
      })
      .catch((error) => {
        if (media.isCancel(error)) return;
        wx.showToast({ title: (error && error.message) || "暂时无法选择图片", icon: "none" });
      });
  },

  previewRecordImage(e) {
    const src = e.currentTarget.dataset.src;
    if (!src || !wx.previewImage) return;
    const urls = (this.data.checkin.records || [])
      .filter((record) => record.src)
      .map((record) => record.src);
    wx.previewImage({
      current: src,
      urls,
    });
  },

  repairRecordImage(e) {
    const recordId = String(e.currentTarget.dataset.id || "");
    const record = (this.data.checkin.records || []).find((item) => item.id === recordId);
    if (!record || !record.canRepairImage || this.data.repairLoadingId || this.data.actionLoadingType) return;
    this.setData({ repairLoadingId: recordId });
    media
      .chooseImages({ count: 1 })
      .then((files) => media.prepareImages(files, `checkins-${this.data.checkin.id}`))
      .then((images) => {
        const image = images && images[0];
        if (!image) return null;
        return api.updateCheckinRecordMedia(this.data.checkin.id, recordId, image);
      })
      .then((checkin) => {
        if (!checkin) return;
        this.setData({ checkin: decorateCheckin(checkin) });
        wx.showToast({ title: "图片已补充", icon: "success" });
      })
      .catch((error) => {
        if (media.isCancel(error)) return;
        this.showActionError(error);
      })
      .then(() => this.setData({ repairLoadingId: "" }));
  },

  useLeaveCard() {
    this.runAction("leaveCard", () => api.useCheckinCard(this.data.checkin.id, "leave").then((checkin) => {
      this.setData({ checkin: decorateCheckin(checkin) });
      wx.showToast({ title: "请假卡已使用", icon: "success" });
    }));
  },

  useMakeupCard() {
    this.runAction("makeupCard", () => api.useCheckinCard(this.data.checkin.id, "makeup").then((checkin) => {
      this.setData({ checkin: decorateCheckin(checkin) });
      wx.showToast({ title: "补签成功", icon: "success" });
    }));
  },

  runPunishment() {
    return this.runAction("punishment", () => api.runCheckinPunishment(this.data.checkin.id).then((checkin) => {
      const decorated = decorateCheckin(checkin);
      this.setData({ checkin: decorated });
      wx.showToast({ title: decorated.punishmentText, icon: "none" });
    }));
  },

  copySummary() {
    wx.setClipboardData({
      data: `【${this.data.checkin.title}】${this.data.checkin.weeklySummary}`,
      success: () => {
        wx.showToast({ title: "周总结已复制", icon: "success" });
      },
    });
  },

  deleteCheckin() {
    const checkin = this.data.checkin || {};
    if (!checkin.canDelete || this.data.actionLoadingType) return;
    dialog.show({
      title: "删除打卡挑战",
      content: `确认删除「${checkin.title || "这个打卡挑战"}」吗？历史打卡记录会一起删除。`,
      confirmText: "删除",
      confirmColor: "#B34A34",
      success: (res) => {
        if (!res.confirm) return;
        this.runAction("deleteCheckin", () =>
          api.deleteCheckin(checkin.id || this.checkinId).then(() => {
            wx.showToast({ title: "打卡已删除", icon: "success" });
            wx.navigateBack({
              fail: () => wx.switchTab({ url: "/pages/tools/index" }),
            });
          })
        );
      },
    });
  },

  onShareAppMessage() {
    const checkin = this.data.checkin || {};
    return {
      title: checkin.title ? `打卡挑战：${checkin.title}` : "InCircle 打卡挑战",
      path: `/pages/checkin-detail/index?id=${checkin.id || this.checkinId}`,
    };
  },
});
