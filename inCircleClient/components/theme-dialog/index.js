const theme = require("../../utils/theme");

const TONE_ALIASES = Object.freeze({
  default: "default",
  primary: "default",
  info: "default",
  warning: "danger",
  danger: "danger",
  error: "danger",
});
const DANGER_WORDS = /删除|注销|解散|清空|清理|永久|不可恢复|不能恢复|无法恢复|失败|异常|警告|风险|失效|停用|归档|冻结|封禁|解绑|撤销|缺少|权限|上限/;

function normalizeText(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function hexToRgba(value, alpha) {
  const hex = String(value || "").replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(hex)) return `rgba(47, 125, 80, ${alpha})`;
  const red = parseInt(hex.slice(0, 2), 16);
  const green = parseInt(hex.slice(2, 4), 16);
  const blue = parseInt(hex.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function inferTone(options) {
  const source = options || {};
  const explicitTone = TONE_ALIASES[String(source.tone || "").trim().toLowerCase()];
  if (explicitTone) return explicitTone;
  const signal = `${source.title || ""} ${source.content || ""} ${source.confirmText || ""}`;
  const confirmColor = String(source.confirmColor || "").toLowerCase();
  if (DANGER_WORDS.test(signal) || /b34a34|c14343|c14646|a93232/i.test(confirmColor)) return "danger";
  return "default";
}

function readReduceMotion() {
  try {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    return !!(info.reduceMotionEnabled || info.reducedMotion);
  } catch (error) {
    return false;
  }
}

Component({
  data: {
    visible: false,
    closing: false,
    reduceMotion: false,
    title: "提示",
    content: "",
    contentScrollable: false,
    confirmText: "确定",
    cancelText: "取消",
    showCancel: true,
    maskClosable: false,
    tone: "default",
    themeStyle: "",
    verificationText: "",
    verificationLabel: "",
    verificationPlaceholder: "",
    verificationValue: "",
    confirmDisabled: false,
    confirmOpenType: "",
    stackActions: false,
  },

  lifetimes: {
    attached() {
      this.dialogQueue = [];
      this.activeDialog = null;
      this.closeTimer = null;
      this.setData({ reduceMotion: readReduceMotion() });
    },

    detached() {
      if (this.closeTimer) clearTimeout(this.closeTimer);
      this.closeTimer = null;
      const result = { confirm: false, cancel: true, errMsg: "showModal:cancel" };
      if (this.activeDialog && typeof this.activeDialog.resolve === "function") {
        this.activeDialog.resolve(result);
      }
      (this.dialogQueue || []).forEach((item) => item.resolve(result));
      this.activeDialog = null;
      this.dialogQueue = [];
    },
  },

  methods: {
    open(options) {
      return new Promise((resolve) => {
        if (!this.dialogQueue) this.dialogQueue = [];
        this.dialogQueue.push({ options: options || {}, resolve });
        this.showNext();
      });
    },

    showNext() {
      if (this.activeDialog || !this.dialogQueue || !this.dialogQueue.length) return;
      const next = this.dialogQueue.shift();
      const options = next.options || {};
      const currentTheme = theme.getCurrentTheme();
      const tone = inferTone(options);
      const content = normalizeText(options.content, "");
      const verificationText = normalizeText(options.verificationText, "");
      let narrowScreen = false;
      try {
        const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
        narrowScreen = Number(windowInfo.windowWidth || 0) > 0 && Number(windowInfo.windowWidth) < 340;
      } catch (error) {
        narrowScreen = false;
      }
      const confirmText = normalizeText(options.confirmText, "确定");
      const cancelText = normalizeText(options.cancelText, "取消");
      this.activeDialog = next;
      this.setData({
        visible: true,
        closing: false,
        title: normalizeText(options.title, "提示"),
        content,
        contentScrollable: content.length > 150 || content.split("\n").length > 5,
        confirmText,
        cancelText,
        showCancel: options.showCancel !== false,
        maskClosable: options.maskClosable === true,
        verificationText,
        verificationLabel: normalizeText(options.verificationLabel, "请输入确认内容"),
        verificationPlaceholder: normalizeText(options.verificationPlaceholder, verificationText),
        verificationValue: "",
        confirmDisabled: !!verificationText,
        confirmOpenType: options.confirmOpenType === "openSetting" ? "openSetting" : "",
        stackActions: narrowScreen || confirmText.length > 6 || cancelText.length > 6,
        tone,
        themeStyle: [
          `--dialog-primary: ${currentTheme.primary}`,
          `--dialog-primary-dark: ${currentTheme.primaryDark}`,
          `--dialog-accent: ${currentTheme.accent}`,
          `--dialog-soft: ${currentTheme.pageBg}`,
          `--dialog-shadow: ${hexToRgba(currentTheme.primary, 0.22)}`,
          `--dialog-disabled-bg: ${hexToRgba(currentTheme.primary, 0.11)}`,
          `--dialog-disabled-border: ${hexToRgba(currentTheme.primary, 0.18)}`,
          `--dialog-disabled-text: ${currentTheme.primaryDark}`,
        ].join("; "),
      });
    },

    close(result) {
      if (!this.activeDialog || this.data.closing) return;
      const delay = this.data.reduceMotion ? 0 : 150;
      this.setData({ closing: true });
      this.closeTimer = setTimeout(() => {
        this.closeTimer = null;
        const active = this.activeDialog;
        this.activeDialog = null;
        this.setData({ visible: false, closing: false }, () => this.showNext());
        if (active && typeof active.resolve === "function") active.resolve(result);
      }, delay);
    },

    onConfirm() {
      if (this.data.confirmDisabled) return;
      this.close({ confirm: true, cancel: false, content: this.data.verificationValue, errMsg: "showModal:ok" });
    },

    onConfirmOpenSetting(e) {
      const detail = (e && e.detail) || {};
      this.close({
        confirm: true,
        cancel: false,
        authSetting: detail.authSetting || {},
        errMsg: detail.errMsg || "openSetting:ok",
      });
    },

    onCancel() {
      this.close({ confirm: false, cancel: true, errMsg: "showModal:ok" });
    },

    onMaskTap() {
      if (this.data.maskClosable && this.data.showCancel) this.onCancel();
    },

    onVerificationInput(e) {
      const value = String((e && e.detail && e.detail.value) || "");
      this.setData({
        verificationValue: value,
        confirmDisabled: value.trim() !== String(this.data.verificationText || "").trim(),
      });
    },

    stopEvent() {},
  },
});
