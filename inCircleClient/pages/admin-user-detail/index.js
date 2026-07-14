const api = require("../../utils/api");
const time = require("../../utils/time");
const dialog = require("../../utils/dialog");

function dateText(value) { return value ? time.displayDateTime(value) : "未记录"; }
function decorate(data) {
  const source = data || {}; const user = source.user || {};
  return {
    user: Object.assign({}, user, { createdAtText: dateText(user.createdAt), lastLoginAtText: dateText(user.lastLoginAt), blockedAtText: dateText(user.blockedAt), wechatUnboundAtText: dateText(user.wechatUnboundAt) }),
    circles: (source.circles || []).map((circle) => Object.assign({}, circle, { joinedAtText: dateText(circle.joinedAt), relationText: circle.status === "active" ? "有效成员" : circle.status === "removed" ? "已移除" : "已退出" })),
    deleteImpact: source.deleteImpact || { ownedCircleCount: 0, membershipCount: 0 },
  };
}

Page({
  data: { loading: true, user: null, circles: [], deleteImpact: null, busyAction: "" },
  onLoad(options) { this.userId = (options && options.id) || ""; this.loadUser(); },
  loadUser() { return api.adminGetUser(this.userId).then((data) => this.setData(Object.assign(decorate(data), { loading: false }))).catch((error) => { this.setData({ loading: false }); wx.showToast({ title: (error && error.message) || "用户详情加载失败", icon: "none" }); }); },
  openCircle(e) { const id = e.currentTarget.dataset.id; if (id && !this.data.busyAction) wx.navigateTo({ url: `/pages/circle-settings/index?id=${id}` }); },
  toggleBlocked() {
    const user = this.data.user || {}; if (!user.canManage || this.data.busyAction) return;
    const blocking = user.status !== "blocked";
    dialog.show({ title: blocking ? "封禁用户" : "解除封禁", content: blocking ? "封禁后该用户会立即退出登录，无法进入圈子、上传图片或使用 AI；其名下圈子继续运行。" : "解封只恢复登录资格，不会自动登录。", confirmText: blocking ? "封禁" : "解封", tone: blocking ? "danger" : "default", success: (res) => {
      if (!res.confirm) return; this.setData({ busyAction: "status" }); api.adminUpdateUserStatus(this.userId, blocking ? "blocked" : "active", "超管手动封禁").then((data) => { this.setData(decorate(data)); wx.showToast({ title: blocking ? "用户已封禁" : "用户已解封", icon: "success" }); }).catch((error) => wx.showToast({ title: (error && error.message) || "操作失败", icon: "none" })).finally(() => this.setData({ busyAction: "" }));
    } });
  },
  unbindWechat() {
    const user = this.data.user || {}; if (!user.canManage || !user.wechatBound || this.data.busyAction) return;
    dialog.show({ title: "解绑微信", content: "解绑会立即撤销旧微信的登录状态。账号密码和圈子数据保留，用户可在新微信中使用原账号密码重新绑定。", confirmText: "确认解绑", tone: "warning", success: (res) => {
      if (!res.confirm) return; this.setData({ busyAction: "unbind" }); api.adminUnbindUserWechat(this.userId).then((data) => { this.setData(decorate(data)); wx.showToast({ title: "微信已解绑", icon: "success" }); }).catch((error) => wx.showToast({ title: (error && error.message) || "解绑失败", icon: "none" })).finally(() => this.setData({ busyAction: "" }));
    } });
  },
  deleteUser() {
    const user = this.data.user || {}; const impact = this.data.deleteImpact || {}; if (!user.canManage || this.data.busyAction) return;
    dialog.show({ title: "物理删除用户", content: `将永久删除该账号、${impact.ownedCircleCount || 0} 个名下圈子及对应业务数据。用户在其他圈子的个人记录也会移除，操作不能恢复。`, confirmText: "永久删除", tone: "danger", verificationText: user.confirmationTarget, verificationLabel: `请输入完整账号：${user.confirmationTarget}`, verificationPlaceholder: user.confirmationTarget, success: (res) => {
      if (!res.confirm) return; this.setData({ busyAction: "delete" }); api.adminDeleteUser(this.userId, res.content || "").then(() => { wx.showToast({ title: "用户已删除", icon: "success" }); setTimeout(() => wx.navigateBack(), 300); }).catch((error) => wx.showToast({ title: (error && error.message) || "删除失败", icon: "none" })).finally(() => this.setData({ busyAction: "" }));
    } });
  },
});
