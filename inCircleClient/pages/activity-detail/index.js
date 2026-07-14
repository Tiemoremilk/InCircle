const api = require("../../utils/api");
const media = require("../../utils/media");
const editIntent = require("../../utils/editIntent");
const dialog = require("../../utils/dialog");

const STATUS_OPTIONS = ["我来", "待定", "不来", "候补", "带一人"];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function statusClass(status) {
  if (status === "报名中" || status === "我来") return "pill-green";
  if (status === "待成局" || status === "待定") return "pill-amber";
  if (status === "已完成" || status === "已满员" || status === "候补" || status === "带一人") {
    return "pill-blue";
  }
  return "pill-red";
}

function decorate(activity) {
  if (!activity) return null;
  const attendees = asArray(activity.attendees);
  const pending = asArray(activity.pending);
  const absent = asArray(activity.absent);
  const waitlist = asArray(activity.waitlist);
  const silent = asArray(activity.silent);
  const capacity = Number(activity.capacity) || Math.max(attendees.length, 1);
  const coming = attendees.length + (activity.plusOneCount || 0);
  const percent = Math.min(100, Math.round((coming / capacity) * 100));
  const needCount = Math.max(0, capacity - coming);
  const hasLocation = !!(activity.location || activity.locationName || activity.locationAddress);
  const hasCoordinates = Number(activity.latitude) && Number(activity.longitude);
  const photos = (activity.photos || []).map((photo) =>
    Object.assign({}, photo, {
      className: photo.src ? "with-image" : photo.color || "green",
    })
  );
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
    statusClass: statusClass(activity.status),
    hasLocation,
    hasCoordinates,
    locationTitle: activity.locationName || activity.location || "地点信息",
    locationCopy: activity.locationAddress || activity.location || "发起人只填写了文字地点，可复制后回群确认。",
    locationActionText: hasCoordinates ? "打开地图" : "复制地点",
    silentText: silent.length ? silent.join("、") : "全员已表态",
    postBillText: activity.postBillId ? "已生成 AA" : "活动后发起 AA",
    photos,
    hasPhotos: photos.length > 0,
    recap,
    recapRows: [
      { label: "本局 MVP", value: recap.mvp || "待活动结束" },
      { label: "最早报名", value: recap.earlyBird || "待定" },
      { label: "最晚报名", value: recap.lateBird || "待定" },
      { label: "又鸽了的人", value: recap.noShow || "待复盘" },
    ],
    statusOptions: STATUS_OPTIONS.map((option) => ({
      value: option,
      activeClass: option === activity.myStatus ? "active" : "",
    })),
    groups: [
      { label: "我来", members: attendees },
      { label: "待定", members: pending },
      { label: "不来", members: absent },
      { label: "候补", members: waitlist },
    ].map((group) => Object.assign({}, group, { empty: group.members.length === 0 })),
  });
}

function buildActivityShareText(activity) {
  const silent = asArray(activity.silent);
  const silentText = silent.length ? `未表态：${silent.join("、")}` : "全员已表态";
  return [
    `【${activity.title}】${activity.status}`,
    `${activity.time} · ${activity.location}`,
    `${activity.fee} · 已来 ${activity.coming}/${activity.capacity}，还缺 ${activity.needCount} 人`,
    `${silentText}`,
    `小程序路径：/pages/activity-detail/index?id=${activity.id}`,
  ].join("\n");
}

