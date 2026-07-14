const api = require("../../utils/api");
const time = require("../../utils/time");
const dialog = require("../../utils/dialog");
const keyboard = require("../../utils/keyboard");
const markdown = require("../../utils/markdown");

let requestSequence = 0;
const LAST_CONVERSATION_STORAGE_PREFIX = "incircleAiLastConversation:";
const REASONING_MODE_STORAGE_PREFIX = "incircleAiReasoningMode:";
const REASONING_MODE_VALUES = Object.freeze(["auto", "on", "off"]);
const REASONING_MODE_LABELS = Object.freeze({ auto: "自动", on: "思考开", off: "思考关" });

function uniqueRequestId() {
  requestSequence = (requestSequence + 1) % 1679616;
  const timestamp = Date.now().toString(36);
  const sequence = requestSequence.toString(36).padStart(4, "0");
  const random = Math.random().toString(36).slice(2, 12).padEnd(10, "0");
  return `ai_${timestamp}_${sequence}_${random}`;
}

function generationErrorText(error) {
  const code = error && error.errCode;
  if (code === "AI_REQUEST_ALREADY_USED") return "连接状态没有同步，请再试一次";
  if (code === "AI_CONVERSATION_BUSY") return "当前对话仍在生成回答，请稍后再试";
  if (code === "AI_MEMBER_DAILY_LIMIT") return "你今天的 AI 使用次数已用完";
  if (code === "AI_CIRCLE_DAILY_LIMIT") return "本圈今天的 AI 使用次数已用完";
  if (code === "AI_RATE_LIMITED") return "发送得有点快，请稍后再试";
  if (code === "AI_CANCELLED") return "已停止生成";
  if (code === "AI_STALE_GENERATION") return "上次生成意外中断，请重新生成";
  if (code === "AI_REASONING_WITHOUT_ANSWER") return "模型完成了思考，但没有生成最终回答，请重新生成";
  if (code === "AI_OUTPUT_LIMIT_REACHED") return "模型思考用完了输出额度，请让圈主提高单次最大输出后重试";
  if (code === "AI_LEGACY_STREAM_INTERRUPTED") return "历史回答的连接曾意外中断，请重新生成";
  if (code === "AI_EMPTY_RESPONSE") return "模型没有返回可展示的内容，请重新生成";
  if (code === "CONTENT_SECURITY_BLOCKED") return "内容未通过安全检查，请调整问题后重试";
  if (code === "CONTENT_SECURITY_UNAVAILABLE") return "内容安全服务暂时不可用，请稍后重试";
  if (code === "AI_PROVIDER_TIMEOUT") return "模型思考时间较长，连接已超时，请稍后重试";
  if (code === "AI_PROVIDER_STREAM_DISCONNECTED" || code === "AI_NETWORK_ERROR" || code === "AI_STREAM_INCOMPLETE") {
    return "流式连接中断，回答未能恢复，请稍后再试";
  }
  return (error && error.message) || "回答没有完成，请重试";
}

function hasVisibleReasoning(value) {
  return String(value || "").replace(/[\s\u200b-\u200d\u2060\ufeff]/g, "").length > 0;
}

function normalizedReasoningContent(value) {
  const content = String(value || "");
  return hasVisibleReasoning(content) ? content : "";
}

