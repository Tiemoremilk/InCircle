Component({
  options: {
    styleIsolation: "isolated",
  },

  properties: {
    kind: {
      type: String,
      value: "generic",
    },
    icon: {
      type: String,
      value: "/images/ui-icons/notice.png",
    },
    eyebrow: {
      type: String,
      value: "",
    },
    title: {
      type: String,
      value: "这里还没有内容",
    },
    description: {
      type: String,
      value: "有新内容后，会自动整理在这里。",
    },
    actionText: {
      type: String,
      value: "",
    },
    spacious: {
      type: Boolean,
      value: false,
    },
    compact: {
      type: Boolean,
      value: false,
    },
    embedded: {
      type: Boolean,
      value: false,
    },
    mini: {
      type: Boolean,
      value: false,
    },
  },

  methods: {
    onAction() {
      if (!this.data.actionText) return;
      this.triggerEvent("action");
    },
  },
});
