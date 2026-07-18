const api = require("../../utils/api");
const editIntent = require("../../utils/editIntent");
const dialog = require("../../utils/dialog");
const privateApi = require("../../utils/wechat-private-api");

const STATUS_OPTIONS = ["我来", "待定", "不来", "候补", "带一人"];
const TYPE_OPTIONS = ["饭局", "运动", "桌游", "电影", "KTV", "露营", "学习", "游戏"];
const CAPACITY_OPTIONS = ["4", "6", "8", "10", "12", "不限"];

function emptyActivityDraft() {
  return {
    title: "",
    type: "饭局",
    time: "",
    location: "",
    locationName: "",
    locationAddress: "",
    latitude: null,
    longitude: null,
    hasMapLocation: false,
    mapLocationLabel: "选择地图位置",
    capacity: "8",
    fee: "",
  };
}

function activityToDraft(activity) {
  const capacity = Number(activity && activity.capacity);
  const capacityText = capacity >= 99 ? "不限" : String(capacity || 8);
  const hasMapLocation = !!(
    activity &&
    activity.hasMapLocation &&
    activity.latitude !== null &&
    typeof activity.latitude !== "undefined" &&
    activity.longitude !== null &&
    typeof activity.longitude !== "undefined"
  );
  return {
    title: activity.title || "",
    type: activity.type || "饭局",
    time: activity.time || "",
    location: activity.location || "",
    locationName: activity.locationName || activity.location || "",
    locationAddress: activity.locationAddress || "",
    latitude: hasMapLocation ? activity.latitude : null,
    longitude: hasMapLocation ? activity.longitude : null,
    hasMapLocation,
    mapLocationLabel: hasMapLocation ? activity.locationName || activity.location || "已选地点" : "选择地图位置",
    capacity: capacityText,
    fee: activity.fee === "费用待定" ? "" : activity.fee || "",
  };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function statusClass(status) {
  if (status === "报名中" || status === "我来") return "pill-green";
  if (status === "待成局" || status === "待定") return "pill-amber";
  if (status === "已满员" || status === "候补" || status === "带一人") return "pill-blue";
  return "pill-red";
}

function decorate(activity) {
  const attendees = asArray(activity.attendees);
  const pending = asArray(activity.pending);
  const absent = asArray(activity.absent);
  const waitlist = asArray(activity.waitlist);
  const silent = asArray(activity.silent);
  const capacity = Number(activity.capacity) || Math.max(attendees.length, 1);
  const coming = attendees.length + (activity.plusOneCount || 0);
  const percent = Math.min(100, Math.round((coming / capacity) * 100));
  const needCount = Math.max(0, capacity - coming);
  const recap = activity.recap || {};
  return Object.assign({}, activity, {
    attendees,
    pending,
    absent,
    waitlist,
    silent,
    capacity,
    coming,
    percent,
    needCount,
    highlight: activity.highlight || "活动状态会随着圈友表态实时更新。",
    recap: Object.assign({}, recap, {
      mvp: recap.mvp || "待活动结束",
      earlyBird: recap.earlyBird || "待活动结束",
    }),
    statusClass: statusClass(activity.status),
    myStatusClass: statusClass(activity.myStatus),
    silentText: silent.length ? silent.join("、") : "全员已表态",
    statusOptions: STATUS_OPTIONS.map((option) => ({
      value: option,
      active: option === activity.myStatus,
      activeClass: option === activity.myStatus ? "active" : "",
    })),
  });
}

Page({
  data: {
    loading: true,
    activities: [],
    statusOptions: STATUS_OPTIONS,
    typeOptions: TYPE_OPTIONS,
    capacityOptions: CAPACITY_OPTIONS,
    showCreatePanel: false,
    editingActivityId: "",
    activityFormKicker: "创建活动",
    activityFormTitle: "发起一个新约局",
    showShareSheet: false,
    shareTargetActivity: null,
    actionLoadingType: "",
    actionLoadingId: "",
    actionLoadingName: "",
    draft: emptyActivityDraft(),
  },

  onShow() {
    this.loadActivities();
  },

  loadActivities() {
    api.listActivities().then((activities) => {
      this.setData({
        activities: activities.map(decorate),
        loading: false,
      }, () => this.openPendingEdit());
    });
  },

  openPendingEdit() {
    const intent = editIntent.consumeEditIntent("activity");
    if (!intent) return;
    this.editActivity({ currentTarget: { dataset: { id: intent.id } } });
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

  chooseStatus(e) {
    const { id, status } = e.currentTarget.dataset;
    this.runAction("status", id, status, () => api.updateActivityStatus(id, status).then((activities) => {
      this.setData({
        activities: activities.map(decorate),
      });
      wx.showToast({
        title: `已标记：${status}`,
        icon: "none",
      });
    }));
  },

  createActivity() {
    this.setData({
      showCreatePanel: true,
      editingActivityId: "",
      activityFormKicker: "创建活动",
      activityFormTitle: "发起一个新约局",
      draft: emptyActivityDraft(),
    });
  },

  editActivity(e) {
    const id = e.currentTarget.dataset.id;
    const activity = this.data.activities.find((item) => item.id === id);
    if (!activity || this.data.actionLoadingType) return;
    if (!activity.canEdit) {
      wx.showToast({ title: activity.editDisabledReason || "当前活动不能编辑", icon: "none" });
      return;
    }
    this.setData({
      showCreatePanel: true,
      editingActivityId: id,
      activityFormKicker: "编辑活动",
      activityFormTitle: "调整约局信息",
      draft: activityToDraft(activity),
    });
  },

  openActivity(e) {
    wx.navigateTo({
      url: `/pages/activity-detail/index?id=${e.currentTarget.dataset.id}`,
    });
  },

  closeCreatePanel() {
    this.setData({
      showCreatePanel: false,
      editingActivityId: "",
    });
  },

  closeShareSheet() {
    this.setData({
      showShareSheet: false,
      shareTargetActivity: null,
    });
  },

  noop() {},

  onDraftInput(e) {
    const field = e.currentTarget.dataset.field;
    const value = e.detail.value;
    if (field === "location") {
      this.setData({
        "draft.location": value,
        "draft.locationName": value,
        "draft.locationAddress": "",
        "draft.latitude": null,
        "draft.longitude": null,
        "draft.hasMapLocation": false,
        "draft.mapLocationLabel": "选择地图位置",
      });
      return;
    }
    this.setData({
      [`draft.${field}`]: value,
    });
  },

  onTypeChange(e) {
    this.setData({
      "draft.type": TYPE_OPTIONS[Number(e.detail.value)],
    });
  },

  onCapacityChange(e) {
    this.setData({
      "draft.capacity": CAPACITY_OPTIONS[Number(e.detail.value)],
    });
  },

  chooseActivityLocation() {
    if (!wx.chooseLocation) {
      wx.showToast({ title: "当前基础库暂不支持地图选点", icon: "none" });
      return;
    }
    wx.chooseLocation({
      success: (location) => {
        const name = location.name || location.address || "已选地点";
        this.setData({
          "draft.location": name,
          "draft.locationName": name,
          "draft.locationAddress": location.address || "",
          "draft.latitude": location.latitude,
          "draft.longitude": location.longitude,
          "draft.hasMapLocation": true,
          "draft.mapLocationLabel": name,
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

  submitActivity(e) {
    const draft = this.data.draft;
    const shareAfterSave = !!(e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.shareAfter);
    if (!draft.title || !draft.time || !draft.location) {
      wx.showToast({
        title: "补全名称、时间和地点",
        icon: "none",
      });
      return;
    }

    const capacity = draft.capacity === "不限" ? 99 : Number(draft.capacity);
    const activity = {
      title: draft.title,
      type: draft.type,
      time: draft.time,
      location: draft.location,
      locationName: draft.locationName || draft.location,
      locationAddress: draft.locationAddress || "",
      latitude: draft.latitude,
      longitude: draft.longitude,
      hasMapLocation: !!draft.hasMapLocation,
      capacity,
      fee: draft.fee || "费用待定",
      tags: ["新发起", `缺 ${Math.max(0, capacity - 1)} 人`, "可分享微信群"],
      highlight: "活动已创建，可分享到微信群让大家快速表态。",
    };

    const editingId = this.data.editingActivityId;
    this.runAction("saveActivity", editingId, "", () => {
      const saveTask = editingId ? api.updateActivity(editingId, activity) : api.createActivity(activity);
      return saveTask.then((activities) => {
        const decoratedActivities = activities.map(decorate);
        const saved = editingId
          ? decoratedActivities.find((item) => item.id === editingId)
          : decoratedActivities[0];
        this.setData({
          activities: decoratedActivities,
          showCreatePanel: false,
          editingActivityId: "",
          draft: emptyActivityDraft(),
          showShareSheet: !!(shareAfterSave && saved),
          shareTargetActivity: shareAfterSave && saved ? saved : null,
        });
        wx.showToast({
          title: editingId ? "活动已更新" : "约局已创建",
          icon: "success",
        });
      });
    });
  },

  prepareActivityShare(e) {
    const activity = this.data.activities.find((item) => item.id === e.currentTarget.dataset.id);
    if (!activity) return;
    this.setData({ shareTargetActivity: activity });
  },

  deleteActivity(e) {
    const id = e.currentTarget.dataset.id;
    const activity = this.data.activities.find((item) => item.id === id) || {};
    if (!activity.canDelete) return;
    dialog.show({
      title: "删除活动",
      content: `确认删除「${activity.title || "这个活动"}」吗？`,
      confirmText: "删除",
      confirmColor: "#B34A34",
      success: (res) => {
        if (!res.confirm) return;
        this.runAction("delete", id, "", () => api.deleteActivity(id).then((activities) => {
          this.setData({
            activities: activities.map(decorate),
          });
          wx.showToast({ title: "活动已删除", icon: "success" });
        }));
      },
    });
  },

  onShareAppMessage(options) {
    const dataset = options && options.target && options.target.dataset ? options.target.dataset : {};
    const targetId = dataset.id || (this.data.shareTargetActivity && this.data.shareTargetActivity.id);
    const activity = this.data.activities.find((item) => item.id === targetId) || this.data.shareTargetActivity;
    if (activity) {
      setTimeout(() => this.closeShareSheet(), 0);
      return {
        title: `${activity.title}：${activity.time || "来看看活动安排"}`,
        path: `/pages/activity-detail/index?id=${activity.id}&circleId=${activity.circleId || ""}`,
      };
    }
    return {
      title: "圈内约局：时间、地点和报名状态都在这里",
      path: "/pages/activities/index",
    };
  },
});
