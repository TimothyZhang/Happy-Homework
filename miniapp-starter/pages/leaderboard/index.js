const perf = require('../../utils/perf')
const i18n = require('../../utils/i18n')

Page({
  onShow() {
    const stamp = perf.markPageShow('leaderboard')
    const tabBar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (tabBar && tabBar.setData) tabBar.setData({ selected: 1 })
    this.setData({ t: i18n.dict() })
    wx.setNavigationBarTitle({ title: i18n.t('lb_navtitle') })
    // No data to push — log paint immediately (WXML is static).
    perf.markPaint(stamp)
  }
})
