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
    themeClass: theme.getCurrentTheme().className,
    tabBarStyle: theme.getTabBarStyle(),
    currentPath: "",
    selectedIndex: -1,
    switchingPath: "",
  },

  lifetimes: {
    attached() {
      this.refresh();
    },
  },

  methods: {
    refresh(options) {
      const currentTheme = theme.getCurrentTheme();
      const currentPath = options && options.currentPath ? options.currentPath : this.getCurrentPath();
      const selectedIndex = TAB_BAR_ITEMS.findIndex((item) => item.pagePath === currentPath);
      const tabBarStyle = theme.getTabBarStyle();
      const nextData = {};
      if (this.data.currentPath !== currentPath) nextData.currentPath = currentPath;
      if (this.data.selectedIndex !== selectedIndex) nextData.selectedIndex = selectedIndex;
      if (this.data.themeClass !== currentTheme.className) nextData.themeClass = currentTheme.className;
      if (this.data.tabBarStyle !== tabBarStyle) nextData.tabBarStyle = tabBarStyle;
      if (Object.keys(nextData).length) this.setData(nextData);
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
      this.setData({
        selectedIndex: Number.isNaN(index) ? this.data.selectedIndex : index,
        currentPath: path,
        switchingPath: path,
      });
      wx.switchTab({
        url: path,
        complete: () => {
          if (this.data.switchingPath === path) {
            this.setData({ switchingPath: "" });
          }
        },
      });
    },
  },
});
