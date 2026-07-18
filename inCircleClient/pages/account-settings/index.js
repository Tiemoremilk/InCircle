const api = require("../../utils/api");
const dialog = require("../../utils/dialog");
const theme = require("../../utils/theme");
const time = require("../../utils/time");

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

function decorateSession(item) {
  const session = item || {};
  return Object.assign({}, session, {
    lastLoginText: time.displayDateTime(session.lastLoginAt) || "时间未知",
    addressText: session.loginAddress && session.loginAddress !== "未知地址"
      ? session.loginAddress
      : "地址暂不可用",
    statusClass: session.current ? "current" : session.canRevoke ? "active" : "inactive",
  });
}

const DEFAULT_CUSTOM_THEME_PREVIEW = customThemePreview(theme.DEFAULT_CUSTOM_THEME_RGBA);

Page({
  data: {
    loading: true,
    loadError: "",
    user: {},
    isSuperAdmin: false,
    verifyWechatOnLogin: true,
    verificationBusy: false,
    verificationSheetOpen: false,
    verificationPassword: "",
    sessions: [],
    activeSessionCount: 0,
    sessionBusyId: "",
    accountBusy: false,
    passwordBusy: false,
    showPasswordForm: false,
    currentPassword: "",
    newPassword: "",
    confirmNewPassword: "",
    themeSaving: false,
    allowCustomThemeOption: true,
    themeOptions: [],
    currentThemeName: "",
    customThemeOpen: false,
    customThemeDraft: customThemeDraft(theme.DEFAULT_CUSTOM_THEME_RGBA),
    ...DEFAULT_CUSTOM_THEME_PREVIEW,
  },

  onLoad() {
    this.accountSettingsAlive = true;
    this.refreshThemeOptions();
  },

  onShow() {
    this.accountSettingsAlive = true;
    this.loadSettings();
  },

  onUnload() {
    this.accountSettingsAlive = false;
  },

  refreshThemeOptions() {
    const current = theme.getCurrentTheme();
    this.setData({
      themeOptions: theme.getThemeOptions(current.key, { includeCustom: true }),
      currentThemeName: current.name || "当前主题",
    });
  },

  loadSettings(options) {
    if (this.data.accountBusy || this.data.verificationBusy) return Promise.resolve();
    if (options && options.loading) this.setData({ loading: true, loadError: "" });
    return api.getAccountSettings({ force: !!(options && options.force) })
      .then((data) => {
        if (!this.accountSettingsAlive) return;
        const sessions = (data.sessions || []).map(decorateSession);
        this.setData({
          loading: false,
          loadError: "",
          user: data.user || {},
          isSuperAdmin: !!data.isSuperAdmin,
          verifyWechatOnLogin: data.verifyWechatOnLogin !== false,
          sessions,
          activeSessionCount: sessions.filter((item) => item.current || item.canRevoke).length,
        }, () => theme.applyPageTheme(this));
        this.refreshThemeOptions();
      })
      .catch((error) => {
        if (!this.accountSettingsAlive) return;
        this.setData({
          loading: false,
          loadError: (error && error.message) || "账号设置读取失败",
        });
      });
  },

  retryLoad() {
    this.loadSettings({ force: true, loading: true });
  },

  refreshSettings() {
    if (this.isBusy()) return;
    this.loadSettings({ force: true });
  },

  openAdmin() {
    if (!this.data.isSuperAdmin || this.isBusy()) return;
    wx.navigateTo({ url: "/pages/admin/index" });
  },

  isBusy() {
    return !!(
      this.data.accountBusy
      || this.data.passwordBusy
      || this.data.verificationBusy
      || this.data.themeSaving
      || this.data.sessionBusyId
    );
  },

  onWechatVerificationChange(e) {
    if (this.isBusy()) {
      this.setData({ verifyWechatOnLogin: this.data.verifyWechatOnLogin });
      return;
    }
    const enabled = !!e.detail.value;
    if (enabled === this.data.verifyWechatOnLogin) return;
    if (!enabled) {
      this.setData({
        verifyWechatOnLogin: true,
        verificationSheetOpen: true,
        verificationPassword: "",
      });
      return;
    }
    this.setData({ verificationBusy: true });
    api.updateWechatLoginVerification(true)
      .then(() => {
        this.setData({ verifyWechatOnLogin: true });
        wx.showToast({ title: "微信校验已开启", icon: "success" });
      })
      .catch((error) => {
        this.setData({ verifyWechatOnLogin: false });
        wx.showToast({ title: (error && error.message) || "开启失败", icon: "none" });
      })
      .finally(() => {
        if (this.accountSettingsAlive) this.setData({ verificationBusy: false });
      });
  },

  onVerificationPasswordInput(e) {
    this.setData({ verificationPassword: e.detail.value || "" });
  },

  closeVerificationSheet() {
    if (this.data.verificationBusy) return;
    this.setData({ verificationSheetOpen: false, verificationPassword: "" });
  },

  confirmDisableWechatVerification() {
    if (this.data.verificationBusy) return;
    const currentPassword = String(this.data.verificationPassword || "");
    if (!currentPassword) {
      wx.showToast({ title: "请输入当前密码", icon: "none" });
      return;
    }
    this.setData({ verificationBusy: true });
    api.updateWechatLoginVerification(false, currentPassword)
      .then(() => {
        this.setData({
          verifyWechatOnLogin: false,
          verificationSheetOpen: false,
          verificationPassword: "",
        });
        wx.showToast({ title: "已关闭微信校验", icon: "success" });
      })
      .catch((error) => {
        wx.showToast({ title: (error && error.message) || "设置失败", icon: "none" });
      })
      .finally(() => {
        if (this.accountSettingsAlive) this.setData({ verificationBusy: false });
      });
  },

  revokeSession(e) {
    if (this.isBusy()) return;
    const sessionId = String(e.currentTarget.dataset.id || "");
    const target = (this.data.sessions || []).find((item) => item.id === sessionId);
    if (!target || !target.canRevoke) return;
    dialog.show({
      title: "退出这台设备",
      content: `“${target.deviceName}”将在下一次请求时退出登录，需要重新输入账号密码。`,
      cancelText: "暂不退出",
      confirmText: "确认退出",
      tone: "danger",
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ sessionBusyId: sessionId });
        api.revokeLoginSession(sessionId)
          .then((data) => {
            const sessions = (data.sessions || []).map(decorateSession);
            this.setData({
              sessions,
              activeSessionCount: sessions.filter((item) => item.current || item.canRevoke).length,
            });
            wx.showToast({ title: "设备已退出", icon: "success" });
          })
          .catch((error) => {
            wx.showToast({ title: (error && error.message) || "退出设备失败", icon: "none" });
          })
          .finally(() => {
            if (this.accountSettingsAlive) this.setData({ sessionBusyId: "" });
          });
      },
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
    Promise.all([api.updateTheme(selected.key), theme.whenThemeReady()])
      .then(() => this.refreshThemeOptions())
      .catch((error) => {
        theme.setTheme(previous.key, previousCustomTheme);
        return theme.whenThemeReady().then(() => {
          wx.showToast({ title: (error && error.message) || "主题保存失败，已恢复", icon: "none" });
        });
      })
      .finally(() => {
        theme.endPreferenceSave(preferenceToken);
        if (this.accountSettingsAlive) this.setData({ themeSaving: false });
      });
  },

  openCustomTheme() {
    if (this.data.themeSaving) return;
    this.updateCustomThemeDraft(customThemeDraft(theme.getCustomThemeRgba()), { open: true });
  },

  updateCustomThemeDraft(draft, options) {
    const rgba = customThemeRgba(draft);
    const currentOptions = Array.isArray(this.data.themeOptions) ? this.data.themeOptions : [];
    const customIndex = currentOptions.findIndex((item) => item.key === theme.CUSTOM_THEME_KEY);
    const nextData = {
      customThemeOpen: options && options.open ? true : this.data.customThemeOpen,
      customThemeDraft: customThemeDraft(rgba),
      ...customThemePreview(rgba),
    };
    const previewRgba = `rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${rgba.a})`;
    if (customIndex >= 0) nextData[`themeOptions[${customIndex}].swatch`] = previewRgba;
    else nextData.themeOptions = theme.getThemeOptions(theme.getCurrentTheme().key, { includeCustom: true });
    this.setData(nextData);
  },

  onCustomThemeChannelChange(e) {
    if (this.data.themeSaving) return;
    const channel = String(e.currentTarget.dataset.channel || "");
    if (["r", "g", "b", "a"].indexOf(channel) === -1) return;
    const maximum = channel === "a" ? 100 : 255;
    this.updateCustomThemeDraft(Object.assign({}, this.data.customThemeDraft, {
      [channel]: clampChannel(e.detail.value, maximum),
    }));
  },

  closeCustomTheme() {
    if (this.data.themeSaving) return;
    this.setData({ customThemeOpen: false });
    this.refreshThemeOptions();
  },

  applyCustomTheme() {
    if (this.data.themeSaving) return;
    const rgba = customThemeRgba(this.data.customThemeDraft);
    const previous = theme.getCurrentTheme();
    const previousCustomTheme = theme.getCustomThemeRgba();
    const preferenceToken = theme.beginPreferenceSave();
    this.setData({ themeSaving: true });
    theme.setTheme(theme.CUSTOM_THEME_KEY, rgba);
    Promise.all([api.updateTheme(theme.CUSTOM_THEME_KEY, rgba), theme.whenThemeReady()])
      .then((results) => {
        const saved = (results[0] && results[0].customTheme) || rgba;
        theme.setTheme(theme.CUSTOM_THEME_KEY, saved);
        return theme.whenThemeReady().then(() => {
          if (!this.accountSettingsAlive) return;
          this.setData({ customThemeOpen: false });
          this.refreshThemeOptions();
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
        if (this.accountSettingsAlive) this.setData({ themeSaving: false });
      });
  },

  togglePasswordForm() {
    if (this.isBusy()) return;
    this.setData({
      showPasswordForm: !this.data.showPasswordForm,
      currentPassword: "",
      newPassword: "",
      confirmNewPassword: "",
    });
  },

  onCurrentPasswordInput(e) { this.setData({ currentPassword: e.detail.value || "" }); },
  onNewPasswordInput(e) { this.setData({ newPassword: e.detail.value || "" }); },
  onConfirmNewPasswordInput(e) { this.setData({ confirmNewPassword: e.detail.value || "" }); },

  changePassword() {
    if (this.isBusy()) return;
    const currentPassword = String(this.data.currentPassword || "");
    const newPassword = String(this.data.newPassword || "");
    if (!currentPassword) {
      wx.showToast({ title: "请输入当前密码", icon: "none" });
      return;
    }
    if (newPassword.length < 8 || newPassword.length > 64 || /\s/.test(newPassword) || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
      wx.showToast({ title: "新密码需 8-64 位并包含字母和数字", icon: "none" });
      return;
    }
    if (newPassword !== this.data.confirmNewPassword) {
      wx.showToast({ title: "两次密码不一致", icon: "none" });
      return;
    }
    this.setData({ passwordBusy: true });
    api.changePassword({ currentPassword, newPassword })
      .then(() => {
        this.setData({
          showPasswordForm: false,
          currentPassword: "",
          newPassword: "",
          confirmNewPassword: "",
        });
        wx.showToast({ title: "密码已修改", icon: "success" });
        this.loadSettings({ force: true });
      })
      .catch((error) => wx.showToast({ title: (error && error.message) || "修改失败", icon: "none" }))
      .finally(() => {
        if (this.accountSettingsAlive) this.setData({ passwordBusy: false });
      });
  },

  openLegal(e) {
    const type = e.currentTarget.dataset.type === "privacy" ? "privacy" : "terms";
    wx.navigateTo({ url: `/pages/legal/index?type=${type}` });
  },

  logoutAccount() {
    if (this.isBusy()) return;
    dialog.show({
      title: "退出当前设备",
      content: "只会结束这台设备的登录，其他设备不受影响。",
      cancelText: "暂不退出",
      confirmText: "确认退出",
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ accountBusy: true });
        api.logout()
          .then(() => wx.reLaunch({ url: "/pages/login/index" }))
          .catch((error) => wx.showToast({ title: (error && error.message) || "退出失败", icon: "none" }))
          .finally(() => {
            if (this.accountSettingsAlive) this.setData({ accountBusy: false });
          });
      },
    });
  },

  deleteAccount() {
    if (this.isBusy()) return;
    dialog.show({
      title: "注销账号",
      content: "注销会退出全部设备并清空账号资料；如果仍是圈主，需要先解散名下圈子。",
      cancelText: "暂不注销",
      confirmText: "确认注销",
      tone: "danger",
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ accountBusy: true });
        api.deleteAccount()
          .then(() => wx.reLaunch({ url: "/pages/login/index" }))
          .catch((error) => wx.showToast({ title: (error && error.message) || "注销失败", icon: "none" }))
          .finally(() => {
            if (this.accountSettingsAlive) this.setData({ accountBusy: false });
          });
      },
    });
  },

  stopEvent() {},
});