Page({
  data: {
    id: "",
    sharedCircleId: "",
    ready: false,
    activity: null,
    actionLoadingType: "",
    actionLoadingName: "",
  },

  onLoad(options) {
    this.sharedCircleId = options.circleId || "";
    this.setData({
      id: options.id || "",
      sharedCircleId: this.sharedCircleId,
    });
  },

  onShow() {
    const sharedCircleId = this.sharedCircleId || this.data.sharedCircleId;
    const app = getApp();
    const currentCircleId = app && app.globalData ? app.globalData.currentCircleId : "";
    const prepare = sharedCircleId && sharedCircleId !== currentCircleId
      ? api.switchCircle(sharedCircleId)
      : Promise.resolve();
    prepare
      .then(() => this.loadActivity())
      .catch((error) => {
        wx.showToast({ title: (error && error.message) || "无法进入分享所属圈子", icon: "none" });
      });
  },

  loadActivity() {
    api.getActivity(this.data.id).then((activity) => {
      this.setData({
        activity: decorate(activity),
        ready: true,
      });
    });
  },

  editActivity() {
    const activity = this.data.activity || {};
    if (!activity.canEdit) {
      wx.showToast({ title: activity.editDisabledReason || "当前活动不能编辑", icon: "none" });
      return;
    }
    editIntent.setEditIntent("activity", activity.id || this.activityId);
    api.clearCache(["incircleActivities"]);
    wx.switchTab({ url: "/pages/activities/index" });
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

  chooseStatus(e) {
    const status = e.currentTarget.dataset.status;
    this.runAction("status", status, () => api.updateActivityStatus(this.data.id, status).then((activities) => {
      const activity = Array.isArray(activities)
        ? activities.find((item) => item.id === this.data.id) || activities[0]
        : activities;
      if (activity) this.setData({ activity: decorate(activity) });
      wx.showToast({
        title: `已标记：${status}`,
        icon: "none",
      });
    }));
  },

  finishActivity() {
    this.runAction("finish", "", () => api.finishActivity(this.data.id).then((activity) => {
      this.setData({ activity: decorate(activity) });
      wx.showToast({
        title: "复盘已生成",
        icon: "success",
      });
    }));
  },

  addPhoto() {
    if (!this.startAction("photo", "")) return;
    media
      .chooseImages({ count: 6 })
      .then((files) => {
        if (!files.length) return;
        return media.prepareImages(files, `activities-${this.data.id}`);
      })
      .then((images) => {
        if (!images || !images.length) return;
        const photos = images.map((image, index) =>
          Object.assign(
            {
              id: `activity-photo-${Date.now()}-${index}`,
              title: `活动照片 ${index + 1}`,
            },
            image
          )
        );
        return api.addActivityPhoto(this.data.id, photos).then((activity) => {
          this.setData({ activity: decorate(activity) });
          wx.showToast({
            title: `已加入 ${photos.length} 张照片`,
            icon: "success",
          });
        });
      })
      .catch((error) => {
        if (media.isCancel(error)) return;
        throw error;
      })
      .catch((error) => {
        this.showActionError(error);
      })
      .then(() => {
        this.finishAction();
      });
  },

  previewPhoto(e) {
    const src = e.currentTarget.dataset.src;
    if (!src || !wx.previewImage) return;
    const urls = (this.data.activity.photos || [])
      .filter((photo) => photo.src)
      .map((photo) => photo.src);
    wx.previewImage({
      current: src,
      urls,
    });
  },

  createBill() {
    this.runAction("bill", "", () => api.createBillFromActivity(this.data.id).then((activity) => {
      this.setData({ activity: decorate(activity) });
      wx.showToast({
        title: "AA 已生成",
        icon: "success",
      });
    }));
  },

  deleteActivity() {
    const activity = this.data.activity || {};
    if (!activity.canDelete || this.data.actionLoadingType) return;
    dialog.show({
      title: "删除活动",
      content: `确认删除「${activity.title || "这个活动"}」吗？删除后活动详情和报名记录将不再展示。`,
      confirmText: "删除",
      confirmColor: "#B34A34",
      success: (res) => {
        if (!res.confirm) return;
        this.runAction("delete", "", () =>
          api.deleteActivity(this.data.id).then(() => {
            wx.showToast({ title: "活动已删除", icon: "success" });
            wx.navigateBack({
              fail: () => wx.switchTab({ url: "/pages/activities/index" }),
            });
          })
        );
      },
    });
  },

  shareToGroup() {
    if (!this.data.activity) return;
    wx.setClipboardData({
      data: buildActivityShareText(this.data.activity),
      success: () => {
        wx.showToast({
          title: "分享文案已复制",
          icon: "success",
        });
      },
    });
  },

  openActivityLocation() {
    const activity = this.data.activity;
    if (!activity || !activity.hasLocation) return;
    if (activity.hasCoordinates && wx.openLocation) {
      wx.openLocation({
        latitude: Number(activity.latitude),
        longitude: Number(activity.longitude),
        name: activity.locationTitle,
        address: activity.locationCopy,
      });
      return;
    }
    wx.setClipboardData({
      data: activity.locationCopy || activity.locationTitle,
      success: () => {
        wx.showToast({ title: "地点已复制", icon: "success" });
      },
    });
  },

  onShareAppMessage() {
    const activity = this.data.activity || {};
    const app = getApp();
    const circleId = activity.circleId || this.data.sharedCircleId ||
      (app && app.globalData && app.globalData.currentCircleId) || "";
    return {
      title: activity.title ? `${activity.title}：来表态` : "InCircle 活动详情",
      path: `/pages/activity-detail/index?id=${this.data.id}&circleId=${circleId}`,
    };
  },
});
