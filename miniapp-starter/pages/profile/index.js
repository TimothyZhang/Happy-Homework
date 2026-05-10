const cloudSync = require('../../utils/cloud-sync')
const store = require('../../utils/store')

Page({
  data: {
    syncStatus: { status: 'unknown', readOnly: false, lastSyncDisplay: '从未', lastError: null, inflight: false },
    syncing: false,
    nickname: ''
  },

  onShow() {
    const tb = typeof this.getTabBar === 'function' && this.getTabBar()
    if (tb) tb.setData({ selected: 4 })
    this.refreshSyncStatus()
    this.refreshProfile()
    cloudSync.hydrateIfStale().then(() => {
      this.refreshSyncStatus()
      this.refreshProfile()
    }).catch(() => {})
  },

  refreshSyncStatus() {
    this.setData({ syncStatus: cloudSync.getSyncStatus() })
  },

  refreshProfile() {
    this.setData({ nickname: store.getProfile().nickname || '' })
  },

  // <input type="nickname"> auto-fills the WeChat nickname when focused.
  handleNicknameInput(e) {
    this.setData({ nickname: e.detail.value })
  },

  handleNicknameBlur(e) {
    const next = (e.detail.value || '').trim()
    const current = (store.getProfile().nickname || '').trim()
    if (next === current) return
    store.updateProfileNickname(next)
    if (next) wx.showToast({ title: '已保存', icon: 'success' })
  },

  goStats() {
    wx.navigateTo({ url: '/pages/stats/index' })
  },

  async handleForceSync() {
    if (this.data.syncing) return
    this.setData({ syncing: true })
    try {
      await cloudSync.forceSync()
      const status = cloudSync.getSyncStatus()
      this.setData({ syncStatus: status })
      if (status.lastError) {
        wx.showToast({ title: '同步失败：' + status.lastError, icon: 'none', duration: 2400 })
      } else {
        wx.showToast({ title: '已同步', icon: 'success' })
      }
    } catch (e) {
      wx.showToast({ title: '同步出错', icon: 'none' })
    } finally {
      this.setData({ syncing: false })
    }
  },

  handleReclaim() {
    wx.showModal({
      title: '切回此设备',
      content: '会以云端最新数据覆盖本机当前 state，并踢下线另一台设备。继续？',
      confirmText: '切回此设备',
      cancelText: '取消',
      success: async (r) => {
        if (!r.confirm) return
        this.setData({ syncing: true })
        try {
          const ok = await cloudSync.reclaim()
          this.refreshSyncStatus()
          wx.showToast({
            title: ok ? '已切回此设备' : '切回失败',
            icon: ok ? 'success' : 'none'
          })
        } finally {
          this.setData({ syncing: false })
        }
      }
    })
  }
})
