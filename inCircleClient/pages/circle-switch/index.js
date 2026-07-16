const api = require("../../utils/api");
const theme = require("../../utils/theme");
const dialog = require("../../utils/dialog");
const time = require("../../utils/time");

const DEFAULT_CIRCLE_CREATE_LIMIT = 10;
const CIRCLE_CREATE_LIMIT_MESSAGE = "每个账号最多创建 10 个圈子，冻结的圈子也会计入。请先解散一个不再使用的圈子后再创建。";

function clampChannel(value, maximum) {
  const number = Math.round(Number(value || 0));
  return Math.min(maximum, Math.max(0, number));
}

function customThemeDraft(value) {
  const rgba = theme.normalizeCustomThemeRgba(value, theme.DEFAULT_CUSTOM_THEME_RGBA);
  return { r: rgba.r, g: rgba.g, b: rgba.b, a: Math.round(rgba.a * 100) };
}

function customThemeRgba(draft) {
  const source = draft || {};
  return {
    r: clampChannel(source.r, 255),
    g: clampChannel(source.g, 255),
    b: clampChannel(source.b, 255),
    a: clampChannel(source.a, 100) / 100,
  };
}

function rgbHex(value) {
  const rgba = customThemeRgba(value);
  return `#${[rgba.r, rgba.g, rgba.b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function rgbaText(value) {
  const rgba = customThemeRgba(value);
  return `rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${rgba.a})`;
}

function customThemePreview(value) {
  const rgba = theme.normalizeCustomThemeRgba(value, theme.DEFAULT_CUSTOM_THEME_RGBA);
  const generated = theme.buildCustomTheme(rgba);
  const hex = `#${[rgba.r, rgba.g, rgba.b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
  return {
    customThemePreviewHex: hex,
    customThemeRgbText: `RGB ${rgba.r} · ${rgba.g} · ${rgba.b}`,
    customThemePreviewStyle: `background: rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${rgba.a});`,
    customThemeHeroStyle: `background: linear-gradient(135deg, ${generated.primaryDark} 0%, ${generated.primary} 68%, ${generated.accent} 160%);`,
    customThemePrimaryStyle: `background: ${generated.primary};`,
    customThemeDarkStyle: `background: ${generated.primaryDark};`,
    customThemeAccentStyle: `background: ${generated.accent};`,
    customThemeStageButtonStyle: `color: ${generated.primaryDark};`,
    customThemeAlphaStyle: `background: ${generated.pageBg}; color: ${generated.primaryDark};`,
    customThemeActionStyle: `background: linear-gradient(135deg, ${generated.primary}, ${generated.primaryDark});`,
  };
}

const DEFAULT_CUSTOM_THEME_PREVIEW = customThemePreview(theme.DEFAULT_CUSTOM_THEME_RGBA);

function decorateCircle(circle) {
  return Object.assign({}, circle, {
    lastEnteredText: circle.lastEnteredAt ? `最近进入 ${time.displayDateTime(circle.lastEnteredAt)}` : "尚未进入",
  });
}

