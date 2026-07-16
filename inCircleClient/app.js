// app.js
const theme = require("./utils/theme");
const runtimeEnv = require("./config/runtimeEnv");
const backend = require("./config/backend");
const auth = require("./utils/auth");
const agreementGate = require("./utils/agreementGate");
const keyboard = require("./utils/keyboard");

if (typeof Promise !== "undefined" && !Promise.prototype.finally) {
  Promise.prototype.finally = function (onFinally) {
    const P = this.constructor;
    return this.then(
      (value) => P.resolve(typeof onFinally === "function" ? onFinally() : onFinally).then(() => value),
      (reason) =>
        P.resolve(typeof onFinally === "function" ? onFinally() : onFinally).then(() => {
          throw reason;
        })
    );
  };
}

if (typeof Page === "function" && !Page.__incircleThemePatched) {
  const nativePage = Page;
  const patchedPage = function (pageConfig) {
    const config = pageConfig || {};
    const originalOnLoad = config.onLoad;
    const originalOnShow = config.onShow;
    const originalOnHide = config.onHide;
    const originalOnUnload = config.onUnload;
    const initialData = Object.assign(
      {
        incircleKeyboardHeight: 0,
        incircleKeyboardInset: 0,
        incircleKeyboardOpen: false,
        incircleKeyboardPageStyle: "--incircle-keyboard-inset:0px;",
      },
      config.data || {}
    );
    config.data = initialData;
    theme.registerPageDefinition(config.data);
    const attachKeyboard = function (page) {
      keyboard.attach(page, (metrics) => {
        if (typeof page.onIncircleKeyboardChange === "function") {
          page.onIncircleKeyboardChange(metrics);
        }
      });
    };
    config.onLoad = function (options) {
      theme.applyPageTheme(this);
      attachKeyboard(this);
      if (typeof originalOnLoad === "function") {
        return originalOnLoad.call(this, options);
      }
    };
    config.onShow = function () {
      theme.applyPageTheme(this);
      theme.acknowledgePageShown(this);
      theme.syncCustomTabBar(this);
      attachKeyboard(this);
      const page = this;
      const runOriginalOnShow = function () {
        return typeof originalOnShow === "function" ? originalOnShow.call(page) : undefined;
      };
      const gateResult = agreementGate.beforePageShow(page);
      if (!gateResult || typeof gateResult.then !== "function") {
        return gateResult === false ? undefined : runOriginalOnShow();
      }
      return gateResult.then((allowed) => {
        if (!allowed || !agreementGate.isCurrentPage(page)) return undefined;
        return runOriginalOnShow();
      });
    };
    config.onHide = function () {
      try {
        if (typeof originalOnHide === "function") {
          return originalOnHide.call(this);
        }
      } finally {
        keyboard.detach(this);
      }
    };
    config.onUnload = function () {
      try {
        if (typeof originalOnUnload === "function") {
          return originalOnUnload.call(this);
        }
      } finally {
        keyboard.detach(this);
        theme.unregisterPage(this);
      }
    };
    return nativePage(config);
  };
  patchedPage.__incircleThemePatched = true;
  Page = patchedPage;
}

App({
  onLaunch: function () {
    const currentTheme = theme.getCurrentTheme();
    const currentRuntimeEnv = runtimeEnv.getRuntimeEnv();
    const currentBackend = backend.getBackendConfig(currentRuntimeEnv.envVersion);
    this.globalData = {
      appName: "InCircle",
      currentCircleId: "",
      userId: "",
      isSuperAdmin: false,
      themeKey: currentTheme.key,
      customTheme: currentTheme.customRgba || theme.getCustomThemeRgba(),
      envVersion: currentRuntimeEnv.envVersion,
      envAlias: currentRuntimeEnv.alias,
      backendMode: currentBackend.mode,
      useHttpBackend: currentBackend.useHttpBackend,
      httpBackendBaseUrl: currentBackend.baseUrl,
      httpBackendTimeout: currentBackend.timeout,
      httpBackendHeaders: currentBackend.headers,
      accessToken: auth.getAccessToken(),
      accessTokenExpiresAt: "",
      subscribeTemplates: {
        // 在微信公众平台配置“服务通知/订阅消息”模板后填入模板 ID。
        settlementReminderTemplateId: "",
      },
    };
    theme.installRouteThemeSync();
    try {
      const backendSignature = `${currentBackend.mode}:${currentBackend.baseUrl || ""}`;
      const previousSignature = wx.getStorageSync("incircleBackendSignature");
      if (previousSignature && previousSignature !== backendSignature) {
        wx.removeStorageSync("incircleHttpReadCache");
      }
      wx.setStorageSync("incircleBackendSignature", backendSignature);
    } catch (error) {
      // Storage may be unavailable in rare launch contexts.
    }
    theme.setTheme(currentTheme.key, currentTheme.customRgba || theme.getCustomThemeRgba());
  },
});