function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatReasoningDuration(value) {
  const durationMs = Math.max(0, Number(value || 0));
  if (!durationMs) return "";
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m${remainder}s` : `${minutes}m`;
}

function decorateMessage(message) {
  const source = message || {};
  const reasoningContent = normalizedReasoningContent(source.reasoningContent);
  const hasReasoningContent = hasVisibleReasoning(reasoningContent);
  const hasBody = !!String(source.content || "");
  const reasoningBodyStarted = typeof source.reasoningBodyStarted === "boolean"
    ? source.reasoningBodyStarted
    : hasBody;
  const reasoningExpanded = typeof source.reasoningExpanded === "boolean"
    ? source.reasoningExpanded
    : !!reasoningContent && source.status === "generating" && !hasBody;
  const reasoningStartedAtMs = timestampMs(source.reasoningStartedAtMs || source.createdAt);
  const storedReasoningDurationMs = Math.max(0, Number(source.reasoningDurationMs || 0));
  const reasoningTimingActive = typeof source.reasoningTimingActive === "boolean"
    ? source.reasoningTimingActive
    : source.status === "generating" && hasReasoningContent && !hasBody;
  const reasoningDurationMs = reasoningTimingActive && reasoningStartedAtMs
    ? Math.max(storedReasoningDurationMs, Date.now() - reasoningStartedAtMs)
    : storedReasoningDurationMs;
  const isFailed = source.status === "failed" || source.status === "cancelled" || source.status === "blocked";
  return Object.assign({}, source, {
    reasoningContent,
    hasReasoningContent,
    reasoningExpanded,
    reasoningBodyStarted,
    reasoningStartedAtMs,
    reasoningDurationMs,
    reasoningDurationText: hasReasoningContent ? formatReasoningDuration(reasoningDurationMs) : "",
    reasoningTimingActive,
    reasoningManual: !!source.reasoningManual,
    reasoningStreaming: typeof source.reasoningStreaming === "boolean"
      ? source.reasoningStreaming
      : !!reasoningContent && source.status === "generating" && !hasBody,
    contentHtml: markdown.renderMarkdown(source.content),
    reasoningHtml: hasReasoningContent ? markdown.renderMarkdown(reasoningContent) : "",
    anchorId: `message-${source.id || uniqueRequestId()}`,
    isAssistant: source.role === "assistant",
    isFailed,
    failureTitle: source.status === "cancelled" ? "已停止生成" : source.status === "blocked" ? "内容未展示" : "回答没有完成",
    errorText: source.errorText || (isFailed ? generationErrorText({ errCode: source.errorCode }) : ""),
  });
}

function modelLabel(model) {
  return `${model.displayName || model.modelId} · ${model.providerName}`;
}

function currentStorageUserId() {
  let userId = "current";
  try {
    const app = getApp();
    userId = (app && app.globalData && app.globalData.userId) || userId;
  } catch (error) {
    // The current-account fallback is sufficient in smoke-test contexts.
  }
  return userId;
}

function scopedStorageKey(prefix, circleId) {
  return `${prefix}${currentStorageUserId()}:${circleId}`;
}

function lastConversationStorageKey(circleId) {
  return scopedStorageKey(LAST_CONVERSATION_STORAGE_PREFIX, circleId);
}

function readLastConversationId(circleId) {
  try {
    return String(wx.getStorageSync(lastConversationStorageKey(circleId)) || "");
  } catch (error) {
    return "";
  }
}

function saveLastConversationId(circleId, conversationId) {
  if (!circleId || !conversationId) return;
  try {
    wx.setStorageSync(lastConversationStorageKey(circleId), conversationId);
  } catch (error) {
    // Restoring the last conversation is an optional local convenience.
  }
}

function clearLastConversationId(circleId, conversationId) {
  try {
    const key = lastConversationStorageKey(circleId);
    if (!conversationId || String(wx.getStorageSync(key) || "") === String(conversationId)) wx.removeStorageSync(key);
  } catch (error) {
    // Ignore unavailable local storage.
  }
}

function readReasoningMode(circleId) {
  try {
    const value = String(wx.getStorageSync(scopedStorageKey(REASONING_MODE_STORAGE_PREFIX, circleId)) || "");
    return REASONING_MODE_VALUES.includes(value) ? value : "auto";
  } catch (error) {
    return "auto";
  }
}

function saveReasoningMode(circleId, mode) {
  if (!circleId) return;
  try {
    wx.setStorageSync(
      scopedStorageKey(REASONING_MODE_STORAGE_PREFIX, circleId),
      REASONING_MODE_VALUES.includes(mode) ? mode : "auto"
    );
  } catch (error) {
    // The automatic mode remains available when local storage is unavailable.
  }
}

function reasoningModeSupported(control, mode) {
  if (mode === "auto") return true;
  if (control === "toggle") return true;
  if (control === "always") return mode === "on";
  if (control === "none") return mode === "off";
  return false;
}

function reasoningModeUnavailableText(control, mode) {
  if (control === "always" && mode === "off") return "当前模型固定开启思考";
  if (control === "none" && mode === "on") return "当前模型不支持思考";
  return "当前模型仅支持自动思考";
}

function reasoningModeOptions(control) {
  if (control === "toggle") return ["auto", "on", "off"];
  if (control === "always") return ["on"];
  if (control === "none") return ["off"];
  return ["auto"];
}

function reasoningUiState(model, preferredMode) {
  const control = String((model && model.reasoningControl) || "prompt");
  const modeValues = reasoningModeOptions(control);
  const requestedMode = REASONING_MODE_VALUES.includes(preferredMode) ? preferredMode : "auto";
  const mode = modeValues.includes(requestedMode) ? requestedMode : modeValues[0];
  const modeIndex = Math.max(0, modeValues.indexOf(mode));
  const enabled = control === "always" ? true : control === "none" ? false : mode !== "off";
  return {
    reasoningEnabled: enabled,
    reasoningControl: control,
    reasoningMode: mode,
    reasoningModeIndex: modeIndex,
    reasoningModeValues: modeValues,
    reasoningModeNames: modeValues.map((value) => REASONING_MODE_LABELS[value]),
  };
}

Page({
  data: {
    loading: true,
    unavailable: false,
    circleId: "",
    status: null,
    models: [],
    modelNames: [],
    modelIndex: 0,
    currentConversation: null,
    conversations: [],
    historyPage: 1,
    historyHasMore: false,
    messages: [],
    inputValue: "",
    sending: false,
    stopping: false,
    reasoningEnabled: true,
    reasoningControl: "prompt",
    reasoningMode: "auto",
    reasoningModeIndex: 0,
    reasoningModeValues: ["auto"],
    reasoningModeNames: ["自动"],
    historyOpen: false,
    historySearch: "",
    historyLoading: false,
    historyLoadingMore: false,
    deletingConversationId: "",
    consentOpen: false,
    consent: null,
    consentBusy: false,
    reportBusyId: "",
    scrollIntoView: "",
    hasMoreMessages: false,
    nextCursor: "",
    loadingMore: false,
  },

  onLoad(options) {
    if (typeof wx.hideShareMenu === "function") wx.hideShareMenu();
    this.pendingContent = "";
    this.chatRequest = null;
    this.sendLock = false;
    this.searchTimer = null;
    this.historyRequestSeq = 0;
    this.conversationPollTimer = null;
    this.conversationPollId = "";
    this.conversationPollDeadline = 0;
    this.liveStreamState = null;
    this.reasoningClockTimer = null;
    this.generationStartedAt = 0;
    this.typingBottomToggle = false;
    const circleId = (options && options.circleId) || "";
    this.reasoningPreference = readReasoningMode(circleId);
    this.setData(Object.assign({ circleId }, reasoningUiState(null, this.reasoningPreference)));
    this.loadInitial((options && options.conversationId) || "");
  },

  onShow() {
    this.syncReasoningClock();
  },

  onHide() {
    this.clearReasoningClock();
  },

  onUnload() {
    if (this.chatRequest) this.chatRequest.abort();
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.clearConversationPoll();
    this.clearReasoningClock();
    this.disposeLiveStream();
  },

  blockMove() {},

  onIncircleKeyboardChange(metrics) {
    if (metrics && metrics.open) this.scrollToLatest();
  },

  scrollToLatest() {
    if (!this.data.messages.length) return;
    this.typingBottomToggle = !this.typingBottomToggle;
    this.setData({ scrollIntoView: this.typingBottomToggle ? "messages-bottom-a" : "messages-bottom-b" });
  },

  clearReasoningClock() {
    if (this.reasoningClockTimer) clearTimeout(this.reasoningClockTimer);
    this.reasoningClockTimer = null;
  },

  syncReasoningClock() {
    if (this.reasoningClockTimer) return;
    const active = (this.data.messages || []).some((message) =>
      message && message.isAssistant && message.status === "generating" &&
      message.hasReasoningContent && message.reasoningTimingActive !== false
    );
    if (!active) return;
    this.tickReasoningClock();
  },

  tickReasoningClock() {
    this.reasoningClockTimer = null;
    const now = Date.now();
    const updates = {};
    let active = false;
    (this.data.messages || []).forEach((message, index) => {
      if (
        !message || !message.isAssistant || message.status !== "generating" ||
        !message.hasReasoningContent || message.reasoningTimingActive === false
      ) return;
      const startedAt = timestampMs(message.reasoningStartedAtMs || message.createdAt);
      if (!startedAt) return;
      active = true;
      const durationMs = Math.max(Number(message.reasoningDurationMs || 0), now - startedAt);
      const durationText = formatReasoningDuration(durationMs);
      if (durationText !== message.reasoningDurationText) {
        updates[`messages[${index}].reasoningDurationMs`] = durationMs;
        updates[`messages[${index}].reasoningDurationText`] = durationText;
      }
    });
    if (Object.keys(updates).length) this.setData(updates);
    if (!active) return;
    this.reasoningClockTimer = setTimeout(() => this.tickReasoningClock(), 1000);
    if (this.reasoningClockTimer && typeof this.reasoningClockTimer.unref === "function") {
      this.reasoningClockTimer.unref();
    }
  },

  markReasoningStarted(index, startedAt, durationValue) {
    const message = this.data.messages[index];
    if (!message) return Promise.resolve();
    const providedDurationMs = Math.max(0, Number(durationValue || 0));
    const startedAtMs = !message.reasoningTimingActive && providedDurationMs
      ? Date.now() - providedDurationMs
      : timestampMs(message.reasoningStartedAtMs || startedAt) || Date.now();
    const durationMs = Math.max(
      Number(message.reasoningDurationMs || 0),
      providedDurationMs,
      Date.now() - startedAtMs,
      1
    );
    return this.commitStreamData({
      [`messages[${index}].reasoningStartedAtMs`]: startedAtMs,
      [`messages[${index}].reasoningDurationMs`]: durationMs,
      [`messages[${index}].reasoningDurationText`]: formatReasoningDuration(durationMs),
      [`messages[${index}].reasoningTimingActive`]: true,
    }, () => this.syncReasoningClock());
  },

  freezeReasoningDuration(index, durationValue) {
    const message = this.data.messages[index];
    if (!message || (!message.reasoningTimingActive && !message.hasReasoningContent)) return Promise.resolve();
    const startedAt = timestampMs(message.reasoningStartedAtMs || message.createdAt);
    const provided = Math.max(0, Number(durationValue || 0));
    const liveElapsed = message.reasoningTimingActive && startedAt ? Math.max(1, Date.now() - startedAt) : 0;
    const durationMs = Math.max(provided, liveElapsed, Number(message.reasoningDurationMs || 0));
    return this.commitStreamData({
      [`messages[${index}].reasoningDurationMs`]: durationMs,
      [`messages[${index}].reasoningDurationText`]: formatReasoningDuration(durationMs),
      [`messages[${index}].reasoningTimingActive`]: false,
    }, () => {
      this.clearReasoningClock();
      this.syncReasoningClock();
    });
  },

  clearConversationPoll() {
    if (this.conversationPollTimer) clearTimeout(this.conversationPollTimer);
    this.conversationPollTimer = null;
    this.conversationPollId = "";
    this.conversationPollDeadline = 0;
  },

  watchGeneratingConversation(conversationId, messages) {
    this.clearConversationPoll();
    this.syncReasoningClock();
    const hasGenerating = (messages || []).some((message) => message.role === "assistant" && message.status === "generating");
    if (!conversationId || !hasGenerating || this.data.sending) return;
    this.conversationPollId = conversationId;
    this.conversationPollDeadline = Date.now() + 10 * 60 * 1000;
    this.conversationPollTimer = setTimeout(() => this.pollGeneratingConversation(conversationId), 1200);
  },

  pollGeneratingConversation(conversationId) {
    this.conversationPollTimer = null;
    const current = this.data.currentConversation;
    if (!current || current.id !== conversationId || this.data.sending || this.conversationPollId !== conversationId) {
      this.clearConversationPoll();
      return;
    }
    api.listAiMessages(this.data.circleId, conversationId, { pageSize: 50, force: true })
      .then((data) => {
        if (!this.data.currentConversation || this.data.currentConversation.id !== conversationId) return;
        const messages = (data.messages || []).map(decorateMessage);
        const hasGenerating = messages.some((message) => message.role === "assistant" && message.status === "generating");
        this.setData({
          messages,
          hasMoreMessages: !!data.hasMore,
          nextCursor: data.nextCursor || "",
          scrollIntoView: messages.length ? messages[messages.length - 1].anchorId : "",
        }, () => this.syncReasoningClock());
        if (!hasGenerating) {
          this.clearConversationPoll();
          this.loadConversations();
        }
      })
      .catch(() => {})
      .finally(() => {
        if (
          this.conversationPollId === conversationId &&
          !this.conversationPollTimer &&
          Date.now() < this.conversationPollDeadline
        ) {
          this.conversationPollTimer = setTimeout(() => this.pollGeneratingConversation(conversationId), 2500);
        }
      });
  },

  onKeyboardHeightChange(event) {
    keyboard.update(this, event);
  },

  onComposerFocus() {
    this.scrollToLatest();
  },

  disposeLiveStream() {
    this.liveStreamState = null;
  },

  commitStreamData(updates, afterCommit) {
    return new Promise((resolve) => {
      this.setData(updates, () => {
        if (typeof afterCommit === "function") afterCommit();
        resolve();
      });
    });
  },

  beginLiveStream(assistantIndex, fallbackMessage) {
    const current = this.data.messages[assistantIndex] || fallbackMessage || {};
    this.liveStreamState = {
      assistantIndex,
      fallbackMessage,
      content: String(current.content || ""),
      reasoningContent: String(current.reasoningContent || ""),
      bodyStarted: !!String(current.content || ""),
    };
  },

  resetLiveStreamForRetry(assistantIndex, fallbackMessage) {
    const message = fallbackMessage || {};
    this.liveStreamState = {
      assistantIndex,
      fallbackMessage: message,
      content: String(message.content || ""),
      reasoningContent: String(message.reasoningContent || ""),
      bodyStarted: !!String(message.content || ""),
    };
  },

  appendAnswerDelta(delta) {
    const state = this.liveStreamState;
    const piece = String(delta || "");
    if (!state || !piece) return Promise.resolve();
    const current = this.data.messages[state.assistantIndex] || state.fallbackMessage || {};
    const firstBodyChunk = !state.bodyStarted;
    state.bodyStarted = true;
    state.content += piece;
    this.typingBottomToggle = !this.typingBottomToggle;
    const updates = {
      [`messages[${state.assistantIndex}].content`]: state.content,
      [`messages[${state.assistantIndex}].contentHtml`]: markdown.renderMarkdown(state.content),
      scrollIntoView: this.typingBottomToggle ? "messages-bottom-a" : "messages-bottom-b",
    };
    if (firstBodyChunk) {
      const hasReasoningContent = hasVisibleReasoning(state.reasoningContent || current.reasoningContent);
      updates[`messages[${state.assistantIndex}].reasoningBodyStarted`] = true;
      updates[`messages[${state.assistantIndex}].reasoningStreaming`] = false;
      updates[`messages[${state.assistantIndex}].reasoningExpanded`] = false;
      updates[`messages[${state.assistantIndex}].reasoningManual`] = false;
      updates[`messages[${state.assistantIndex}].hasReasoningContent`] = hasReasoningContent;
      if (!hasReasoningContent) {
        updates[`messages[${state.assistantIndex}].reasoningContent`] = "";
        updates[`messages[${state.assistantIndex}].reasoningHtml`] = "";
      }
    }
    return this.commitStreamData(updates);
  },

  appendReasoningDelta(delta) {
    const state = this.liveStreamState;
    const piece = String(delta || "");
    if (!state || !piece) return Promise.resolve();
    const nextContent = `${state.reasoningContent}${piece}`;
    state.reasoningContent = nextContent;
    if (!hasVisibleReasoning(nextContent)) return Promise.resolve();
    const current = this.data.messages[state.assistantIndex] || state.fallbackMessage || {};
    this.typingBottomToggle = !this.typingBottomToggle;
    return this.commitStreamData({
      [`messages[${state.assistantIndex}].reasoningContent`]: state.reasoningContent,
      [`messages[${state.assistantIndex}].reasoningHtml`]: markdown.renderMarkdown(state.reasoningContent),
      [`messages[${state.assistantIndex}].hasReasoningContent`]: true,
      [`messages[${state.assistantIndex}].reasoningExpanded`]: state.bodyStarted
        ? !!current.reasoningExpanded
        : current.reasoningManual ? !!current.reasoningExpanded : true,
      [`messages[${state.assistantIndex}].reasoningStreaming`]: !state.bodyStarted,
      scrollIntoView: this.typingBottomToggle ? "messages-bottom-a" : "messages-bottom-b",
    }, () => this.syncReasoningClock());
  },

  finishLiveStream() {
    const state = this.liveStreamState;
    this.liveStreamState = null;
    return state || null;
  },

  loadInitial(conversationId) {
    const targetConversationId = String(conversationId || "").trim();
    this.setData({
      loading: true,
      unavailable: false,
      currentConversation: null,
      messages: [],
      inputValue: "",
      historyOpen: false,
      hasMoreMessages: false,
      nextCursor: "",
      scrollIntoView: "",
    });
    api
      .getAiStatus(this.data.circleId, { force: true })
      .then((status) => {
        if (!status.canChat) {
          this.setData({ status, unavailable: true, loading: false });
          return null;
        }
        const models = status.models || [];
        const defaultIndex = Math.max(0, models.findIndex((model) => model.isDefault));
        this.setData(Object.assign({
          status,
          models,
          modelNames: models.map(modelLabel),
          modelIndex: defaultIndex,
        }, reasoningUiState(models[defaultIndex], this.reasoningPreference)));
        return this.loadConversations().then(() => {
          const rememberedConversationId = readLastConversationId(this.data.circleId);
          const rememberedConversation = this.data.conversations.find((item) => item.id === rememberedConversationId);
          const latestConversation = this.data.conversations[0];
          const selectedConversationId = targetConversationId ||
            (rememberedConversation && rememberedConversation.id) ||
            (latestConversation && latestConversation.id) || "";
          if (selectedConversationId) return this.openConversationById(selectedConversationId);
          return null;
        }).then(() => this.setData({ loading: false }));
      })
      .catch((error) => {
        this.setData({ loading: false, unavailable: true });
        wx.showToast({ title: error.message || "AI 助手暂不可用", icon: "none" });
      });
  },

  loadConversations(search, append) {
    if (append && (!this.data.historyHasMore || this.data.historyLoadingMore)) return Promise.resolve();
    const query = typeof search === "string" ? search : this.data.historySearch;
    const page = append ? this.data.historyPage + 1 : 1;
    const requestSeq = ++this.historyRequestSeq;
    this.setData(append ? { historyLoadingMore: true } : { historyLoading: true });
    return api
      .listAiConversations(this.data.circleId, { search: query, page, pageSize: 20 })
      .then((data) => {
        if (requestSeq !== this.historyRequestSeq) return;
        const conversations = (data.conversations || []).map((conversation) =>
          Object.assign({}, conversation, { updatedAtText: time.formatDateMinute(conversation.updatedAt || conversation.lastMessageAt) })
        );
        this.setData({
          conversations: append ? this.data.conversations.concat(conversations) : conversations,
          historyPage: page,
          historyHasMore: !!data.hasMore,
        });
      })
      .catch((error) => {
        if (requestSeq === this.historyRequestSeq) {
          wx.showToast({ title: error.message || "读取历史对话失败", icon: "none" });
        }
      })
      .finally(() => {
        if (requestSeq === this.historyRequestSeq) this.setData({ historyLoading: false, historyLoadingMore: false });
      });
  },

  loadMoreConversations() {
    this.loadConversations(this.data.historySearch, true);
  },

  openHistory() {
    this.setData({ historyOpen: true });
    this.loadConversations();
  },

  closeHistory() {
    this.setData({ historyOpen: false });
  },

  onHistorySearch(e) {
    const value = e.detail.value;
    this.setData({ historySearch: value });
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.loadConversations(value), 300);
  },

  newConversation() {
    if (this.data.sending) return;
    this.clearConversationPoll();
    this.setData({
      currentConversation: null,
      messages: [],
      historyOpen: false,
      inputValue: "",
      hasMoreMessages: false,
      nextCursor: "",
    });
  },

  selectConversation(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || this.data.sending) return;
    this.setData({ historyOpen: false });
    this.openConversationById(id);
  },

  openConversationById(id) {
    this.clearConversationPoll();
    this.setData({ loadingMore: true });
    return api
      .listAiMessages(this.data.circleId, id, { pageSize: 50 })
      .then((data) => {
        const conversation = data.conversation;
        const modelIndex = Math.max(0, this.data.models.findIndex((model) => model.id === conversation.modelId));
        const messages = (data.messages || []).map(decorateMessage);
        saveLastConversationId(this.data.circleId, conversation.id);
        this.setData(Object.assign({
          currentConversation: conversation,
          modelIndex,
          messages,
          hasMoreMessages: !!data.hasMore,
          nextCursor: data.nextCursor || "",
          scrollIntoView: messages.length ? messages[messages.length - 1].anchorId : "",
        }, reasoningUiState(this.data.models[modelIndex], this.reasoningPreference)), () => this.watchGeneratingConversation(conversation.id, messages));
      })
      .catch((error) => wx.showToast({ title: error.message || "读取对话失败", icon: "none" }))
      .finally(() => this.setData({ loadingMore: false }));
  },

  loadEarlierMessages() {
    const conversation = this.data.currentConversation;
    if (!conversation || !this.data.hasMoreMessages || this.data.loadingMore) return;
    this.setData({ loadingMore: true });
    api
      .listAiMessages(this.data.circleId, conversation.id, { pageSize: 50, before: this.data.nextCursor })
      .then((data) => {
        const earlier = (data.messages || []).map(decorateMessage);
        const anchor = this.data.messages[0] && this.data.messages[0].anchorId;
        this.setData({
          messages: earlier.concat(this.data.messages),
          hasMoreMessages: !!data.hasMore,
          nextCursor: data.nextCursor || "",
          scrollIntoView: anchor || "",
        });
      })
      .catch((error) => wx.showToast({ title: error.message || "读取历史消息失败", icon: "none" }))
      .finally(() => this.setData({ loadingMore: false }));
  },

  deleteConversation(e) {
    const id = e.currentTarget.dataset.id;
    const title = e.currentTarget.dataset.title || "这段对话";
    if (!id || this.data.sending || this.data.deletingConversationId) return;
    dialog.show({
      title: "删除对话",
      content: `确认永久删除「${title}」？删除后无法恢复。`,
      confirmText: "删除",
      success: (result) => {
        if (!result.confirm) return;
        this.setData({ deletingConversationId: id });
        api
          .deleteAiConversation(this.data.circleId, id)
          .then(() => {
            clearLastConversationId(this.data.circleId, id);
            if (this.data.currentConversation && this.data.currentConversation.id === id) this.newConversation();
            return this.loadConversations();
          })
          .catch((error) => wx.showToast({ title: error.message || "删除失败", icon: "none" }))
          .finally(() => this.setData({ deletingConversationId: "" }));
      },
    });
  },

  onModelChange(e) {
    if (this.data.sending) return;
    const modelIndex = Number(e.detail.value || 0);
    this.setData(Object.assign(
      { modelIndex },
      reasoningUiState(this.data.models[modelIndex], this.reasoningPreference)
    ));
  },

  onInput(e) {
    this.setData({ inputValue: e.detail.value });
  },

  onReasoningModeChange(e) {
    if (this.data.sending) return;
    const index = Number(e.detail.value || 0);
    const requestedMode = this.data.reasoningModeValues[index] || "auto";
    const model = this.selectedModel();
    const control = String((model && model.reasoningControl) || "prompt");
    if (!reasoningModeSupported(control, requestedMode)) {
      wx.showToast({ title: reasoningModeUnavailableText(control, requestedMode), icon: "none" });
      return;
    }
    this.reasoningPreference = requestedMode;
    this.setData(reasoningUiState(model, requestedMode));
    saveReasoningMode(this.data.circleId, requestedMode);
  },

  usePrompt(e) {
    const content = String(e.currentTarget.dataset.text || "").trim();
    if (!content || this.sendLock || this.data.sending) return;
    this.setData({ inputValue: content });
    this.submitContent(content);
  },

  selectedModel() {
    return this.data.models[this.data.modelIndex] || this.data.models[0] || null;
  },

  requestConsent(model, content, details) {
    this.pendingContent = content;
    const source = details || model || {};
    this.setData({
      consentOpen: true,
      consent: {
        providerId: source.providerId,
        providerName: source.providerName,
        providerDomain: source.providerDomain,
        privacyUrl: source.privacyUrl,
        privacyVersion: source.privacyVersion,
      },
    });
  },

  closeConsent() {
    if (this.data.consentBusy) return;
    this.pendingContent = "";
    this.setData({ consentOpen: false, consent: null });
  },

  copyPrivacyUrl() {
    const consent = this.data.consent;
    if (!consent || !consent.privacyUrl) return;
    wx.setClipboardData({ data: consent.privacyUrl });
  },

  grantConsent() {
    const consent = this.data.consent;
    if (!consent || this.data.consentBusy) return;
    this.setData({ consentBusy: true });
    api
      .grantAiConsent(this.data.circleId, consent.providerId)
      .then(() => {
        const models = this.data.models.map((model) =>
          model.providerId === consent.providerId ? Object.assign({}, model, { consented: true }) : model
        );
        const content = this.pendingContent;
        this.pendingContent = "";
        this.setData({ models, consentOpen: false, consent: null });
        this.startSend(content);
      })
      .catch((error) => wx.showToast({ title: error.message || "授权失败", icon: "none" }))
      .finally(() => this.setData({ consentBusy: false }));
  },

  sendMessage() {
    const content = String(this.data.inputValue || "").trim();
    this.submitContent(content);
  },

  submitContent(content) {
    if (this.sendLock || this.data.sending) return;
    if (!content) return;
    const model = this.selectedModel();
    if (!model) {
      wx.showToast({ title: "没有可用模型", icon: "none" });
      return;
    }
    if (!model.consented) {
      this.requestConsent(model, content);
      return;
    }
    this.startSend(content);
  },

  startSend(content) {
    const model = this.selectedModel();
    if (!model || this.sendLock || this.data.sending) return;
    const reasoningMode = this.data.reasoningMode || "auto";
    const reasoningEnabled = this.data.reasoningEnabled !== false;
    let activeReasoningEnabled = reasoningEnabled;
    this.sendLock = true;
    const generationStartedAt = Date.now();
    this.generationStartedAt = generationStartedAt;
    this.clearConversationPoll();
    const requestId = uniqueRequestId();
    const userTempId = `user-${requestId}`;
    const assistantTempId = `assistant-${requestId}`;
    const userMessage = decorateMessage({ id: userTempId, role: "user", content, status: "complete", requestId });
    const assistantMessage = decorateMessage({
      id: assistantTempId,
      role: "assistant",
      content: "",
      status: "generating",
      requestId,
      modelName: model.displayName,
      providerName: model.providerName,
      reasoningEnabled,
      reasoningMode,
      reasoningStartedAtMs: generationStartedAt,
      reasoningTimingActive: false,
    });
    const messages = this.data.messages.concat([userMessage, assistantMessage]);
    const assistantIndex = messages.length - 1;
    const conversationBeforeSend = this.data.currentConversation;
    this.setData({
      messages,
      inputValue: "",
      sending: true,
      scrollIntoView: assistantMessage.anchorId,
    });
    this.beginLiveStream(assistantIndex, assistantMessage);
    let generationStarted = false;

    const handlers = {
      onStart: (event) => {
        generationStarted = true;
        if (typeof event.reasoningEnabled === "boolean") activeReasoningEnabled = event.reasoningEnabled;
        const current = this.data.messages[assistantIndex] || assistantMessage;
        const next = decorateMessage(Object.assign({}, current, {
          id: event.messageId || current.id,
          modelName: event.modelName || current.modelName,
          reasoningEnabled: activeReasoningEnabled,
          reasoningMode: event.reasoningMode || reasoningMode,
          reasoningStartedAtMs: timestampMs(event.startedAt) || current.reasoningStartedAtMs || generationStartedAt,
        }));
        return this.commitStreamData({
          currentConversation: Object.assign({}, this.data.currentConversation || {}, {
            id: event.conversationId,
            title: (this.data.currentConversation && this.data.currentConversation.title) || content.slice(0, 26),
            modelId: model.id,
          }),
          [`messages[${assistantIndex}]`]: next,
          scrollIntoView: next.anchorId,
        }, () => saveLastConversationId(this.data.circleId, event.conversationId));
      },
      onDelta: async (delta, event) => {
        await this.freezeReasoningDuration(assistantIndex, event && event.reasoningDurationMs);
        await this.appendAnswerDelta(delta);
      },
      onReasoning: async (delta, event) => {
        if (!activeReasoningEnabled) return;
        const state = this.liveStreamState;
        if (!state || !state.bodyStarted) {
          await this.markReasoningStarted(assistantIndex, generationStartedAt, event && event.reasoningDurationMs);
        }
        await this.appendReasoningDelta(delta);
      },
      onReplaceContent: (fullContent, recoveredMessage) => {
        this.disposeLiveStream();
        const current = this.data.messages[assistantIndex] || assistantMessage;
        const recovered = recoveredMessage || {};
        const next = decorateMessage(Object.assign({}, current, recovered, {
          content: String(fullContent || ""),
          reasoningContent: activeReasoningEnabled ? String(recovered.reasoningContent || "") : "",
          reasoningExpanded: false,
          reasoningBodyStarted: !!String(fullContent || ""),
          reasoningStreaming: false,
          reasoningTimingActive: recovered.status === "generating" && !String(fullContent || ""),
        }));
        return this.commitStreamData(
          { [`messages[${assistantIndex}]`]: next, scrollIntoView: next.anchorId },
          () => this.syncReasoningClock()
        );
      },
      onDone: async (event) => {
        await this.freezeReasoningDuration(assistantIndex, event && event.reasoningDurationMs);
        const snapshot = this.finishLiveStream();
        const current = this.data.messages[assistantIndex] || assistantMessage;
        const reasoningContent = normalizedReasoningContent(
          (snapshot && snapshot.reasoningContent) || current.reasoningContent
        );
        const answerContent = String((snapshot && snapshot.content) || current.content || "");
        await this.commitStreamData({
          [`messages[${assistantIndex}].status`]: "complete",
          [`messages[${assistantIndex}].content`]: answerContent,
          [`messages[${assistantIndex}].contentHtml`]: markdown.renderMarkdown(answerContent),
          [`messages[${assistantIndex}].reasoningContent`]: reasoningContent,
          [`messages[${assistantIndex}].reasoningHtml`]: reasoningContent ? markdown.renderMarkdown(reasoningContent) : "",
          [`messages[${assistantIndex}].hasReasoningContent`]: !!reasoningContent,
          [`messages[${assistantIndex}].reasoningExpanded`]: reasoningContent ? !!current.reasoningExpanded : false,
          [`messages[${assistantIndex}].reasoningStreaming`]: false,
          [`messages[${assistantIndex}].reasoningTimingActive`]: false,
        }, () => {
          this.loadConversations();
          api.getAiStatus(this.data.circleId, { force: true }).then((status) => this.setData({ status })).catch(() => {});
        });
      },
    };

    const runAttempt = (activeRequestId, canRefreshRequestId) => {
      const request = api.streamAiChat(
        {
          circleId: this.data.circleId,
          conversationId: (conversationBeforeSend && conversationBeforeSend.id) || "",
          modelId: model.id,
          content,
          requestId: activeRequestId,
          reasoningMode,
        },
        handlers
      );
      this.chatRequest = request;
      return request.promise
        .catch((error) => {
          if (error && error.errCode === "AI_REQUEST_ALREADY_USED" && canRefreshRequestId) {
            const nextRequestId = uniqueRequestId();
            const current = this.data.messages[assistantIndex] || assistantMessage;
            const next = decorateMessage(Object.assign({}, current, {
              content: "",
              reasoningContent: "",
              reasoningExpanded: false,
              reasoningBodyStarted: false,
              reasoningManual: false,
              reasoningStreaming: false,
              reasoningStartedAtMs: Date.now(),
              reasoningDurationMs: 0,
              reasoningDurationText: "",
              reasoningTimingActive: false,
              status: "generating",
              errorCode: "",
              errorText: "",
              requestId: nextRequestId,
            }));
            this.resetLiveStreamForRetry(assistantIndex, next);
            this.setData({
              currentConversation: conversationBeforeSend || null,
              [`messages[${assistantIndex}]`]: next,
              scrollIntoView: next.anchorId,
            });
            return runAttempt(nextRequestId, false);
          }
          throw error;
        });
    };

    runAttempt(requestId, true)
      .catch((error) => {
        const cancelled = error && error.errCode === "AI_CANCELLED";
        this.freezeReasoningDuration(
          assistantIndex,
          error && error.details && error.details.reasoningDurationMs
        );
        const snapshot = this.finishLiveStream();
        if (error && error.errCode === "AI_CONSENT_REQUIRED" && error.details) {
          this.setData({ messages: this.data.messages.slice(0, Math.max(0, assistantIndex - 1)) });
          this.requestConsent(model, content, error.details);
          return;
        }
        if (!generationStarted) {
          this.setData({
            messages: this.data.messages.slice(0, Math.max(0, assistantIndex - 1)),
            inputValue: content,
          });
          wx.showToast({ title: generationErrorText(error), icon: "none" });
          return;
        }
        const current = this.data.messages[assistantIndex] || assistantMessage;
        const partialContent = String((snapshot && snapshot.content) || current.content || "");
        const partialReasoning = String((snapshot && snapshot.reasoningContent) || current.reasoningContent || "");
        const next = decorateMessage(Object.assign({}, current, {
          content: partialContent,
          reasoningContent: partialReasoning,
          status: cancelled ? "cancelled" : "failed",
          reasoningStreaming: false,
          reasoningTimingActive: false,
          errorCode: (error && error.errCode) || "AI_GENERATION_FAILED",
          errorText: !cancelled && (partialContent || partialReasoning)
            ? "回答在这里中断，可重新生成"
            : generationErrorText(error),
        }));
        this.setData({ [`messages[${assistantIndex}]`]: next });
      })
      .finally(() => {
        this.chatRequest = null;
        this.sendLock = false;
        this.setData({ sending: false, stopping: false });
      });
  },

  stopGenerating() {
    if (!this.chatRequest || this.data.stopping) return;
    if (Date.now() - Number(this.generationStartedAt || 0) < 700) return;
    if (typeof this.chatRequest.stop !== "function") {
      this.chatRequest.abort();
      return;
    }
    this.setData({ stopping: true });
    this.chatRequest.stop()
      .catch((error) => {
        wx.showToast({ title: error.message || "暂时无法停止，请稍后重试", icon: "none" });
      })
      .finally(() => {
        if (this.data.sending) this.setData({ stopping: false });
      });
  },

  copyMessage(e) {
    const message = this.data.messages.find((item) => item.id === e.currentTarget.dataset.id);
    if (message) wx.setClipboardData({ data: message.content || "" });
  },

  toggleReasoning(e) {
    const index = Number(e.currentTarget.dataset.index);
    const message = this.data.messages[index];
    if (!message || !message.hasReasoningContent) return;
    this.setData({
      [`messages[${index}].reasoningExpanded`]: !message.reasoningExpanded,
      [`messages[${index}].reasoningManual`]: true,
    });
  },

  regenerateMessage(e) {
    if (this.data.sending) return;
    const index = this.data.messages.findIndex((item) => item.id === e.currentTarget.dataset.id);
    if (index < 1) return;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (this.data.messages[cursor].role === "user") {
        this.submitContent(this.data.messages[cursor].content);
        return;
      }
    }
  },

  reportMessage(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data.reportBusyId) return;
    if (!id || /^assistant-ai_/.test(id)) {
      wx.showToast({ title: "回答保存后才能举报", icon: "none" });
      return;
    }
    wx.showActionSheet({
      itemList: ["回答不准确", "内容不合适", "可能存在风险"],
      success: (result) => {
        const reason = ["回答不准确", "内容不合适", "可能存在风险"][result.tapIndex];
        this.setData({ reportBusyId: id });
        api
          .reportAiMessage(this.data.circleId, id, reason, "")
          .then(() => wx.showToast({ title: "已提交反馈", icon: "success" }))
          .catch((error) => wx.showToast({ title: error.message || "提交失败", icon: "none" }))
          .finally(() => this.setData({ reportBusyId: "" }));
      },
    });
  },

  goBack() {
    wx.navigateBack();
  },
});
