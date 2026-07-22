const api = require("../../utils/api");
const dialog = require("../../utils/dialog");

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
    platformSettings: { circleAiEnabled: true, webSearchEnabled: false, webSearchConfigured: false },
    platformAiBusy: false,
    platformSearchBusy: false,
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
          platformSettings: data.platformSettings || { circleAiEnabled: true },
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

  togglePlatformAi(e) {
    const enabled = !!(e && e.detail && e.detail.value);
    const current = !!this.data.platformSettings.circleAiEnabled;
    if (this.data.platformAiBusy || enabled === current) return;
    this.setData({ "platformSettings.circleAiEnabled": current });
    if (enabled) {
      this.updatePlatformAi(true);
      return;
    }
    dialog.show({
      title: "关闭圈内 AI",
      content: "关闭后，所有圈子的 AI 入口和圈内设置会统一隐藏，现有供应商、模型和会话数据会保留。",
      cancelText: "保持开放",
      confirmText: "确认关闭",
      tone: "primary",
      success: (res) => {
        if (res.confirm) this.updatePlatformAi(false);
      },
    });
  },

  updatePlatformAi(circleAiEnabled) {
    if (this.data.platformAiBusy) return;
    this.setData({ platformAiBusy: true });
    api.adminUpdatePlatformAi(circleAiEnabled).then((data) => {
      this.setData({
        platformSettings: data.platformSettings || { circleAiEnabled },
      });
      wx.showToast({
        title: circleAiEnabled ? "圈内 AI 已开放" : "圈内 AI 已关闭",
        icon: "success",
      });
    }).catch((error) => {
      wx.showToast({ title: (error && error.message) || "设置失败", icon: "none" });
    }).finally(() => {
      this.setData({ platformAiBusy: false });
    });
  },

  togglePlatformSearch(e) {
    const enabled = !!(e && e.detail && e.detail.value);
    const settings = this.data.platformSettings || {};
    const current = !!settings.webSearchEnabled;
    this.setData({ "platformSettings.webSearchEnabled": current });
    if (this.data.platformSearchBusy || enabled === current) return;
    if (enabled && !settings.webSearchConfigured) {
      wx.showToast({ title: "搜索服务尚未配置", icon: "none" });
      return;
    }
    if (enabled) {
      this.updatePlatformSearch(true);
      return;
    }
    dialog.show({
      title: "关闭联网搜索",
      content: "关闭后，对话页将隐藏联网搜索选项，普通 AI 对话不受影响。",
      cancelText: "保持开放",
      confirmText: "确认关闭",
      tone: "primary",
      success: (res) => { if (res.confirm) this.updatePlatformSearch(false); },
    });
  },

  updatePlatformSearch(webSearchEnabled) {
    if (this.data.platformSearchBusy) return;
    this.setData({ platformSearchBusy: true });
    api.adminUpdatePlatformWebSearch(webSearchEnabled).then((data) => {
      this.setData({ platformSettings: data.platformSettings || Object.assign({}, this.data.platformSettings, { webSearchEnabled }) });
      wx.showToast({ title: webSearchEnabled ? "联网搜索已开放" : "联网搜索已关闭", icon: "success" });
    }).catch((error) => {
      wx.showToast({ title: (error && error.message) || "设置失败", icon: "none" });
      this.loadAdmin();
    }).finally(() => this.setData({ platformSearchBusy: false }));
  },

  openAdminLogs() {
    wx.navigateTo({ url: "/pages/admin-logs/index" });
  },
});
