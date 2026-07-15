const api = require("../../utils/api");
const invite = require("../../utils/invite");

Page({
  data: {
    loading: true,
    joinCode: "",
    inviteToken: "",
    circle: null,
    hasPreview: false,
    joining: false,
    previewing: false,
    joinButtonText: "申请加入",
  },

  onLoad(options) {
    const credential = invite.parseInviteOptions(options);
    this.setData({
      joinCode: credential.joinCode,
      inviteToken: credential.inviteToken,
    });
    this.loadPreview();
  },

  normalizeCode(value) {
    return invite.normalizeJoinCode(value);
  },

  hasInviteCredential() {
    return !!(this.data.inviteToken || this.data.joinCode);
  },

  invitePayload() {
    return this.data.inviteToken
      ? { joinCode: "", inviteToken: this.data.inviteToken }
      : { joinCode: this.data.joinCode, inviteToken: "" };
  },

  loginInviteQuery() {
    return invite.inviteQuery(this.data.joinCode, this.data.inviteToken);
  },

  loadPreview() {
    if (!this.hasInviteCredential()) {
      this.setData({
        circle: null,
        hasPreview: false,
        loading: false,
      });
      return;
    }
    this.setData({ previewing: true });
    api
      .getJoinPreview(this.invitePayload())
      .then((preview) => {
        this.setData({
          joinCode: preview.joinCode || this.data.joinCode,
          circle: preview.circle,
          hasPreview: !!preview.circle,
          loading: false,
        });
      })
      .catch((error) => {
        this.setData({
          circle: null,
          hasPreview: false,
          loading: false,
        });
        wx.showToast({
          title: error.message || "预览失败",
          icon: "none",
        });
      })
      .finally(() => {
        this.setData({ previewing: false });
      });
  },

  onCodeInput(e) {
    this.setData({
      joinCode: this.normalizeCode(e.detail.value),
      inviteToken: "",
    });
  },

  previewCode() {
    if (this.data.previewing || this.data.joining) return;
    if (!this.hasInviteCredential()) {
      wx.showToast({
        title: "请输入邀请码",
        icon: "none",
      });
      return;
    }
    this.loadPreview();
  },

  joinCircle() {
    if (this.data.joining || this.data.previewing) return;
    if (!this.hasInviteCredential()) {
      wx.showToast({
        title: "请输入邀请码",
        icon: "none",
      });
      return;
    }
    this.setData({
      joining: true,
      joinButtonText: "加入中...",
    });
    api
      .joinCircle(this.invitePayload())
      .then(() => {
        wx.showToast({
          title: "已加入圈子",
          icon: "success",
        });
        wx.switchTab({
          url: "/pages/index/index",
        });
      })
      .catch((error) => {
        const message = error.message || "加入失败";
        if (/登录|绑定/.test(message)) {
          wx.redirectTo({ url: `/pages/login/index${this.loginInviteQuery()}` });
          return;
        }
        wx.showToast({
          title: message,
          icon: "none",
        });
      })
      .finally(() => {
        this.setData({
          joining: false,
          joinButtonText: "申请加入",
        });
      });
  },

  openMyCircles() {
    if (this.data.joining || this.data.previewing) return;
    wx.redirectTo({
      url: "/pages/circle-switch/index",
    });
  },
});
