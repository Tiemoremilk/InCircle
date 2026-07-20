const api = require("../../utils/api");
const time = require("../../utils/time");
const dialog = require("../../utils/dialog");

const PAGE_SIZE = 20;

function decorateLog(log) {
  return Object.assign({}, log, {
    actionText: log.actionText || log.action || "操作记录",
    targetText: log.targetName || log.circleName || log.targetId || "系统记录",
    detailText: log.detail || "已记录",
    createdAtText: log.createdAtText || time.displayDateTime(log.createdAt, log.createdAtMs, log.id),
  });
}

function decorateFilters(actors, activeActorId) {
  const filters = [
    {
      id: "",
      name: "全部人员",
    },
  ].concat(actors || []);
  return filters.map((item) =>
    Object.assign({}, item, {
      activeClass: String(item.id || "") === String(activeActorId || "") ? "active" : "",
    })
  );
}

Page({
  data: {
    loading: true,
    loadingMore: false,
    refreshing: false,
    searchText: "",
    keyword: "",
    activeActorId: "",
    actors: [],
    filterOptions: decorateFilters([], ""),
    logs: [],
    total: 0,
    hasMore: false,
    deletingLogId: "",
    clearingLogs: false,
  },

  onLoad() {
    this.loadLogs({ reset: true });
  },

  onPullDownRefresh() {
    this.loadLogs({ reset: true, refreshing: true });
  },

  loadLogs(options) {
    const opts = options || {};
    const reset = !!opts.reset;
    if (this.data.loadingMore && !reset) return;
    const offset = reset ? 0 : this.data.logs.length;
    this.setData({
      loading: reset && !opts.refreshing && !opts.silent,
      refreshing: !!opts.refreshing,
      loadingMore: !reset,
    });
    return api
      .adminListOperationLogs({
        keyword: this.data.keyword,
        actorUserId: this.data.activeActorId,
        limit: PAGE_SIZE,
        offset,
      })
      .then((data) => {
        const nextLogs = (data.logs || []).map(decorateLog);
        const logs = reset ? nextLogs : this.data.logs.concat(nextLogs);
        this.setData({
          logs,
          total: data.total || logs.length,
          hasMore: !!data.hasMore,
          actors: data.actors || [],
          filterOptions: decorateFilters(data.actors || [], this.data.activeActorId),
          loading: false,
          loadingMore: false,
          refreshing: false,
        });
      })
      .catch((error) => {
        this.setData({
          loading: false,
          loadingMore: false,
          refreshing: false,
        });
        wx.showToast({
          title: (error && error.message) || "管理日志加载失败",
          icon: "none",
        });
      })
      .then(() => {
        if (wx.stopPullDownRefresh) wx.stopPullDownRefresh();
      });
  },

  onSearchInput(e) {
    this.setData({ searchText: e.detail.value });
  },

  submitSearch() {
    this.setData({ keyword: String(this.data.searchText || "").trim() });
    this.loadLogs({ reset: true });
  },

  clearSearch() {
    if (!this.data.searchText && !this.data.keyword) return;
    this.setData({
      searchText: "",
      keyword: "",
    });
    this.loadLogs({ reset: true });
  },

  selectActor(e) {
    const id = e.currentTarget.dataset.id || "";
    if (String(id) === String(this.data.activeActorId || "")) return;
    this.setData({
      activeActorId: id,
      filterOptions: decorateFilters(this.data.actors, id),
    });
    this.loadLogs({ reset: true });
  },

  loadMore() {
    if (!this.data.hasMore || this.data.loadingMore) return;
    this.loadLogs();
  },

  deleteLog(e) {
    if (this.data.clearingLogs || this.data.deletingLogId) return;
    const id = e.currentTarget.dataset.id || "";
    const log = (this.data.logs || []).find((item) => item.id === id) || {};
    if (!id) return;
    dialog.show({
      title: "删除日志",
      content: `确定删除“${log.actionText || "这条"}”管理日志？删除后不可恢复。`,
      confirmText: "删除",
      confirmColor: "#b34a34",
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ deletingLogId: id });
        api
          .adminDeleteOperationLogs({ ids: [id] })
          .then((data) => {
            wx.showToast({
              title: `已删除 ${data.deletedCount || 0} 条`,
              icon: "none",
            });
            return this.loadLogs({ reset: true, silent: true });
          })
          .catch((error) => {
            wx.showToast({
              title: (error && error.message) || "删除失败",
              icon: "none",
            });
          })
          .finally(() => {
            this.setData({ deletingLogId: "" });
          });
      },
    });
  },

  clearCurrentLogs() {
    if (this.data.clearingLogs || this.data.deletingLogId) return;
    if (!this.data.total) {
      wx.showToast({ title: "暂无可清理日志", icon: "none" });
      return;
    }
    const keyword = String(this.data.keyword || "").trim();
    const actorId = this.data.activeActorId || "";
    const actor = (this.data.filterOptions || []).find((item) => String(item.id || "") === String(actorId));
    const hasFilter = !!(keyword || actorId);
    const filterText = hasFilter
      ? `当前筛选命中的 ${this.data.total} 条日志`
      : `全部 ${this.data.total} 条管理日志`;
    const detailText = [
      actorId && actor ? `人员：${actor.name}` : "",
      keyword ? `搜索：${keyword}` : "",
    ].filter(Boolean).join("；");
    dialog.show({
      title: hasFilter ? "清理筛选日志" : "清空全部日志",
      content: `将删除${filterText}${detailText ? `（${detailText}）` : ""}，删除后不可恢复。`,
      confirmText: "清理",
      confirmColor: "#b34a34",
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ clearingLogs: true });
        api
          .adminDeleteOperationLogs({
            keyword,
            actorUserId: actorId,
            deleteAll: !hasFilter,
          })
          .then((data) => {
            wx.showToast({
              title: `已清理 ${data.deletedCount || 0} 条`,
              icon: "none",
            });
            return this.loadLogs({ reset: true, silent: true });
          })
          .catch((error) => {
            wx.showToast({
              title: (error && error.message) || "清理失败",
              icon: "none",
            });
          })
          .finally(() => {
            this.setData({ clearingLogs: false });
          });
      },
    });
  },
});
