Page({
  onShow() {
    const tabBar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (tabBar && tabBar.setData) tabBar.setData({ selected: 2 })
  }
})
