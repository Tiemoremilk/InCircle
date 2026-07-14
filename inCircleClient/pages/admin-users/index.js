const api = require("../../utils/api");

const PAGE_SIZE = 20;
const FILTERS = [
  { key: "all", label: "全部" },
  { key: "active", label: "正常" },
  { key: "blocked", label: "封禁" },
  { key: "deleted", label: "已注销" },
];

function filters(active) { return FILTERS.map((item) => Object.assign({}, item, { activeClass: item.key === active ? "active" : "" })); }

Page({
  data: { loading: true, loadingMore: false, searchText: "", keyword: "", status: "all", filters: filters("all"), users: [], total: 0, hasMore: false },
  onLoad() { this.requestVersion = 0; this.loadUsers({ reset: true }); },
  onShow() { if (!this.data.loading && this.needsRefresh) { this.needsRefresh = false; this.loadUsers({ reset: true }); } },
  onUnload() { if (this.searchTimer) clearTimeout(this.searchTimer); },
  onPullDownRefresh() { this.loadUsers({ reset: true, refreshing: true }); },
  onReachBottom() { if (this.data.hasMore && !this.data.loadingMore) this.loadUsers(); },
  loadUsers(options) {
    const opts = options || {}; const reset = !!opts.reset; const version = ++this.requestVersion; const offset = reset ? 0 : this.data.users.length;
    this.setData({ loading: reset && !opts.refreshing, loadingMore: !reset });
    return api.adminListUsers({ keyword: this.data.keyword, status: this.data.status, limit: PAGE_SIZE, offset }).then((data) => {
      if (version !== this.requestVersion) return;
      const users = reset ? (data.users || []) : this.data.users.concat(data.users || []);
      this.setData({ users, total: data.total || 0, hasMore: !!data.hasMore, loading: false, loadingMore: false });
    }).catch((error) => { if (version === this.requestVersion) { this.setData({ loading: false, loadingMore: false }); wx.showToast({ title: (error && error.message) || "用户加载失败", icon: "none" }); } }).then(() => { if (wx.stopPullDownRefresh) wx.stopPullDownRefresh(); });
  },
  onSearchInput(e) { const searchText = e.detail.value || ""; this.setData({ searchText }); if (this.searchTimer) clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => { this.setData({ keyword: searchText.trim() }); this.loadUsers({ reset: true }); }, 300); },
  clearSearch() { if (this.searchTimer) clearTimeout(this.searchTimer); this.setData({ searchText: "", keyword: "" }); this.loadUsers({ reset: true }); },
  selectStatus(e) { const status = e.currentTarget.dataset.key; if (status === this.data.status) return; this.setData({ status, filters: filters(status) }); this.loadUsers({ reset: true }); },
  openUser(e) { this.needsRefresh = true; wx.navigateTo({ url: `/pages/admin-user-detail/index?id=${e.currentTarget.dataset.id}` }); },
});
