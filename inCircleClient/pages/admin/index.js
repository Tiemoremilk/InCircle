const api = require("../../utils/api");

function decorateLog(log) {
  const source = log || {};
  const target = String(source.targetName || source.targetId || "系统记录").trim();
  const detail = String(source.detail || "").replace(/^(?:成员|圈子|对象)：/, "").trim();
  return Object.assign({}, source, {
    actionText: source.actionText || source.action || "操作记录",
    actorName: source.actorName || "系统",
    summaryText: detail && detail !== target ? `${target} · ${detail}` : target,
  });
}

Page({
  data: {
    loading: true,
    isSuperAdmin: false,
    metrics: [],
    circleSummary: { total: 0, frozen: 0 },
    userSummary: { total: 0, blocked: 0 },
    logsPreview: [],
    logTotal: 0,
    hasMoreLogs: false,
  },

  onShow() {
    this.loadAdmin();
  },

  loadAdmin() {
    api
      .adminOverview()
      .then((data) => {
        const logs = data.logs || data.operationLogs || [];
        this.setData({
          loading: false,
          isSuperAdmin: !!data.isSuperAdmin,
          metrics: data.metrics || [],
          circleSummary: data.circleSummary || { total: 0, frozen: 0 },
          userSummary: data.userSummary || { total: 0, blocked: 0 },
          logsPreview: logs.slice(0, 5).map(decorateLog),
          logTotal: Number(data.logTotal || logs.length || 0),
          hasMoreLogs: !!data.hasMoreLogs,
        });
      })
      .catch((error) => {
        this.setData({ loading: false });
        wx.showToast({ title: (error && error.message) || "管理中心加载失败", icon: "none" });
      });
  },

  openAdminCircles() {
    wx.navigateTo({ url: "/pages/admin-circles/index" });
  },

  openAdminUsers() {
    wx.navigateTo({ url: "/pages/admin-users/index" });
  },

  openAdminLogs() {
    wx.navigateTo({ url: "/pages/admin-logs/index" });
  },
});
