const api = require("../../utils/api");
const theme = require("../../utils/theme");
const avatar = require("../../utils/avatar");
const dialog = require("../../utils/dialog");
const invite = require("../../utils/invite");

function normalizePhone(value) {
  return String(value || "").replace(/[^\d]/g, "").slice(0, 11);
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeAccount(value) {
  return String(value || "").trim().replace(/\s/g, "");
}

function isGenericWechatNickName(value) {
  const nickName = normalizeText(value);
  return !nickName || nickName === "微信用户" || nickName === "WeChat User";
}

function pickUsableWechatProfile(userInfo) {
  const nickName = normalizeText(userInfo && userInfo.nickName);
  const avatarUrl = normalizeText(userInfo && userInfo.avatarUrl);
  const usableNickName = isGenericWechatNickName(nickName) ? "" : nickName;
  return {
    nickName: usableNickName,
    avatarUrl: usableNickName ? avatarUrl : "",
  };
}

function getWechatProfileGuide() {
  return "微信新版不支持一键读取真实头像昵称。请点左侧头像选择微信头像，再点圈内昵称输入框选择微信昵称或手动填写。";
}

function modeMeta(mode) {
  if (mode === "register") {
    return {
      title: "注册账号并绑定微信",
      copy: "设置账号密码，并把当前微信绑定为这个账号的唯一登录微信。",
      button: "注册并登录",
      hero: "注册后会绑定当前微信，之后账号密码登录也会校验这个微信身份。",
    };
  }
  if (mode === "bind") {
    return {
      title: "绑定账号密码",
      copy: "检测到当前微信已有 InCircle 数据，请先补一个账号密码，之后再登录。",
      button: "绑定并登录",
      hero: "这是一次老用户安全升级。绑定后，你的圈子和成员身份不会丢。",
    };
  }
  if (mode === "forgot") {
    return {
      title: "忘记密码",
      copy: "输入已绑定账号，系统会校验当前微信是否为该账号绑定微信。",
      button: "校验微信并重置",
      hero: "忘记密码时，不发短信；用当前绑定微信校验身份后重置。",
    };
  }
  return {
    title: "账号密码登录",
    copy: "输入账号和密码，系统会同时校验当前微信是否与账号绑定。",
    button: "登录",
    hero: "先用账号密码确认身份，再用当前微信确认这是本人。",
  };
}

Page({
  data: {
    loading: true,
    submitting: false,
    syncingWechat: false,
    loginDisabled: false,
    avatarUploading: false,
    mode: "login",
    modeTitle: "账号密码登录",
    modeCopy: "",
    heroCopy: "",
    primaryButtonText: "登录",
    account: "",
    password: "",
    confirmPassword: "",
    nickName: "",
    wechatNickName: "",
    wechatNameText: "待同步",
    phone: "",
    title: "",
    profileNote: "",
    displayName: "微信用户",
    avatarUrl: "/images/avatar.png",
    avatarUrlDisplay: "/images/avatar.png",
    setupError: "",
    hasSyncedWechat: false,
    nextCode: "",
    user: null,
    backendError: "",
    hasBackendError: false,
    feedbackText: "",
    feedbackType: "",
    themePreferenceExplicit: false,
    themeClass: "",
    themeOptions: [],
    nextInviteToken: "",
  },

  onLoad(options) {
    theme.applyPageTheme(this);
    const meta = modeMeta("login");
    const credential = invite.parseInviteOptions(options);
    this.setData({
      nextCode: credential.joinCode,
      nextInviteToken: credential.inviteToken,
      modeCopy: meta.copy,
      heroCopy: meta.hero,
    });
    this.loadSession();
  },

  loadSession() {
    this.setData({
      loading: true,
      backendError: "",
      hasBackendError: false,
    });
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    const sessionCheck = Promise.resolve().then(() => api.getSession({ force: true }));
    const sessionTimeout = new Promise((resolve, reject) => {
      this.sessionTimer = setTimeout(
        () => reject(new Error("登录状态检查超时，请确认自建后端 HTTPS 和 request 合法域名已配置")),
        12000
      );
    });
    Promise.race([sessionCheck, sessionTimeout])
      .then((session) => {
        if (this.sessionTimer) {
          clearTimeout(this.sessionTimer);
          this.sessionTimer = null;
        }
        const user = session.user || {};
        this.applyUser(user);
        if (session.loggedIn && !session.needsAccountBinding) {
          this.goNext(session);
          return;
        }
        if (session.needsAccountBinding) {
          this.setAuthMode("bind", { keepProfile: true });
          if (!this.hasShownBindModal) {
            this.hasShownBindModal = true;
            dialog.show({
              title: "需要绑定账号密码",
              content: "当前微信已有 InCircle 数据，但还没有账号密码。绑定后才能继续进入圈子。",
              confirmText: "去绑定",
              showCancel: false,
            });
          }
        }
        this.setData({ loading: false });
      })
      .catch((error) => {
        if (this.sessionTimer) {
          clearTimeout(this.sessionTimer);
          this.sessionTimer = null;
        }
        const message = error && error.message ? error.message : "后端登录状态检查失败";
        this.setData({
          loading: false,
          backendError: message,
          hasBackendError: true,
        });
        this.showFeedback("后端连接失败", "error");
      });
  },

  applyUser(user) {
    const storedAvatar = user.avatarUrlFileID || user.avatarUrl || "/images/avatar.png";
    const displayAvatar = user.avatarUrl || storedAvatar;
    this.setData({
      user,
      account: user.accountName || this.data.account || "",
      nickName: user.nickName || "",
      wechatNickName: user.wechatNickName || user.nickName || "",
      wechatNameText: user.wechatNickName || user.nickName || "待同步",
      phone: user.phone || "",
      title: user.title || "",
      profileNote: user.profileNote || "",
      displayName: user.nickName || user.wechatNickName || "微信用户",
      avatarUrl: storedAvatar,
      avatarUrlDisplay: displayAvatar,
    });
  },

  setAuthMode(mode, options) {
    const meta = modeMeta(mode);
    const nextData = {
      mode,
      modeTitle: meta.title,
      modeCopy: meta.copy,
      heroCopy: meta.hero,
      primaryButtonText: meta.button,
      setupError: "",
      backendError: "",
      hasBackendError: false,
      password: "",
      confirmPassword: "",
    };
    if (!(options && options.keepProfile)) {
      Object.assign(nextData, {
        nickName: "",
        wechatNickName: "",
        wechatNameText: "待同步",
        phone: "",
        title: "",
        profileNote: "",
        displayName: "微信用户",
        avatarUrl: "/images/avatar.png",
        avatarUrlDisplay: "/images/avatar.png",
      });
    }
    this.setData(nextData);
  },

  switchMode(e) {
    const mode = e.currentTarget.dataset.mode;
    this.setAuthMode(mode || "login", { keepProfile: mode === "bind" });
  },

  showFeedback(message, type) {
    if (this.feedbackTimer) clearTimeout(this.feedbackTimer);
    this.setData({
      feedbackText: message,
      feedbackType: type || "",
    });
    this.feedbackTimer = setTimeout(() => {
      this.setData({
        feedbackText: "",
        feedbackType: "",
      });
    }, 2200);
  },

  onUnload() {
    if (this.feedbackTimer) clearTimeout(this.feedbackTimer);
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
  },

  onAccountInput(e) {
    this.setData({ account: normalizeAccount(e.detail.value) });
  },

  onPasswordInput(e) {
    this.setData({ password: String(e.detail.value || "") });
  },

  onConfirmPasswordInput(e) {
    this.setData({ confirmPassword: String(e.detail.value || "") });
  },

  onNickInput(e) {
    const value = e.detail.value || "";
    this.setData({
      nickName: value,
      wechatNickName: value || this.data.wechatNickName,
      wechatNameText: value || this.data.wechatNickName || "待同步",
      displayName: value || "微信用户",
    });
  },

  onChooseAvatar(e) {
    const avatarUrl = e.detail && e.detail.avatarUrl ? e.detail.avatarUrl : "";
    if (!avatarUrl) {
      this.showFeedback("未选择头像", "warning");
      return;
    }
    const previousAvatar = this.data.avatarUrl || "/images/avatar.png";
    const previousAvatarDisplay = this.data.avatarUrlDisplay || previousAvatar;
    this.setData({
      avatarUrl,
      avatarUrlDisplay: avatarUrl,
      avatarUploading: true,
      loginDisabled: true,
      hasSyncedWechat: true,
      setupError: "",
    });
    avatar
      .uploadAvatar(avatarUrl)
      .then((nextAvatar) => avatar.resolveAvatarUrl(nextAvatar).then((displayUrl) => ({ nextAvatar, displayUrl })))
      .then(({ nextAvatar, displayUrl }) => {
        this.setData({
          avatarUrl: nextAvatar,
          avatarUrlDisplay: displayUrl || nextAvatar,
          avatarUploading: false,
          loginDisabled: !!this.data.submitting,
          setupError: "",
        });
        this.showFeedback("头像已上传", "success");
      })
      .catch((error) => {
        this.setData({
          avatarUrl: previousAvatar,
          avatarUrlDisplay: previousAvatarDisplay,
          avatarUploading: false,
          loginDisabled: !!this.data.submitting,
          setupError: (error && error.message) || "头像上传失败，请重新选择",
        });
        this.showFeedback((error && error.message) || "头像上传失败", "warning");
      });
  },

  onPhoneInput(e) {
    this.setData({ phone: normalizePhone(e.detail.value) });
  },

  onTitleInput(e) {
    this.setData({ title: e.detail.value });
  },

  onNoteInput(e) {
    this.setData({ profileNote: e.detail.value });
  },

  onThemeSelect(e) {
    const selected = theme.setTheme(e.currentTarget.dataset.key);
    theme.applyPageTheme(this);
    this.setData({ themePreferenceExplicit: true });
    this.showFeedback(`已切换为${selected.name}`, "success");
  },

  syncWechatProfile() {
    if (this.data.syncingWechat) return Promise.resolve(null);
    this.setData({ syncingWechat: true, loginDisabled: true, setupError: "" });
    if (!wx.getUserProfile) {
      this.setData({ syncingWechat: false, loginDisabled: !!this.data.submitting });
      const message = getWechatProfileGuide();
      this.setData({ setupError: message });
      this.showFeedback("请点头像和昵称框选择", "warning");
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      wx.getUserProfile({
        desc: "用于默认填充你的圈内身份资料",
        success: (res) => {
          const userInfo = pickUsableWechatProfile(res.userInfo || {});
          const nextData = {
            hasSyncedWechat: !!(userInfo.nickName || userInfo.avatarUrl),
            setupError: "",
          };

          if (userInfo.nickName) {
            const nextNickName = this.data.nickName || userInfo.nickName;
            Object.assign(nextData, {
              nickName: nextNickName,
              wechatNickName: userInfo.nickName,
              wechatNameText: userInfo.nickName,
              displayName: nextNickName,
            });
          }

          if (userInfo.avatarUrl) {
            nextData.avatarUrl = userInfo.avatarUrl;
            nextData.avatarUrlDisplay = userInfo.avatarUrl;
          }

          if (!nextData.hasSyncedWechat) {
            const message = getWechatProfileGuide();
            this.setData({ setupError: message });
            this.showFeedback("请点头像和昵称框选择", "warning");
            resolve(null);
            return;
          }

          this.setData(nextData);
          this.showFeedback(userInfo.nickName ? "微信资料已同步" : "头像已同步", "success");
          resolve(userInfo);
        },
        fail: (error) => {
          const errMsg = error && error.errMsg ? error.errMsg : "";
          const message = errMsg.indexOf("auth deny") !== -1 || errMsg.indexOf("deny") !== -1
            ? "你取消了授权，可点头像选择微信头像，并在昵称框选择微信昵称。"
            : getWechatProfileGuide();
          this.setData({ setupError: message });
          this.showFeedback("请点头像和昵称框选择", "warning");
          resolve(null);
        },
        complete: () => {
          this.setData({ syncingWechat: false, loginDisabled: !!this.data.submitting });
        },
      });
    });
  },

  buildProfile() {
    const nickName = normalizeText(this.data.nickName || this.data.wechatNickName);
    return {
      nickName,
      wechatNickName: this.data.wechatNickName || "",
      avatarUrl: this.data.avatarUrl || "/images/avatar.png",
      phone: normalizePhone(this.data.phone),
      title: String(this.data.title || "").trim(),
      profileNote: String(this.data.profileNote || "").trim(),
    };
  },

  validateAccountPassword(requireConfirm) {
    const account = normalizeAccount(this.data.account);
    const password = String(this.data.password || "");
    if (account.length < 4) return "请输入至少 4 位账号";
    if (!/^[a-zA-Z0-9_.@-]+$/.test(account)) return "账号只支持手机号、邮箱或英文数字组合";
    if (password.length < 8 || password.length > 64) return "密码需要 8-64 位";
    if (/\s/.test(password)) return "密码不能包含空格";
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "密码至少包含一个字母和一个数字";
    if (requireConfirm && password !== this.data.confirmPassword) return "两次输入的密码不一致";
    return "";
  },

  validateProfile(profile) {
    if (this.data.avatarUploading) return "头像还在上传，请稍等";
    if (avatar.isTemporaryAvatar(profile.avatarUrl)) return "头像还没有上传成功，请重新选择头像";
    if (!profile.nickName || profile.nickName.length < 2) return "请填写至少 2 个字的昵称";
    if (!/^1\d{10}$/.test(profile.phone)) return "请填写 11 位手机号";
    return "";
  },

  submitAuth() {
    if (this.data.submitting || this.data.syncingWechat) return;
    const mode = this.data.mode;
    const requireConfirm = mode !== "login";
    let error = this.validateAccountPassword(requireConfirm);
    const payload = {
      account: normalizeAccount(this.data.account),
      password: String(this.data.password || ""),
      themePreferenceExplicit: this.data.themePreferenceExplicit,
    };
    if (!error && (mode === "register" || mode === "bind")) {
      const profile = this.buildProfile();
      error = this.validateProfile(profile);
      payload.profile = profile;
    }
    if (error) {
      this.setData({ setupError: error });
      this.showFeedback(error, "warning");
      return;
    }

    const meta = modeMeta(mode);
    this.setData({
      submitting: true,
      loginDisabled: true,
      primaryButtonText: mode === "login" ? "登录中..." : "处理中...",
      setupError: "",
      backendError: "",
      hasBackendError: false,
    });

    const action =
      mode === "register"
        ? api.registerAccount(payload)
        : mode === "bind"
          ? api.bindAccount(payload)
          : mode === "forgot"
            ? api.resetPassword(payload)
            : api.accountLogin(payload.account, payload.password, {
                themePreferenceExplicit: payload.themePreferenceExplicit,
              });

    action
      .then((session) => {
        this.showFeedback(mode === "forgot" ? "密码已重置" : "登录成功", "success");
        this.goNext(session);
      })
      .catch((err) => {
        if (mode === "login" && err && err.errCode === "WECHAT_REBIND_CONFIRM_REQUIRED") {
          dialog.show({
            title: "绑定当前微信",
            content: `账号 ${((err.details || {}).accountMasked) || payload.account} 已解除原微信绑定。确认后将绑定到当前微信，旧微信不再可用。`,
            confirmText: "确认绑定",
            tone: "danger",
            success: (res) => {
              if (res.confirm) this.confirmWechatRebind(payload);
            },
          });
          return;
        }
        const message = err && err.message ? err.message : "操作失败";
        this.setData({
          backendError: message,
          hasBackendError: true,
        });
        this.showFeedback(message, "error");
      })
      .finally(() => {
        this.setData({
          submitting: false,
          loginDisabled: false,
          primaryButtonText: meta.button,
        });
      });
  },

  confirmWechatRebind(payload) {
    if (this.data.submitting) return;
    this.setData({ submitting: true, loginDisabled: true, primaryButtonText: "绑定中..." });
    api
      .accountLogin(payload.account, payload.password, {
        themePreferenceExplicit: payload.themePreferenceExplicit,
        confirmWechatRebind: true,
      })
      .then((session) => {
        this.showFeedback("微信已重新绑定", "success");
        this.goNext(session);
      })
      .catch((error) => {
        const message = (error && error.message) || "绑定失败";
        this.setData({ backendError: message, hasBackendError: true });
        this.showFeedback(message, "error");
      })
      .finally(() => {
        this.setData({ submitting: false, loginDisabled: false, primaryButtonText: modeMeta("login").button });
      });
  },

  retrySession() {
    this.loadSession();
  },

  goNext(session) {
    if (this.data.nextInviteToken) {
      wx.redirectTo({
        url: `/pages/circle-join/index${invite.inviteQuery("", this.data.nextInviteToken)}`,
      });
      return;
    }
    if (this.data.nextCode) {
      wx.redirectTo({
        url: `/pages/circle-join/index${invite.inviteQuery(this.data.nextCode, "")}`,
      });
      return;
    }
    const currentCircle = session && session.currentCircle;
    if (session && session.loggedIn && session.hasCircle && currentCircle && currentCircle.id) {
      wx.switchTab({ url: "/pages/index/index" });
      return;
    }
    wx.redirectTo({ url: "/pages/circle-switch/index" });
  },
});
