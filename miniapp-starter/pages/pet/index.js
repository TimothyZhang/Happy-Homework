const store = require('../../utils/store')
const cloudSync = require('../../utils/cloud-sync')

Page({
  data: {
    pet: {},
    coins: 0,
    shopItems: []
  },

  onShow() {
    const tb = typeof this.getTabBar === 'function' && this.getTabBar()
    if (tb) tb.setData({ selected: 3 })
    this.refreshState()
    cloudSync.hydrateIfStale().then((r) => {
      if (r && r.changed) this.refreshState()
    }).catch(() => {})
  },

  refreshState() {
    const state = store.getStateWithComputed()
    this.setData({
      pet: state.pet,
      coins: state.coins,
      shopItems: state.shopItems
    })
  },

  handleBuyItem(event) {
    const { id } = event.currentTarget.dataset
    const before = store.getStateWithComputed()
    const item = before.shopItems.find((shopItem) => shopItem.id === id)
    if (before.coins < item.price) {
      wx.showToast({ title: '金币不够', icon: 'none' })
      return
    }

    store.buyItem(id)
    this.refreshState()
    wx.showToast({ title: `${item.name} 已购买`, icon: 'success' })
  }
})