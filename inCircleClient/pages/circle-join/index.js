const api = require("../../utils/api");

Page({
  data: {
    loading: true,
    joinCode: "",
    circle: null,
    hasPreview: false,
    joining: false,
    previewing: false,
    joinButtonText: "申请加入",
  },

  onLoad(options) {
    const scene = options && options.scene ? decodeURIComponent(options.scene) : "";
    const code = (options && options.code) || scene || "";
    this.setData({ joinCode: this.normalizeCode(code) });
    this.loadPreview();
  },

  normalizeCode(value) {
    return String(value || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 8);
  },

  loadPreview() {
    if (!this.data.joinCode) {
      this.setData({
        circle: null,
        hasPreview: false,
        loading: false,
      });
      return;
    }
    this.setData({ previewing: true });
    api
      .getJoinPreview(this.data.joinCode)
      .then((preview) => {
        this.setData({
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
    });
  },

  previewCode() {
    if (this.data.previewing || this.data.joining) return;
    if (!this.data.joinCode) {
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
    if (!this.data.joinCode) {
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
      .joinCircle(this.data.joinCode)
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
          const codeQuery = this.data.joinCode ? `?code=${this.data.joinCode}` : "";
          wx.redirectTo({ url: `/pages/login/index${codeQuery}` });
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