Page({
  data: {
    loading: true,
    user: null,
    circles: [],
    currentCircle: null,
    joinedCount: 0,
    managedCount: 0,
    currentMemberCount: 0,
    hasCircles: false,
    hasCurrentCircle: false,
    circleTotal: 0,
    hasMoreCircles: false,
    isSuperAdmin: false,
    allowCustomThemeOption: true,
    ownedCircleCount: 0,
    circleCreateLimit: DEFAULT_CIRCLE_CREATE_LIMIT,
    canCreateCircle: true,
    accountBusy: false,
    passwordBusy: false,
    switchingCircle: false,
    switchingCircleId: "",
    switchingCircleName: "",
    creatingCircle: false,
    themeSaving: false,
    customThemeOpen: false,
    customThemeDraft: customThemeDraft(theme.DEFAULT_CUSTOM_THEME_RGBA),
    ...DEFAULT_CUSTOM_THEME_PREVIEW,
    showPasswordForm: false,
    currentPassword: "",
    newPassword: "",
    confirmNewPassword: "",
  },

  onLoad() {
    this.circleSwitchAlive = true;
  },

  onShow() {
    this.circleSwitchAlive = true;
    this.loadCircles();
  },

  onUnload() {
    this.circleSwitchAlive = false;
  },

  loadCircles() {
    if (this.data.switchingCircle || this.data.creatingCircle) return;
    api
      .listMyCircles({ limit: 3, offset: 0 })
      .then((data) => {
        const currentCircle = data.currentCircle || {};
        const isSuperAdmin = !!data.isSuperAdmin;
        const ownedCircleCount = Number(data.ownedCircleCount || 0);
        const circleCreateLimit = Number(data.circleCreateLimit || DEFAULT_CIRCLE_CREATE_LIMIT);
        const canCreateCircle = isSuperAdmin || (
          typeof data.canCreateCircle === "boolean"
            ? data.canCreateCircle
            : ownedCircleCount < circleCreateLimit
        );
        this.setData({
          user: data.user,
          circles: (data.circles || []).map(decorateCircle),
          currentCircle,
          joinedCount: data.joinedCount || 0,
          managedCount: data.managedCount || 0,
          currentMemberCount: data.currentMemberCount || currentCircle.memberCount || 0,
          circleTotal: data.joinedCount || data.total || 0,
          hasMoreCircles: Number(data.joinedCount || data.total || 0) > 3,
          hasCircles: Number(data.joinedCount || data.total || 0) > 0,
          hasCurrentCircle: !!(currentCircle && currentCircle.id),
          isSuperAdmin,
          ownedCircleCount,
          circleCreateLimit,
          canCreateCircle,
          loading: false,
        }, () => theme.applyPageTheme(this));
      })
      .catch((error) => {
        const message = error.message || "读取失败";
        if (/登录|绑定/.test(message)) {
          wx.redirectTo({ url: "/pages/login/index" });
          return;
        }
        this.setData({ loading: false });
        wx.showToast({
          title: message,
          icon: "none",
        });
      });
  },

  switchCircle(e) {
    if (this.data.switchingCircle || this.data.creatingCircle || this.data.accountBusy || this.data.themeSaving) return;
    const id = e.currentTarget.dataset.id;
    const target = (this.data.circles || []).find((item) => item.id === id) || {};
    this.setData({
      switchingCircle: true,
      switchingCircleId: id,
      switchingCircleName: target.name || "这个圈子",
    });
    api
      .switchCircle(id)
      .then(() => {
        wx.showToast({
          title: "已切换圈子",
          icon: "success",
        });
        wx.switchTab({ url: "/pages/index/index" });
      })
      .catch((error) => {
        this.setData({
          switchingCircle: false,
          switchingCircleId: "",
          switchingCircleName: "",
        });
        wx.showToast({
          title: error.message || "暂不可切换",
          icon: "none",
        });
      });
  },

  openSettings(e) {
    if (this.data.switchingCircle || this.data.creatingCircle || this.data.themeSaving) return;
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/circle-settings/index?id=${id}`,
    });
  },

  openAllCircles() {
    if (this.data.switchingCircle || this.data.creatingCircle || this.data.themeSaving) return;
    wx.navigateTo({ url: "/pages/my-circles/index" });
  },

  openJoin() {
    if (this.data.switchingCircle || this.data.creatingCircle || this.data.themeSaving) return;
    wx.navigateTo({
      url: "/pages/circle-join/index",
    });
  },

  showCircleCreateLimitDialog() {
    return dialog.show({
      title: "已达创建上限",
      content: CIRCLE_CREATE_LIMIT_MESSAGE,
      confirmText: "知道了",
      showCancel: false,
    }).catch(() => {});
  },

  createCircle() {
    if (this.data.switchingCircle || this.data.creatingCircle || this.data.accountBusy || this.data.themeSaving) return;
    if (!this.data.isSuperAdmin && !this.data.canCreateCircle) {
      this.showCircleCreateLimitDialog();
      return;
    }
    this.setData({ creatingCircle: true });
    api
      .createCircle({
        name: "新的熟人圈",
        slogan: "把活动、AA、投票和资料放回一个有秩序的地方。",
        notice: "欢迎加入新圈子。",
      })
      .then(() => {
        wx.showToast({
          title: "圈子已创建",
          icon: "success",
        });
        this.setData({ creatingCircle: false });
        this.loadCircles();
      })
      .catch((error) => {
        if (error && error.errCode === "CIRCLE_CREATE_LIMIT_REACHED") {
          const details = error.details || {};
          const limit = Number(details.limit || this.data.circleCreateLimit || DEFAULT_CIRCLE_CREATE_LIMIT);
          const ownedCount = Number(details.ownedCount);
          this.setData({
            ownedCircleCount: Number.isFinite(ownedCount) ? ownedCount : limit,
            circleCreateLimit: limit,
            canCreateCircle: false,
          });
          this.showCircleCreateLimitDialog();
          return;
        }
        wx.showToast({
          title: error.message || "创建失败",
          icon: "none",
        });
      })
      .finally(() => {
        this.setData({ creatingCircle: false });
      });
  },

  openHome() {
    if (this.data.switchingCircle || this.data.creatingCircle || this.data.themeSaving) return;
    if (!this.data.hasCurrentCircle) {
      wx.showToast({ title: "请先选择一个圈子", icon: "none" });
      return;
    }
    const current = this.data.currentCircle || {};
    if (!current.id) return;
    this.switchCircle({ currentTarget: { dataset: { id: current.id } } });
  },

  openAdmin() {
    if (this.data.switchingCircle || this.data.creatingCircle || this.data.themeSaving) return;
    wx.navigateTo({
      url: "/pages/admin/index",
    });
  },

  onThemeSelect(e) {
    if (this.data.themeSaving) return;
    const themeKey = String(e.currentTarget.dataset.key || "");
    if (themeKey === theme.CUSTOM_THEME_KEY) {
      this.openCustomTheme();
      return;
    }
    const previous = theme.getCurrentTheme();
    const previousCustomTheme = theme.getCustomThemeRgba();
    const preferenceToken = theme.beginPreferenceSave();
    this.setData({ themeSaving: true });
    const selected = theme.setTheme(themeKey);
    if (selected.key === previous.key) {
      theme.endPreferenceSave(preferenceToken);
      this.setData({ themeSaving: false });
      return;
    }
    Promise.all([
      api.updateTheme(selected.key),
      theme.whenThemeReady(),
    ])
      .catch((error) => {
        theme.setTheme(previous.key, previousCustomTheme);
        return theme.whenThemeReady().then(() => {
          wx.showToast({ title: (error && error.message) || "主题保存失败，已恢复", icon: "none" });
        });
      })
      .finally(() => {
        theme.endPreferenceSave(preferenceToken);
        if (this.circleSwitchAlive) this.setData({ themeSaving: false });
      });
  },

  openCustomTheme() {
    if (this.data.themeSaving) return;
    const draft = customThemeDraft(theme.getCustomThemeRgba());
    this.updateCustomThemeDraft(draft, { open: true });
  },

  updateCustomThemeDraft(draft, options) {
    const rgba = customThemeRgba(draft);
    const previewRgba = rgbaText(draft);
    const currentOptions = Array.isArray(this.data.themeOptions) ? this.data.themeOptions : [];
    const customIndex = currentOptions.findIndex((item) => item.key === theme.CUSTOM_THEME_KEY);
    const nextData = {
      customThemeOpen: options && options.open ? true : this.data.customThemeOpen,
      customThemeDraft: customThemeDraft(rgba),
      ...customThemePreview(rgba),
    };
    if (customIndex >= 0) {
      nextData[`themeOptions[${customIndex}].swatch`] = previewRgba;
    } else {
      nextData.themeOptions = theme
        .getThemeOptions(theme.getCurrentTheme().key, { includeCustom: true })
        .map((item) => item.key === theme.CUSTOM_THEME_KEY
          ? Object.assign({}, item, { swatch: previewRgba })
          : item);
    }
    this.setData(nextData);
  },

  onCustomThemeChannelChange(e) {
    if (this.data.themeSaving) return;
    const channel = String(e.currentTarget.dataset.channel || "");
    if (!["r", "g", "b", "a"].includes(channel)) return;
    const maximum = channel === "a" ? 100 : 255;
    const draft = Object.assign({}, this.data.customThemeDraft, {
      [channel]: clampChannel(e.detail.value, maximum),
    });
    this.updateCustomThemeDraft(draft);
  },

  closeCustomTheme() {
    if (this.data.themeSaving) return;
    this.setData({
      customThemeOpen: false,
      themeOptions: theme.getThemeOptions(theme.getCurrentTheme().key, { includeCustom: true }),
    });
  },

  applyCustomTheme() {
    if (this.data.themeSaving) return;
    const rgba = customThemeRgba(this.data.customThemeDraft);
    const previous = theme.getCurrentTheme();
    const previousCustomTheme = theme.getCustomThemeRgba();
    const preferenceToken = theme.beginPreferenceSave();
    this.setData({ themeSaving: true });
    theme.setTheme(theme.CUSTOM_THEME_KEY, rgba);
    Promise.all([
      api.updateTheme(theme.CUSTOM_THEME_KEY, rgba),
      theme.whenThemeReady(),
    ])
      .then((results) => {
        const result = results[0];
        const saved = (result && result.customTheme) || rgba;
        theme.setTheme(theme.CUSTOM_THEME_KEY, saved);
        return theme.whenThemeReady().then(() => {
          if (this.circleSwitchAlive) {
            this.setData({
              user: Object.assign({}, this.data.user || {}, { themeKey: theme.CUSTOM_THEME_KEY, customTheme: saved }),
              customThemeOpen: false,
            });
          }
        });
      })
      .catch((error) => {
        theme.setTheme(previous.key, previousCustomTheme);
        return theme.whenThemeReady().then(() => {
          wx.showToast({ title: (error && error.message) || "主题保存失败，已恢复", icon: "none" });
        });
      })
      .finally(() => {
        theme.endPreferenceSave(preferenceToken);
        if (this.circleSwitchAlive) this.setData({ themeSaving: false });
      });
  },

  stopEvent() {},

  togglePasswordForm() {
    if (this.data.switchingCircle || this.data.creatingCircle || this.data.accountBusy) return;
    this.setData({
      showPasswordForm: !this.data.showPasswordForm,
      currentPassword: "",
      newPassword: "",
      confirmNewPassword: "",
    });
  },

  onCurrentPasswordInput(e) {
    this.setData({ currentPassword: e.detail.value || "" });
  },

  onNewPasswordInput(e) {
    this.setData({ newPassword: e.detail.value || "" });
  },

  onConfirmNewPasswordInput(e) {
    this.setData({ confirmNewPassword: e.detail.value || "" });
  },

  changePassword() {
    if (this.data.passwordBusy || this.data.switchingCircle || this.data.creatingCircle) return;
    const currentPassword = this.data.currentPassword || "";
    const newPassword = this.data.newPassword || "";
    const confirmNewPassword = this.data.confirmNewPassword || "";
    if (!currentPassword) {
      wx.showToast({ title: "请输入当前密码", icon: "none" });
      return;
    }
    if (newPassword.length < 8 || newPassword.length > 64 || /\s/.test(newPassword) || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
      wx.showToast({ title: "新密码需 8-64 位并包含字母和数字", icon: "none" });
      return;
    }
    if (newPassword !== confirmNewPassword) {
      wx.showToast({ title: "两次密码不一致", icon: "none" });
      return;
    }
    this.setData({ passwordBusy: true });
    api
      .changePassword({ currentPassword, newPassword })
      .then(() => {
        wx.showToast({ title: "密码已修改", icon: "success" });
        this.setData({
          showPasswordForm: false,
          currentPassword: "",
          newPassword: "",
          confirmNewPassword: "",
        });
      })
      .catch((error) => {
        wx.showToast({ title: error.message || "修改失败", icon: "none" });
      })
      .finally(() => {
        this.setData({ passwordBusy: false });
      });
  },

  logoutAccount() {
    if (this.data.accountBusy || this.data.switchingCircle || this.data.creatingCircle) return;
    const currentTheme = theme.getCurrentTheme();
    dialog.show({
      title: "退出登录",
      content: "退出后需要重新登录才能进入圈子。",
      confirmText: "退出",
      confirmColor: currentTheme.primary,
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ accountBusy: true });
        api
          .logout()
          .then(() => {
            wx.showToast({ title: "已退出登录", icon: "success" });
            wx.redirectTo({ url: "/pages/login/index" });
          })
          .catch((error) => {
            wx.showToast({ title: error.message || "退出失败", icon: "none" });
          })
          .finally(() => {
            this.setData({ accountBusy: false });
          });
      },
    });
  },

  openLegal(e) {
    const type = e.currentTarget.dataset.type === "privacy" ? "privacy" : "terms";
    wx.navigateTo({ url: `/pages/legal/index?type=${type}` });
  },

  deleteAccount() {
    if (this.data.accountBusy || this.data.switchingCircle || this.data.creatingCircle) return;
    dialog.show({
      title: "注销账号",
      content: "注销后会退出所有圈子并清空账号资料，历史活动和账单仅保留必要引用。",
      confirmText: "注销",
      confirmColor: "#b34a34",
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ accountBusy: true });
        api
          .deleteAccount()
          .then(() => {
            wx.showToast({ title: "账号已注销", icon: "success" });
            wx.redirectTo({ url: "/pages/login/index" });
          })
          .catch((error) => {
            wx.showToast({ title: error.message || "注销失败", icon: "none" });
          })
          .finally(() => {
            this.setData({ accountBusy: false });
          });
      },
    });
  },
});
