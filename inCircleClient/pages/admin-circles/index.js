const api = require("../../utils/api");
const dialog = require("../../utils/dialog");

const PAGE_SIZE = 20;
const STATUS_FILTERS = [
  { key: "all", label: "全部" },
  { key: "active", label: "正常" },
  { key: "frozen", label: "冻结" },
];

function decorateCircle(circle) {
  const active = circle.status === "active";
  return Object.assign({}, circle, {
    nextStatus: active ? "frozen" : "active",
    statusActionText: active ? "冻结" : "解冻",
    statusBusyId: `status:${circle.id}`,
    deleteBusyId: `delete:${circle.id}`,
  });
}

function decorateFilters(active) {
  return STATUS_FILTERS.map((item) => Object.assign({}, item, { activeClass: item.key === active ? "active" : "" }));
}

Page({
  data: { loading: true, loadingMore: false, searchText: "", keyword: "", status: "all", filters: decorateFilters("all"), circles: [], total: 0, hasMore: false, busyId: "" },

  onLoad() { this.requestVersion = 0; this.loadCircles({ reset: true }); },
  onUnload() { if (this.searchTimer) clearTimeout(this.searchTimer); },
  onPullDownRefresh() { this.loadCircles({ reset: true, refreshing: true }); },
  onReachBottom() { if (this.data.hasMore && !this.data.loadingMore) this.loadCircles(); },

  loadCircles(options) {
    const opts = options || {};
    const reset = !!opts.reset;
    const version = ++this.requestVersion;
    const offset = reset ? 0 : this.data.circles.length;
    this.setData({ loading: reset && !opts.refreshing, loadingMore: !reset });
    return api.adminListCircles({ keyword: this.data.keyword, status: this.data.status, limit: PAGE_SIZE, offset }).then((data) => {
      if (version !== this.requestVersion) return;
      const next = (data.circles || []).map(decorateCircle);
      const circles = reset ? next : this.data.circles.concat(next);
      this.setData({ circles, total: data.total || 0, hasMore: !!data.hasMore, loading: false, loadingMore: false });
    }).catch((error) => {
      if (version !== this.requestVersion) return;
      this.setData({ loading: false, loadingMore: false });
      wx.showToast({ title: (error && error.message) || "圈子加载失败", icon: "none" });
    }).then(() => { if (wx.stopPullDownRefresh) wx.stopPullDownRefresh(); });
  },

  onSearchInput(e) {
    const searchText = e.detail.value || "";
    this.setData({ searchText });
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => { this.setData({ keyword: searchText.trim() }); this.loadCircles({ reset: true }); }, 300);
  },
  clearSearch() { if (this.searchTimer) clearTimeout(this.searchTimer); this.setData({ searchText: "", keyword: "" }); this.loadCircles({ reset: true }); },
  selectStatus(e) { const status = e.currentTarget.dataset.key; if (status === this.data.status) return; this.setData({ status, filters: decorateFilters(status) }); this.loadCircles({ reset: true }); },
  openCircle(e) { if (!this.data.busyId) wx.navigateTo({ url: `/pages/circle-settings/index?id=${e.currentTarget.dataset.id}` }); },

  toggleStatus(e) {
    const id = e.currentTarget.dataset.id;
    const status = e.currentTarget.dataset.status;
    if (!id || this.data.busyId) return;
    this.setData({ busyId: `status:${id}` });
    api.adminUpdateCircleStatus(id, status).then(() => {
      wx.showToast({ title: status === "active" ? "圈子已解冻" : "圈子已冻结", icon: "success" });
      return this.loadCircles({ reset: true });
    }).catch((error) => wx.showToast({ title: (error && error.message) || "状态更新失败", icon: "none" })).finally(() => this.setData({ busyId: "" }));
  },

  deleteCircle(e) {
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name || "这个圈子";
    if (!id || this.data.busyId) return;
    dialog.show({ title: "物理删除圈子", content: `永久删除「${name}」后，成员关系和圈内业务将全部清除，无法恢复。`, confirmText: "删除", tone: "danger", success: (res) => {
      if (!res.confirm) return;
      this.setData({ busyId: `delete:${id}` });
      api.adminDeleteCircle(id).then(() => { wx.showToast({ title: "圈子已删除", icon: "success" }); return this.loadCircles({ reset: true }); }).catch((error) => wx.showToast({ title: (error && error.message) || "删除失败", icon: "none" })).finally(() => this.setData({ busyId: "" }));
    } });
  },
});
