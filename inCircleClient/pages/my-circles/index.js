const api = require("../../utils/api");
const memberRole = require("../../utils/memberRole");
const time = require("../../utils/time");

const PAGE_SIZE = 20;

function decorateCircle(circle) {
  return memberRole.decorateMemberRole(Object.assign({}, circle, {
    lastEnteredText: circle.lastEnteredAt ? time.displayDateTime(circle.lastEnteredAt) : "尚未进入",
  }));
}

Page({
  data: {
    loading: true,
    loadingMore: false,
    searchText: "",
    keyword: "",
    circles: [],
    total: 0,
    hasMore: false,
    switchingCircleId: "",
  },

  onLoad() {
    this.requestVersion = 0;
    this.loadCircles({ reset: true });
  },

  onUnload() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
  },

  onPullDownRefresh() {
    this.loadCircles({ reset: true, refreshing: true });
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore) this.loadCircles();
  },

  loadCircles(options) {
    const opts = options || {};
    const reset = !!opts.reset;
    const version = ++this.requestVersion;
    const offset = reset ? 0 : this.data.circles.length;
    this.setData({ loading: reset && !opts.refreshing, loadingMore: !reset });
    return api
      .listMyCircles({ keyword: this.data.keyword, limit: PAGE_SIZE, offset })
      .then((data) => {
        if (version !== this.requestVersion) return;
        const next = (data.circles || []).map(decorateCircle);
        const circles = reset ? next : this.data.circles.concat(next);
        this.setData({
          circles,
          total: Number(data.total || 0),
          hasMore: !!data.hasMore,
          loading: false,
          loadingMore: false,
        });
      })
      .catch((error) => {
        if (version !== this.requestVersion) return;
        this.setData({ loading: false, loadingMore: false });
        wx.showToast({ title: (error && error.message) || "圈子加载失败", icon: "none" });
      })
      .then(() => {
        if (wx.stopPullDownRefresh) wx.stopPullDownRefresh();
      });
  },

  onSearchInput(e) {
    const searchText = e.detail.value || "";
    this.setData({ searchText });
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.setData({ keyword: searchText.trim() });
      this.loadCircles({ reset: true });
    }, 300);
  },

  clearSearch() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.setData({ searchText: "", keyword: "" });
    this.loadCircles({ reset: true });
  },

  enterCircle(e) {
    const id = e.currentTarget.dataset.id || "";
    if (!id || this.data.switchingCircleId) return;
    this.setData({ switchingCircleId: id });
    api
      .switchCircle(id)
      .then(() => wx.switchTab({ url: "/pages/index/index" }))
      .catch((error) => wx.showToast({ title: (error && error.message) || "暂不可进入", icon: "none" }))
      .finally(() => this.setData({ switchingCircleId: "" }));
  },

  openSettings(e) {
    if (this.data.switchingCircleId) return;
    wx.navigateTo({ url: `/pages/circle-settings/index?id=${e.currentTarget.dataset.id}` });
  },
});
