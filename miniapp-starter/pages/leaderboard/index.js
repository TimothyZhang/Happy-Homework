const perf = require('../../utils/perf')

Page({
  onShow() {
    const stamp = perf.markPageShow('leaderboard')
    const tabBar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (tabBar && tabBar.setData) tabBar.setData({ selected: 1 })
    // No data to push — log paint immediately (WXML is static).
    perf.markPaint(stamp)
  }
})
