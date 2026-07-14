const api = require("../../utils/api");
const theme = require("../../utils/theme");

const TAB_ROUTES = {
  "pages/index/index": true,
  "pages/activities/index": true,
  "pages/tools/index": true,
  "pages/docs/index": true,
  "pages/members/index": true,
};
const FAB_RPX = 88;
const EDGE_INSET_RPX = 10;
const STORAGE_PREFIX = "incircleAiFabPosition:";

function currentCircleId() {
  try {
    const app = getApp();
    return (app && app.globalData && app.globalData.currentCircleId) || "";
  } catch (error) {
    return "";
  }
}

function currentRoute() {
  try {
    const pages = getCurrentPages();
    return pages.length ? pages[pages.length - 1].route || "" : "";
  } catch (error) {
    return "";
  }
}

Component({
  properties: {
    targetCircleId: {
      type: String,
      value: "",
      observer() {
        if (this.metrics) this.refresh();
      },
    },
  },

  data: {
    visible: false,
    positionReady: false,
    motionReady: false,
    circleId: "",
    positionStyle: "transform: translate3d(0px, 0px, 0);",
    pressed: false,
    snapping: false,
    docked: false,
    dockSide: "right",
    reduceMotion: false,
    visualStyle: "--theme-primary: #2f7d50; --theme-primary-dark: #1c5638; --theme-hero-shadow: rgba(47, 125, 80, 0.24);",
  },

  lifetimes: {
    attached() {
      this.componentAlive = true;
      this.drag = null;
      this.snapTimer = null;
      this.transitionTimer = null;
      this.motionTimer = null;
      this.refreshRequest = null;
      this.refreshCircleId = "";
      this.refreshToken = 0;
      this.positionCircleId = "";
      this.keyboardHeight = 0;
      this.beforeKeyboardPosition = null;
      this.keyboardHandler = (event) => this.onKeyboardHeight(event);
      if (typeof wx.onKeyboardHeightChange === "function") wx.onKeyboardHeightChange(this.keyboardHandler);
      this.metrics = this.readMetrics();
      this.applyTheme();
      this.setData({ reduceMotion: this.metrics.reduceMotion });
      this.refresh();
    },
    detached() {
      this.componentAlive = false;
      this.refreshToken += 1;
      if (this.snapTimer) clearTimeout(this.snapTimer);
      if (this.transitionTimer) clearTimeout(this.transitionTimer);
      if (this.motionTimer) clearTimeout(this.motionTimer);
      this.snapTimer = null;
      this.transitionTimer = null;
      this.motionTimer = null;
      if (this.keyboardHandler && typeof wx.offKeyboardHeightChange === "function") {
        wx.offKeyboardHeightChange(this.keyboardHandler);
      }
      this.keyboardHandler = null;
    },
  },

  pageLifetimes: {
    show() {
      this.metrics = this.readMetrics();
      this.applyTheme();
      this.refresh();
    },
    hide() {
      if (this.snapTimer) clearTimeout(this.snapTimer);
      if (this.transitionTimer) clearTimeout(this.transitionTimer);
      this.snapTimer = null;
      this.transitionTimer = null;
    },
  },

  methods: {
    applyTheme() {
      const current = theme.getCurrentTheme();
      this.setData({
        visualStyle: `--theme-primary: ${current.primary}; --theme-primary-dark: ${current.primaryDark}; --theme-hero-shadow: ${current.primary}3d;`,
      });
    },

    readMetrics() {
      let info = {};
      try {
        info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      } catch (error) {
        info = { windowWidth: 375, windowHeight: 667 };
      }
      const width = info.windowWidth || 375;
      const height = info.windowHeight || 667;
      const fab = (FAB_RPX * width) / 750;
      const edgeInset = Math.max(4, (EDGE_INSET_RPX * width) / 750);
      const safeBottom = info.safeArea && info.safeArea.bottom ? Math.max(0, height - info.safeArea.bottom) : 0;
      const bottomReserve = TAB_ROUTES[currentRoute()] ? 58 + safeBottom : 18 + safeBottom;
      const keyboardReserve = this.keyboardHeight > 0 ? this.keyboardHeight + 14 : bottomReserve;
      return {
        width,
        height,
        fab,
        minX: edgeInset,
        maxX: Math.max(edgeInset, width - fab - edgeInset),
        minY: 18,
        maxY: Math.max(80, height - fab - keyboardReserve),
        reduceMotion: !!(info.reduceMotionEnabled || info.reducedMotion),
      };
    },

    onKeyboardHeight(event) {
      const nextHeight = Math.max(0, Number((event && event.height) || 0));
      if (nextHeight > 0 && !this.keyboardHeight && this.position) {
        this.beforeKeyboardPosition = Object.assign({}, this.position);
      }
      this.keyboardHeight = nextHeight;
      this.metrics = this.readMetrics();
      if (!this.position) return;
      if (!nextHeight && this.beforeKeyboardPosition) {
        const restore = this.beforeKeyboardPosition;
        this.beforeKeyboardPosition = null;
        this.setPosition(restore.x, restore.y, false);
      } else {
        this.setPosition(this.position.x, this.position.y, false);
      }
    },

    refresh() {
      if (!TAB_ROUTES[currentRoute()]) {
        this.refreshToken += 1;
        this.refreshRequest = null;
        this.refreshCircleId = "";
        this.setData({ visible: false });
        return Promise.resolve();
      }
      const circleId = this.properties.targetCircleId || currentCircleId();
      if (!circleId) {
        this.refreshToken += 1;
        this.refreshRequest = null;
        this.refreshCircleId = "";
        this.position = null;
        this.positionCircleId = "";
        this.setData({
          visible: false,
          positionReady: false,
          motionReady: false,
          circleId: "",
          docked: false,
          snapping: false,
        });
        return Promise.resolve();
      }

      if (this.positionCircleId && this.positionCircleId !== circleId) {
        this.refreshToken += 1;
        this.refreshRequest = null;
        this.refreshCircleId = "";
        if (this.snapTimer) clearTimeout(this.snapTimer);
        if (this.transitionTimer) clearTimeout(this.transitionTimer);
        if (this.motionTimer) clearTimeout(this.motionTimer);
        this.snapTimer = null;
        this.transitionTimer = null;
        this.motionTimer = null;
        this.position = null;
        this.positionCircleId = "";
        this.setData({
          visible: false,
          positionReady: false,
          motionReady: false,
          circleId,
          docked: false,
          snapping: false,
        });
      }

      if (this.refreshRequest && this.refreshCircleId === circleId) return this.refreshRequest;

      const refreshToken = ++this.refreshToken;
      this.refreshCircleId = circleId;
      const request = api
        .getAiStatus(circleId)
        .then((status) => {
          const activeCircleId = this.properties.targetCircleId || currentCircleId();
          if (!this.componentAlive || refreshToken !== this.refreshToken) return;
          if (!status || !status.canChat || activeCircleId !== circleId) {
            this.setData({ visible: false, circleId });
            return;
          }
          this.showAtSavedPosition(circleId);
        })
        .catch(() => {
          if (this.componentAlive && refreshToken === this.refreshToken) {
            this.setData({ visible: false, circleId });
          }
        });
      this.refreshRequest = request;
      request.then(() => {
        if (this.refreshRequest === request) {
          this.refreshRequest = null;
          this.refreshCircleId = "";
        }
      });
      return request;
    },

    clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    },

    setPosition(x, y, snapping) {
      const metrics = this.metrics || this.readMetrics();
      const numericX = Number(x);
      const numericY = Number(y);
      this.position = {
        x: this.clamp(Number.isFinite(numericX) ? numericX : metrics.maxX, metrics.minX, metrics.maxX),
        y: this.clamp(Number.isFinite(numericY) ? numericY : metrics.height * 0.56, metrics.minY, metrics.maxY),
      };
      this.setData({
        positionStyle: `transform: translate3d(${this.position.x}px, ${this.position.y}px, 0);`,
        snapping: !!snapping,
      });
    },

    showAtSavedPosition(circleId) {
      if (this.positionCircleId !== circleId || !this.position) {
        const restoredDock = this.restorePosition(circleId);
        if (!restoredDock) this.scheduleSnap();
        return;
      }

      const metrics = this.metrics || this.readMetrics();
      const x = this.data.docked
        ? this.data.dockSide === "left"
          ? metrics.minX
          : metrics.maxX
        : this.clamp(this.position.x, metrics.minX, metrics.maxX);
      const y = this.clamp(this.position.y, metrics.minY, metrics.maxY);
      this.position = { x, y };
      this.setData({
        visible: true,
        positionReady: true,
        circleId,
        positionStyle: `transform: translate3d(${x}px, ${y}px, 0);`,
      });
      if (!this.data.motionReady) this.enableMotion(circleId);
      if (!this.data.docked) this.scheduleSnap();
    },

    restorePosition(circleId) {
      const metrics = this.metrics || this.readMetrics();
      let stored = null;
      try {
        stored = wx.getStorageSync(`${STORAGE_PREFIX}${circleId}`) || null;
      } catch (error) {
        stored = null;
      }
      const side = stored && stored.side === "left" ? "left" : "right";
      const x = side === "left" ? metrics.minX : metrics.maxX;
      const y = stored && Number.isFinite(Number(stored.y)) ? Number(stored.y) : metrics.height * 0.56;
      this.position = {
        x: this.clamp(x, metrics.minX, metrics.maxX),
        y: this.clamp(y, metrics.minY, metrics.maxY),
      };
      this.positionCircleId = circleId;
      this.setData(
        {
          visible: true,
          positionReady: true,
          motionReady: false,
          circleId,
          positionStyle: `transform: translate3d(${this.position.x}px, ${this.position.y}px, 0);`,
          snapping: false,
          docked: !!stored,
          dockSide: side,
        },
        () => this.enableMotion(circleId)
      );
      return !!stored;
    },

    enableMotion(circleId) {
      if (this.motionTimer) clearTimeout(this.motionTimer);
      this.motionTimer = setTimeout(() => {
        this.motionTimer = null;
        if (!this.componentAlive || this.positionCircleId !== circleId || !this.data.positionReady) return;
        this.setData({ motionReady: true });
      }, 16);
    },

    savePosition() {
      if (!this.position || !this.data.circleId) return;
      const side = this.position.x + this.metrics.fab / 2 < this.metrics.width / 2 ? "left" : "right";
      try {
        wx.setStorageSync(`${STORAGE_PREFIX}${this.data.circleId}`, { side, y: Math.round(this.position.y) });
      } catch (error) {
        // Local position persistence is optional.
      }
    },

    scheduleSnap() {
      if (this.snapTimer) clearTimeout(this.snapTimer);
      this.snapTimer = setTimeout(() => this.snapToEdge(), 1200);
    },

    snapToEdge() {
      if (!this.position || this.drag) return;
      const center = this.position.x + this.metrics.fab / 2;
      const side = center < this.metrics.width / 2 ? "left" : "right";
      const x = side === "left" ? this.metrics.minX : this.metrics.maxX;
      this.setPosition(x, this.position.y, true);
      this.setData({ docked: true, dockSide: side });
      this.savePosition();
      if (this.transitionTimer) clearTimeout(this.transitionTimer);
      this.transitionTimer = setTimeout(() => {
        this.transitionTimer = null;
        if (this.data.snapping) this.setData({ snapping: false });
      }, this.data.reduceMotion ? 0 : 440);
    },

    onTouchStart(event) {
      const touch = event.touches && event.touches[0];
      if (!touch || !this.position) return;
      if (this.snapTimer) clearTimeout(this.snapTimer);
      if (this.transitionTimer) clearTimeout(this.transitionTimer);
      this.snapTimer = null;
      this.transitionTimer = null;
      this.drag = {
        startX: touch.clientX,
        startY: touch.clientY,
        originX: this.position.x,
        originY: this.position.y,
        moved: false,
        wasDocked: this.data.docked,
        dockSide: this.data.dockSide,
      };
      this.setData({ pressed: true, snapping: false, docked: false });
    },

    onTouchMove(event) {
      const touch = event.touches && event.touches[0];
      if (!touch || !this.drag) return;
      const dx = touch.clientX - this.drag.startX;
      const dy = touch.clientY - this.drag.startY;
      if (Math.abs(dx) + Math.abs(dy) > 6) this.drag.moved = true;
      this.setPosition(this.drag.originX + dx, this.drag.originY + dy, false);
    },

    onTouchEnd() {
      if (!this.drag) return;
      const interaction = this.drag;
      const moved = interaction.moved;
      this.drag = null;
      if (!moved) {
        this.setData(
          {
            pressed: false,
            docked: interaction.wasDocked,
            dockSide: interaction.dockSide,
          },
          () => wx.navigateTo({ url: `/pages/ai-chat/index?circleId=${encodeURIComponent(this.data.circleId)}` })
        );
        return;
      }
      this.setData({ pressed: false });
      this.scheduleSnap();
    },

    onTouchCancel() {
      const interaction = this.drag;
      this.drag = null;
      const wasDocked = !!(interaction && interaction.wasDocked);
      this.setData({
        pressed: false,
        docked: wasDocked,
        dockSide: interaction ? interaction.dockSide : this.data.dockSide,
      });
      if (!wasDocked) this.scheduleSnap();
    },
  },
});
