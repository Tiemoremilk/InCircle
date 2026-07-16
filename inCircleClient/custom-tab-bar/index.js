const theme = require("../utils/theme");

const TAB_BAR_ITEMS = [
  { pagePath: "/pages/index/index", text: "首页", iconPath: "/images/tabbar/home.svg" },
  { pagePath: "/pages/activities/index", text: "约局", iconPath: "/images/tabbar/activities.svg" },
  { pagePath: "/pages/tools/index", text: "工具", iconPath: "/images/tabbar/tools.svg" },
  { pagePath: "/pages/docs/index", text: "资料", iconPath: "/images/tabbar/docs.svg" },
  { pagePath: "/pages/members/index", text: "成员", iconPath: "/images/tabbar/members.svg" },
];

Component({
  data: {
    list: TAB_BAR_ITEMS,
    hidden: false,
    themeReady: false,
    themeClass: "",
    tabBarStyle: theme.getTabBarStyle(),
    currentPath: "",
    selectedIndex: -1,
    switchingPath: "",
  },

  lifetimes: {
    attached() {
      this.tabBarAlive = true;
      theme.registerCustomTabBar(this);
      this.refresh({ ready: true, waitForRender: true });
    },
    detached() {
      this.tabBarAlive = false;
      theme.unregisterCustomTabBar(this);
    },
  },

  methods: {
    refreshTheme(options) {
      return this.refresh(Object.assign({}, options || {}, { themeOnly: true }));
    },

    refresh(options) {
      const settings = options || {};
      const currentTheme = settings.theme || theme.getCurrentTheme();
      const tabBarStyle = theme.getTabBarStyle(currentTheme);
      const nextData = {};
      const themeOnly = !!settings.themeOnly;
      if (!themeOnly) {
        const currentPath = settings.currentPath ? settings.currentPath : this.getCurrentPath();
        const selectedIndex = TAB_BAR_ITEMS.findIndex((item) => item.pagePath === currentPath);
        if (this.data.currentPath !== currentPath) nextData.currentPath = currentPath;
        if (this.data.selectedIndex !== selectedIndex) nextData.selectedIndex = selectedIndex;
      }
      const themeClass = `${currentTheme.className}${settings.suppressMotion ? " incircle-theme-sync" : ""}`;
      if (this.data.themeClass !== themeClass) nextData.themeClass = themeClass;
      if (this.data.tabBarStyle !== tabBarStyle) nextData.tabBarStyle = tabBarStyle;
      if (typeof settings.revision === "number" && this.data.themeRevision !== settings.revision) {
        nextData.themeRevision = settings.revision;
      }
      if ((settings.ready || settings.waitForRender) && !this.data.themeReady) nextData.themeReady = true;
      if (!Object.keys(nextData).length) return Promise.resolve(true);
      if (settings.waitForRender) {
        return new Promise((resolve) => {
          if (!this.tabBarAlive) {
            resolve(true);
            return;
          }
          this.setData(nextData, () => resolve(true));
        });
      }
      this.setData(nextData);
      return Promise.resolve(true);
    },

    getCurrentPath() {
      const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];
      const currentPage = pages[pages.length - 1];
      return currentPage && currentPage.route ? `/${currentPage.route}` : "";
    },

    switchTab(event) {
      const path = event.currentTarget.dataset.path;
      const index = Number(event.currentTarget.dataset.index);
      if (!path || path === this.data.currentPath || path === this.data.switchingPath) return;
      const performSwitch = () => {
        if (!this.tabBarAlive || path === this.data.switchingPath) return;
        this.setData({
          selectedIndex: Number.isNaN(index) ? this.data.selectedIndex : index,
          currentPath: path,
          switchingPath: path,
        });
        wx.switchTab({
          url: path,
          complete: () => {
            if (this.tabBarAlive && this.data.switchingPath === path) {
              this.setData({ switchingPath: "" });
            }
          },
        });
      };
      if (theme.isThemeTransitioning()) {
        theme.whenThemeReady().then(performSwitch);
        return;
      }
      performSwitch();
    },
  },
});
