const api = require("../../utils/api");
const toolIntent = require("../../utils/toolIntent");

function hasItem(item) {
  return !!(item && item.id);
}

function decorateCheckin(checkin) {
  if (!checkin) return checkin;
  const done = Math.max(0, Number(checkin.done || 0));
  const total = Math.max(0, Number(checkin.total || checkin.targetCount || 0));
  const rawPercent = total ? Math.round((done / total) * 100) : 0;
  const progressPercent = Math.max(done > 0 ? 8 : 0, Math.min(100, rawPercent));
  return Object.assign({}, checkin, {
    progressPercent,
    statusText: checkin.checked ? "已打卡" : "待打卡",
    statusClass: checkin.checked ? "is-complete" : "is-pending",
  });
}

function decorateHome(home) {
  const safeHome = home || {};
  const circle = safeHome.circle || {};
  return Object.assign({}, safeHome, {
    circle: Object.assign({}, circle, {
      slogan: circle.slogan || "把活动、AA、投票和资料放回一个有秩序的地方。",
      notice: circle.notice || "还没有圈内公告，圈主可以在圈子设置里补充。",
      stats: circle.stats || [],
    }),
    hasRecentActivity: hasItem(safeHome.recentActivity),
    hasPendingVote: hasItem(safeHome.pendingVote),
    hasPendingBill: hasItem(safeHome.pendingBill),
    hasCheckin: hasItem(safeHome.todayCheckin),
    todayCheckin: decorateCheckin(safeHome.todayCheckin),
    hasPinnedDoc: hasItem(safeHome.pinnedDoc),
    leaderboard: safeHome.leaderboard || [],
    monthlyHonors: safeHome.monthlyHonors || [],
  });
}

Page({
  data: {
    loading: true,
    home: null,
    isSuperAdmin: false,
  },

  onShow() {
    this.loadHome();
  },

  loadHome() {
    api
      .getHome()
      .then((home) => {
        const decoratedHome = decorateHome(home);
        this.setData({
          home: decoratedHome,
          isSuperAdmin: !!decoratedHome.isSuperAdmin,
          loading: false,
        });
      })
      .catch((error) => {
        const message = error.message || "读取失败";
        if (["AUTH_REQUIRED", "TOKEN_INVALID", "TOKEN_EXPIRED", "TOKEN_REVOKED"].includes(error.errCode) || /登录|绑定/.test(message)) {
          wx.redirectTo({ url: "/pages/login/index" });
          return;
        }
        if (["CIRCLE_REQUIRED", "CIRCLE_NOT_FOUND", "NOT_IN_CIRCLE"].includes(error.errCode) || /圈子/.test(message)) {
          wx.navigateTo({ url: "/pages/circle-switch/index" });
          return;
        }
        this.setData({ loading: false });
        wx.showToast({
          title: message,
          icon: "none",
        });
      });
  },

  switchTab(e) {
    const dataset = e.currentTarget.dataset || {};
    if (dataset.tab === "tools" && dataset.tool) toolIntent.setToolIntent(dataset.tool);
    wx.switchTab({
      url: `/pages/${dataset.tab}/index`,
    });
  },

  openRecentActivity() {
    const activity = this.data.home && this.data.home.recentActivity;
    if (!activity) return;
    wx.navigateTo({
      url: `/pages/activity-detail/index?id=${activity.id}`,
    });
  },

  openPendingVote() {
    const vote = this.data.home && this.data.home.pendingVote;
    if (!vote) return;
    wx.navigateTo({
      url: `/pages/vote-detail/index?id=${vote.id}`,
    });
  },

  openPendingBill() {
    const bill = this.data.home && this.data.home.pendingBill;
    if (!bill) return;
    wx.navigateTo({
      url: `/pages/bill-detail/index?id=${bill.id}`,
    });
  },

  openTodayCheckin() {
    const checkin = this.data.home && this.data.home.todayCheckin;
    if (!checkin) return;
    wx.navigateTo({
      url: `/pages/checkin-detail/index?id=${checkin.id}`,
    });
  },

  openPinnedDoc() {
    const doc = this.data.home && this.data.home.pinnedDoc;
    if (!doc) return;
    wx.navigateTo({
      url: `/pages/doc-detail/index?id=${doc.id}`,
    });
  },

  openMyCard() {
    const card = this.data.home && this.data.home.myCard;
    if (!card) return;
    wx.navigateTo({
      url: `/pages/member-detail/index?id=${card.id}`,
    });
  },

  openMember(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({
      url: `/pages/member-detail/index?id=${id}`,
    });
  },

  openCircleSwitch() {
    wx.navigateTo({
      url: "/pages/circle-switch/index",
    });
  },

  openCircleSettings() {
    const circle = this.data.home && this.data.home.circle;
    wx.navigateTo({
      url: `/pages/circle-settings/index?id=${circle.id}`,
    });
  },

  openAdmin() {
    wx.navigateTo({
      url: "/pages/admin/index",
    });
  },

  onShareAppMessage() {
    const circle = this.data.home && this.data.home.circle;
    return {
      title: circle ? `${circle.name}：本周有局，来表态` : "InCircle 小圈约局工具",
      path: "/pages/index/index",
    };
  },
});
