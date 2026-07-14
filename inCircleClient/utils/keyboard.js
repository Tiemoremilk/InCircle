function finitePixel(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function eventHeight(event) {
  const source = event && event.detail ? event.detail : event || {};
  return finitePixel(source.height);
}

function buildMetrics(tracker) {
  const height = finitePixel(tracker.keyboardHeight);
  return {
    height,
    // The keyboard callback is the only reliable source for fixed surfaces.
    // Some Android devices shrink windowHeight without moving fixed nodes.
    inset: height,
    open: height > 0,
  };
}

function metricsChanged(previous, next) {
  if (!previous) return true;
  return previous.height !== next.height || previous.open !== next.open;
}

function pageStyle(metrics) {
  return `--incircle-keyboard-inset:${metrics.inset}px;`;
}

function commit(page, tracker, force) {
  if (!tracker || !tracker.active) return;
  const next = buildMetrics(tracker);
  if (!force && !metricsChanged(tracker.metrics, next)) return;
  tracker.metrics = next;
  const done = () => {
    if (tracker.active && tracker.onChange) tracker.onChange(next);
  };
  if (!page || typeof page.setData !== "function") {
    done();
    return;
  }
  page.setData(
    {
      incircleKeyboardHeight: next.height,
      incircleKeyboardInset: next.inset,
      incircleKeyboardOpen: next.open,
      incircleKeyboardPageStyle: pageStyle(next),
    },
    done
  );
}

function update(page, event) {
  const tracker = page && page.__incircleKeyboardTracker;
  if (!tracker || !tracker.active) return;
  tracker.keyboardHeight = eventHeight(event);
  commit(page, tracker, false);
}

function attach(page, onChange) {
  if (!page) return;
  const existing = page.__incircleKeyboardTracker;
  if (existing && existing.active) {
    existing.onChange = typeof onChange === "function" ? onChange : null;
    return;
  }
  const tracker = {
    active: true,
    keyboardHeight: 0,
    metrics: null,
    onChange: typeof onChange === "function" ? onChange : null,
    keyboardListener: null,
  };
  const previousData = page.data || {};
  const needsInitialReset =
    finitePixel(previousData.incircleKeyboardHeight) > 0 ||
    finitePixel(previousData.incircleKeyboardInset) > 0 ||
    previousData.incircleKeyboardOpen === true;
  if (!needsInitialReset) tracker.metrics = buildMetrics(tracker);
  tracker.keyboardListener = (event) => update(page, event);
  page.__incircleKeyboardTracker = tracker;
  if (typeof wx.onKeyboardHeightChange === "function") {
    wx.onKeyboardHeightChange(tracker.keyboardListener);
  }
  if (needsInitialReset) commit(page, tracker, true);
}

function detach(page) {
  const tracker = page && page.__incircleKeyboardTracker;
  if (!tracker) return;
  tracker.active = false;
  if (typeof wx.offKeyboardHeightChange === "function" && tracker.keyboardListener) {
    wx.offKeyboardHeightChange(tracker.keyboardListener);
  }
  page.__incircleKeyboardTracker = null;
}

module.exports = {
  attach,
  detach,
  eventHeight,
  update,
};
