const api = require("../../utils/api");
const dialog = require("../../utils/dialog");
const memberRole = require("../../utils/memberRole");
const theme = require("../../utils/theme");
const time = require("../../utils/time");

const DEFAULT_CIRCLE_CREATE_LIMIT = 10;
const CIRCLE_CREATE_LIMIT_MESSAGE = "每个账号最多创建 10 个圈子，冻结的圈子也会计入。请先解散一个不再使用的圈子后再创建。";

function decorateCircle(circle) {
  return memberRole.decorateMemberRole(Object.assign({}, circle, {
    lastEnteredText: circle.lastEnteredAt ? `最近进入 ${time.displayDateTime(circle.lastEnteredAt)}` : "尚未进入",
  }));
}

Page({
  data: {
    loading: true,
    user: null,
    circles: [],
    currentCircle: null,
    joinedCount: 0,
    managedCount: 0,
    currentMemberCount: 0,
    hasCircles: false,
    hasCurrentCircle: false,
    circleTotal: 0,
    hasMoreCircles: false,
    isSuperAdmin: false,
    ownedCircleCount: 0,
    circleCreateLimit: DEFAULT_CIRCLE_CREATE_LIMIT,
    canCreateCircle: true,
    switchingCircle: false,
    switchingCircleId: "",
    switchingCircleName: "",
    creatingCircle: false,
  },

  onLoad() {
    this.circleSwitchAlive = true;
  },

  onShow() {
    this.circleSwitchAlive = true;
    this.loadCircles();
  },

  onUnload() {
    this.circleSwitchAlive = false;
  },

  loadCircles() {
    if (this.data.switchingCircle || this.data.creatingCircle) return;
    api.listMyCircles({ limit: 3, offset: 0 })
      .then((data) => {
        const currentCircle = data.currentCircle || {};
        const isSuperAdmin = !!data.isSuperAdmin;
        const ownedCircleCount = Number(data.ownedCircleCount || 0);
        const circleCreateLimit = Number(data.circleCreateLimit || DEFAULT_CIRCLE_CREATE_LIMIT);
        const canCreateCircle = isSuperAdmin || (
          typeof data.canCreateCircle === "boolean"
            ? data.canCreateCircle
            : ownedCircleCount < circleCreateLimit
        );
        this.setData({
          user: data.user,
          circles: (data.circles || []).map(decorateCircle),
          currentCircle,
          joinedCount: data.joinedCount || 0,
          managedCount: data.managedCount || 0,
          currentMemberCount: data.currentMemberCount || currentCircle.memberCount || 0,
          circleTotal: data.joinedCount || data.total || 0,
          hasMoreCircles: Number(data.joinedCount || data.total || 0) > 3,
          hasCircles: Number(data.joinedCount || data.total || 0) > 0,
          hasCurrentCircle: !!(currentCircle && currentCircle.id),
          isSuperAdmin,
          ownedCircleCount,
          circleCreateLimit,
          canCreateCircle,
          loading: false,
        }, () => theme.applyPageTheme(this));
      })
      .catch((error) => {
        const message = (error && error.message) || "读取失败";
        if (/登录|绑定/.test(message)) {
          wx.redirectTo({ url: "/pages/login/index" });
          return;
        }
        this.setData({ loading: false });
        wx.showToast({ title: message, icon: "none" });
      });
  },

  switchCircle(e) {
    if (this.data.switchingCircle || this.data.creatingCircle) return;
    const id = e.currentTarget.dataset.id;
    const target = (this.data.circles || []).find((item) => item.id === id) || {};
    this.setData({
      switchingCircle: true,
      switchingCircleId: id,
      switchingCircleName: target.name || "这个圈子",
    });
    api.switchCircle(id)
      .then(() => {
        wx.showToast({ title: "已切换圈子", icon: "success" });
        wx.switchTab({ url: "/pages/index/index" });
      })
      .catch((error) => {
        this.setData({ switchingCircle: false, switchingCircleId: "", switchingCircleName: "" });
        wx.showToast({ title: (error && error.message) || "暂不可切换", icon: "none" });
      });
  },

  openSettings(e) {
    if (this.data.switchingCircle || this.data.creatingCircle) return;
    wx.navigateTo({ url: `/pages/circle-settings/index?id=${e.currentTarget.dataset.id}` });
  },

  openAllCircles() {
    if (this.data.switchingCircle || this.data.creatingCircle) return;
    wx.navigateTo({ url: "/pages/my-circles/index" });
  },

  openJoin() {
    if (this.data.switchingCircle || this.data.creatingCircle) return;
    wx.navigateTo({ url: "/pages/circle-join/index" });
  },

  showCircleCreateLimitDialog() {
    return dialog.show({
      title: "已达创建上限",
      content: CIRCLE_CREATE_LIMIT_MESSAGE,
      confirmText: "知道了",
      showCancel: false,
    }).catch(() => {});
  },

  createCircle() {
    if (this.data.switchingCircle || this.data.creatingCircle) return;
    if (!this.data.isSuperAdmin && !this.data.canCreateCircle) {
      this.showCircleCreateLimitDialog();
      return;
    }
    this.setData({ creatingCircle: true });
    api.createCircle({
      name: "新的熟人圈",
      slogan: "把活动、AA、投票和资料放回一个有秩序的地方。",
      notice: "欢迎加入新圈子。",
    })
      .then(() => {
        wx.showToast({ title: "圈子已创建", icon: "success" });
        this.setData({ creatingCircle: false });
        this.loadCircles();
      })
      .catch((error) => {
        if (error && error.errCode === "CIRCLE_CREATE_LIMIT_REACHED") {
          const details = error.details || {};
          const limit = Number(details.limit || this.data.circleCreateLimit || DEFAULT_CIRCLE_CREATE_LIMIT);
          const ownedCount = Number(details.ownedCount);
          this.setData({
            ownedCircleCount: Number.isFinite(ownedCount) ? ownedCount : limit,
            circleCreateLimit: limit,
            canCreateCircle: false,
          });
          this.showCircleCreateLimitDialog();
          return;
        }
        wx.showToast({ title: (error && error.message) || "创建失败", icon: "none" });
      })
      .finally(() => {
        if (this.circleSwitchAlive) this.setData({ creatingCircle: false });
      });
  },

  openHome() {
    if (this.data.switchingCircle || this.data.creatingCircle) return;
    if (!this.data.hasCurrentCircle) {
      wx.showToast({ title: "请先选择一个圈子", icon: "none" });
      return;
    }
    const current = this.data.currentCircle || {};
    if (current.id) this.switchCircle({ currentTarget: { dataset: { id: current.id } } });
  },

  openAccountSettings() {
    if (this.data.switchingCircle || this.data.creatingCircle) return;
    wx.navigateTo({ url: "/pages/account-settings/index" });
  },
});
