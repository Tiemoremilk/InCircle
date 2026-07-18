const api = require("../../utils/api");
const dialog = require("../../utils/dialog");
const loginSessions = require("../../utils/login-sessions");

Page({
  data: {
    loading: true,
    refreshing: false,
    loadError: "",
    searchText: "",
    allSessions: [],
    sessions: [],
    sessionCount: 0,
    activeSessionCount: 0,
    filteredCount: 0,
    sessionBusyId: "",
  },

  onLoad() {
    this.loginRecordsAlive = true;
  },

  onShow() {
    this.loginRecordsAlive = true;
    this.loadRecords({ force: true, loading: !this.recordsLoaded });
  },

  onUnload() {
    this.loginRecordsAlive = false;
  },

  onPullDownRefresh() {
    this.loadRecords({ force: true, refreshing: true });
  },

  loadRecords(options) {
    const settings = options || {};
    const force = settings.force === true;
    if (this.loadingRecords && !force) return this.loadingRecords;
    const requestId = (this.recordsRequestId || 0) + 1;
    this.recordsRequestId = requestId;
    this.setData({
      loading: settings.loading === true,
      refreshing: settings.refreshing === true,
      loadError: "",
    });
    const request = api.getLoginSessions({ force })
      .then((data) => {
        if (!this.loginRecordsAlive || requestId !== this.recordsRequestId) return;
        const allSessions = (data.sessions || []).map(loginSessions.decorateSession);
        const sessions = loginSessions.filterSessions(allSessions, this.data.searchText);
        this.recordsLoaded = true;
        this.setData({
          loading: false,
          refreshing: false,
          loadError: "",
          allSessions,
          sessions,
          sessionCount: Number(data.sessionCount || allSessions.length),
          activeSessionCount: Number(data.activeSessionCount || 0),
          filteredCount: sessions.length,
        });
      })
      .catch((error) => {
        if (!this.loginRecordsAlive || requestId !== this.recordsRequestId) return;
        this.setData({
          loading: false,
          refreshing: false,
          loadError: (error && error.message) || "登录记录读取失败",
        });
      })
      .finally(() => {
        if (this.loadingRecords === request) this.loadingRecords = null;
        if (requestId === this.recordsRequestId && wx.stopPullDownRefresh) {
          wx.stopPullDownRefresh();
        }
      });
    this.loadingRecords = request;
    return request;
  },

  retryLoad() {
    this.loadRecords({ force: true, loading: true });
  },

  onSearchInput(e) {
    const searchText = String(e.detail.value || "");
    const sessions = loginSessions.filterSessions(this.data.allSessions, searchText);
    this.setData({ searchText, sessions, filteredCount: sessions.length });
  },

  clearSearch() {
    if (!this.data.searchText) return;
    const sessions = this.data.allSessions || [];
    this.setData({ searchText: "", sessions, filteredCount: sessions.length });
  },

  openSessionLocation(e) {
    const sessionId = String(e.currentTarget.dataset.id || "");
    const target = (this.data.allSessions || []).find((item) => item.id === sessionId);
    if (!target || !target.hasLoginLocation) return;
    loginSessions.openSessionLocation(target);
  },

  revokeSession(e) {
    if (this.data.sessionBusyId) return;
    const sessionId = String(e.currentTarget.dataset.id || "");
    const target = (this.data.allSessions || []).find((item) => item.id === sessionId);
    if (!target || !target.canRevoke) return;
    dialog.show({
      title: "退出这台设备",
      content: `“${target.deviceName}”将在下一次请求时退出登录，需要重新输入账号密码。`,
      cancelText: "暂不退出",
      confirmText: "确认退出",
      tone: "danger",
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ sessionBusyId: sessionId });
        api.revokeLoginSession(sessionId)
          .then(() => this.loadRecords({ force: true }))
          .then(() => wx.showToast({ title: "设备已退出", icon: "success" }))
          .catch((error) => {
            wx.showToast({ title: (error && error.message) || "退出设备失败", icon: "none" });
          })
          .finally(() => {
            if (this.loginRecordsAlive) this.setData({ sessionBusyId: "" });
          });
      },
    });
  },

  deleteSession(e) {
    if (this.data.sessionBusyId) return;
    const sessionId = String(e.currentTarget.dataset.id || "");
    const target = (this.data.allSessions || []).find((item) => item.id === sessionId);
    if (!target || !target.canDelete) return;
    dialog.show({
      title: "删除登录记录",
      content: `确定删除“${target.deviceName}”的已退出记录？删除后不可恢复，但不会影响账号和其他设备。`,
      cancelText: "暂不删除",
      confirmText: "确认删除",
      tone: "danger",
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ sessionBusyId: sessionId });
        api.deleteLoginSession(sessionId)
          .then(() => this.loadRecords({ force: true }))
          .then(() => wx.showToast({ title: "登录记录已删除", icon: "success" }))
          .catch((error) => {
            wx.showToast({ title: (error && error.message) || "删除登录记录失败", icon: "none" });
          })
          .finally(() => {
            if (this.loginRecordsAlive) this.setData({ sessionBusyId: "" });
          });
      },
    });
  },
});
