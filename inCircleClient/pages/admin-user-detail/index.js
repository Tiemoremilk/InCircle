const api = require("../../utils/api");
const time = require("../../utils/time");
const dialog = require("../../utils/dialog");
const memberRole = require("../../utils/memberRole");
const loginSessions = require("../../utils/login-sessions");
const theme = require("../../utils/theme");

function dateText(value) {
  return value ? time.displayDateTime(value) || "未记录" : "未记录";
}

function sessionTimestamp(session) {
  const timestamp = Date.parse(session && session.lastLoginAt ? session.lastLoginAt : "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function decorateAdminSession(item) {
  const session = loginSessions.decorateSession(item);
  const location = session.loginLocation || {};
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  const accuracy = Number(location.accuracyMeters);
  const hasCoordinates = session.hasLoginLocation
    && Number.isFinite(latitude)
    && Number.isFinite(longitude);

  return Object.assign({}, session, {
    deviceName: session.deviceName || "未知设备",
    environment: session.environment || "环境信息未记录",
    statusText: session.statusText || (session.current ? "当前设备" : session.canRevoke ? "已登录" : "已退出"),
    coordinateValueText: hasCoordinates
      ? `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`
      : "未记录",
    accuracyText: hasCoordinates && Number.isFinite(accuracy)
      ? `约 ${Math.round(accuracy)} 米`
      : "未记录",
  });
}

function compactDecimal(value) {
  return Number(value).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function decorateThemePreference(user) {
  const requestedKey = String((user && user.themeKey) || "").trim();
  if (requestedKey === theme.CUSTOM_THEME_KEY) {
    const rgba = theme.normalizeCustomThemeRgba(
      user && user.customTheme,
      theme.DEFAULT_CUSTOM_THEME_RGBA
    );
    const customTheme = theme.buildCustomTheme(rgba);
    return {
      themeNameText: "自定义",
      themeKindText: "自定义",
      themeValueText: `RGBA(${rgba.r}, ${rgba.g}, ${rgba.b}, ${compactDecimal(rgba.a)})`,
      themeSwatchStyle: `background: ${customTheme.swatch};`,
    };
  }

  const presetTheme = theme.THEMES.find((item) => item.key === requestedKey) || theme.THEMES[0];
  return {
    themeNameText: presetTheme.name,
    themeKindText: "预设",
    themeValueText: "系统预设配色",
    themeSwatchStyle: `background: ${presetTheme.swatch};`,
  };
}

function decorate(data) {
  const source = data || {};
  const user = source.user || {};
  const summary = source.loginSessionSummary || {};
  const allSessions = (source.recentLoginSessions || summary.sessions || [])
    .map((session, index) => ({ session, index }))
    .sort((left, right) => sessionTimestamp(right.session) - sessionTimestamp(left.session) || left.index - right.index)
    .map((entry) => decorateAdminSession(entry.session));
  const recentLoginSessions = allSessions.slice(0, 5);
  const reportedSessionCount = typeof summary.sessionCount !== "undefined"
    ? summary.sessionCount
    : typeof summary.total !== "undefined"
      ? summary.total
      : allSessions.length;
  const reportedActiveSessionCount = typeof summary.activeSessionCount !== "undefined"
    ? summary.activeSessionCount
    : typeof summary.activeCount !== "undefined"
      ? summary.activeCount
      : allSessions.filter((session) => session.current || session.canRevoke).length;
  const sessionCount = Number(reportedSessionCount);
  const activeSessionCount = Number(
    reportedActiveSessionCount
  );

  return {
    user: Object.assign({}, user, {
      createdAtText: dateText(user.createdAt),
      lastLoginAtText: dateText(user.lastLoginAt),
      blockedAtText: dateText(user.blockedAt),
      wechatUnboundAtText: dateText(user.wechatUnboundAt),
      wechatBoundAtText: dateText(user.wechatBoundAt),
      accountBoundAtText: dateText(user.accountBoundAt),
      passwordUpdatedAtText: dateText(user.passwordUpdatedAt),
      wechatOpenidText: user.wechatOpenidMasked || "未记录",
      wechatUnionidText: user.wechatUnionidMasked || "未记录",
      verifyWechatOnLoginText: user.verifyWechatOnLogin === false ? "已关闭" : "已开启",
      preciseLoginLocationText: user.preciseLoginLocationEnabled ? "已开启" : "已关闭",
      ...decorateThemePreference(user),
    }),
    circles: (source.circles || []).map((circle) => memberRole.decorateMemberRole(Object.assign({}, circle, {
      initial: String(circle.name || "圈").slice(0, 1),
      joinedAtText: dateText(circle.joinedAt),
      relationText: circle.status === "active" ? "有效成员" : circle.status === "removed" ? "已移除" : "已退出",
    }))),
    recentLoginSessions,
    loginSessionSummary: {
      sessionCount: Number.isFinite(sessionCount) ? sessionCount : recentLoginSessions.length,
      activeSessionCount: Number.isFinite(activeSessionCount) ? activeSessionCount : 0,
      shownCount: recentLoginSessions.length,
      hasMore: summary.hasMore === true,
    },
    deleteImpact: source.deleteImpact || { ownedCircleCount: 0, membershipCount: 0 },
  };
}

Page({
  data: {
    loading: true,
    loadError: "",
    user: null,
    circles: [],
    recentLoginSessions: [],
    loginSessionSummary: { sessionCount: 0, activeSessionCount: 0, shownCount: 0 },
    deleteImpact: null,
    busyAction: "",
  },

  onLoad(options) {
    this.adminUserDetailAlive = true;
    this.userId = (options && options.id) || "";
    this.loadUser();
  },

  onUnload() {
    this.adminUserDetailAlive = false;
  },

  loadUser() {
    this.setData({ loading: true, loadError: "" });
    return api.adminGetUser(this.userId)
      .then((data) => {
        if (!this.adminUserDetailAlive) return;
        this.setData(Object.assign(decorate(data), { loading: false, loadError: "" }));
      })
      .catch((error) => {
        if (!this.adminUserDetailAlive) return;
        this.setData({
          loading: false,
          loadError: (error && error.message) || "用户详情加载失败",
        });
      });
  },

  retryLoad() {
    if (!this.data.loading) this.loadUser();
  },

  openSessionLocation(e) {
    const index = Number(e.currentTarget.dataset.index);
    const target = this.data.recentLoginSessions[index];
    if (!target || !target.hasLoginLocation) return;
    loginSessions.openSessionLocation(target);
  },

  openCircle(e) {
    const id = e.currentTarget.dataset.id;
    if (id && !this.data.busyAction) {
      wx.navigateTo({ url: `/pages/circle-settings/index?id=${id}` });
    }
  },

  toggleBlocked() {
    const user = this.data.user || {};
    if (!user.canManage || this.data.busyAction) return;
    const blocking = user.status !== "blocked";
    dialog.show({
      title: blocking ? "封禁用户" : "解除封禁",
      content: blocking
        ? "封禁后该用户会立即退出登录，无法进入圈子、上传图片或使用 AI；其名下圈子继续运行。"
        : "解封只恢复登录资格，不会自动登录。",
      confirmText: blocking ? "封禁" : "解封",
      tone: blocking ? "danger" : "default",
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ busyAction: "status" });
        api.adminUpdateUserStatus(this.userId, blocking ? "blocked" : "active", "管理中心手动封禁")
          .then((data) => {
            this.setData(decorate(data));
            wx.showToast({ title: blocking ? "用户已封禁" : "用户已解封", icon: "success" });
          })
          .catch((error) => wx.showToast({ title: (error && error.message) || "操作失败", icon: "none" }))
          .finally(() => this.setData({ busyAction: "" }));
      },
    });
  },

  unbindWechat() {
    const user = this.data.user || {};
    if (!user.canManage || !user.wechatBound || this.data.busyAction) return;
    dialog.show({
      title: "解绑微信",
      content: "解绑会立即撤销旧微信的登录状态。账号密码和圈子数据保留，用户可在新微信中使用原账号密码重新绑定。",
      confirmText: "确认解绑",
      tone: "danger",
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ busyAction: "unbind" });
        api.adminUnbindUserWechat(this.userId)
          .then((data) => {
            this.setData(decorate(data));
            wx.showToast({ title: "微信已解绑", icon: "success" });
          })
          .catch((error) => wx.showToast({ title: (error && error.message) || "解绑失败", icon: "none" }))
          .finally(() => this.setData({ busyAction: "" }));
      },
    });
  },

  deleteUser() {
    const user = this.data.user || {};
    const impact = this.data.deleteImpact || {};
    if (!user.canManage || this.data.busyAction) return;
    dialog.show({
      title: "物理删除用户",
      content: `将永久删除该账号、${impact.ownedCircleCount || 0} 个名下圈子及对应业务数据。用户在其他圈子的个人记录也会移除，操作不能恢复。`,
      confirmText: "永久删除",
      tone: "danger",
      verificationText: user.confirmationTarget,
      verificationLabel: `请输入完整账号：${user.confirmationTarget}`,
      verificationPlaceholder: user.confirmationTarget,
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ busyAction: "delete" });
        api.adminDeleteUser(this.userId, res.content || "")
          .then(() => {
            wx.showToast({ title: "用户已删除", icon: "success" });
            setTimeout(() => wx.navigateBack(), 300);
          })
          .catch((error) => wx.showToast({ title: (error && error.message) || "删除失败", icon: "none" }))
          .finally(() => this.setData({ busyAction: "" }));
      },
    });
  },
});
