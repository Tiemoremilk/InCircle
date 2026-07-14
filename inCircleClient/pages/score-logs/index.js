const api = require("../../utils/api");
const time = require("../../utils/time");

const PAGE_SIZE = 20;

function displayLogTime(log) {
  return time.displayDateTime(log.createdAt, log.createdAtMs, log.id);
}

function decorateLog(log) {
  const delta = Number(log.delta || 0);
  return Object.assign({}, log, {
    typeText: log.type || "积分变动",
    reasonText: log.reason || "已记录",
    createdAtText: displayLogTime(log),
    avatar: log.avatar || log.avatarUrl || log.memberAvatar || "/images/avatar.png",
    deltaClass: delta >= 0 ? "plus" : "minus",
    deltaText: delta >= 0 ? `+${delta}` : String(delta),
  });
}

function decorateFilters(members, activeMemberId) {
  const filters = [
    {
      id: "",
      name: "全部成员",
    },
  ].concat(members || []);
  return filters.map((item) => {
    const id = item.memberCardId || item.id || "";
    return Object.assign({}, item, {
      id,
      memberCardId: id,
      activeClass: String(id) === String(activeMemberId || "") ? "active" : "",
    });
  });
}

function memberNameById(members, memberId) {
  const target = (members || []).find((member) => String(member.memberCardId || member.id || "") === String(memberId || ""));
  return target ? target.name || target.nickname || "该成员" : "该成员";
}

function lockedPageTitle(members, memberId) {
  return `${memberNameById(members, memberId)}的积分流水`;
}

function decorateScopeTabs(entryMemberId, activeMemberId, members) {
  if (!entryMemberId) return [];
  const memberName = memberNameById(members, entryMemberId);
  return [
    { key: "member", label: `${memberName}的流水`, memberId: entryMemberId },
    { key: "all", label: "全圈动态", memberId: "" },
  ].map((item) =>
    Object.assign({}, item, {
      activeClass:
        (item.key === "member" && String(activeMemberId || "") === String(entryMemberId)) ||
        (item.key === "all" && !activeMemberId)
          ? "active"
          : "",
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
    activeMemberId: "",
    entryMemberId: "",
    lockMember: false,
    pageTitle: "圈内积分流水",
    searchPlaceholder: "搜索成员、原因或类型",
    emptyCopy: "换个成员或关键字再试试。",
    showScopeTabs: false,
    scopeTabs: [],
    members: [],
    filterOptions: decorateFilters([], ""),
    logs: [],
    total: 0,
    hasMore: false,
  },

  onLoad(options) {
    const memberId = options && options.memberId ? options.memberId : "";
    const lockMember = !!(options && String(options.lockMember || "") === "1");
    if (memberId) {
      this.setData({
        activeMemberId: memberId,
        entryMemberId: memberId,
        lockMember,
        pageTitle: lockMember ? "该成员的积分流水" : "圈内积分流水",
        searchPlaceholder: lockMember ? "搜索原因或类型" : "搜索成员、原因或类型",
        emptyCopy: lockMember ? "换个关键字再试试。" : "换个成员或关键字再试试。",
        showScopeTabs: !lockMember,
        scopeTabs: decorateScopeTabs(memberId, memberId, []),
      });
    }
    this.loadLogs({ reset: true, memberId });
  },

  onPullDownRefresh() {
    this.loadLogs({ reset: true, refreshing: true });
  },

  loadLogs(options) {
    const opts = options || {};
    const reset = !!opts.reset;
    if (this.data.loadingMore && !reset) return;
    const offset = reset ? 0 : this.data.logs.length;
    const keyword = Object.prototype.hasOwnProperty.call(opts, "keyword") ? opts.keyword : this.data.keyword;
    let memberId = Object.prototype.hasOwnProperty.call(opts, "memberId") ? opts.memberId : this.data.activeMemberId;
    if (this.data.lockMember) memberId = this.data.entryMemberId;
    this.setData({
      loading: reset && !opts.refreshing,
      refreshing: !!opts.refreshing,
      loadingMore: !reset,
    });
    api
      .listScoreLogs({
        keyword,
        memberId,
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
          members: data.members || [],
          activeMemberId: memberId,
          keyword,
          filterOptions: decorateFilters(data.members || [], memberId),
          scopeTabs: decorateScopeTabs(this.data.entryMemberId, memberId, data.members || []),
          pageTitle: this.data.lockMember ? lockedPageTitle(data.members || [], this.data.entryMemberId) : "圈内积分流水",
          searchPlaceholder: this.data.lockMember ? "搜索原因或类型" : "搜索成员、原因或类型",
          emptyCopy: this.data.lockMember ? "换个关键字再试试。" : "换个成员或关键字再试试。",
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
          title: (error && error.message) || "积分动态加载失败",
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
    const keyword = String(this.data.searchText || "").trim();
    this.setData({ keyword });
    this.loadLogs({ reset: true, keyword });
  },

  clearSearch() {
    if (!this.data.searchText && !this.data.keyword) return;
    this.setData({
      searchText: "",
      keyword: "",
    });
    this.loadLogs({ reset: true, keyword: "" });
  },

  selectMember(e) {
    if (this.data.lockMember) return;
    const id = e.currentTarget.dataset.memberId || "";
    if (String(id) === String(this.data.activeMemberId || "")) return;
    this.setData({
      activeMemberId: id,
      filterOptions: decorateFilters(this.data.members, id),
      scopeTabs: decorateScopeTabs(this.data.entryMemberId, id, this.data.members),
    });
    this.loadLogs({ reset: true, memberId: id });
  },

  selectScope(e) {
    if (this.data.lockMember) return;
    const id = e.currentTarget.dataset.memberId || "";
    if (String(id) === String(this.data.activeMemberId || "")) return;
    this.setData({
      activeMemberId: id,
      filterOptions: decorateFilters(this.data.members, id),
      scopeTabs: decorateScopeTabs(this.data.entryMemberId, id, this.data.members),
    });
    this.loadLogs({ reset: true, memberId: id });
  },

  loadMore() {
    if (!this.data.hasMore || this.data.loadingMore) return;
    this.loadLogs();
  },

  openMember(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({
      url: `/pages/member-detail/index?id=${id}`,
    });
  },

  onAvatarError(e) {
    const index = e.currentTarget.dataset.index;
    if (typeof index === "undefined") return;
    const key = `logs[${index}].avatar`;
    this.setData({
      [key]: "/images/avatar.png",
    });
  },
});
