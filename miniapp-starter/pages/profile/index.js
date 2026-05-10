const cloudSync = require('../../utils/cloud-sync')

Page({
  data: {
    syncStatus: { status: 'unknown', readOnly: false, lastSyncDisplay: '从未', lastError: null, inflight: false },
    syncing: false
  },

  onShow() {
    const tb = typeof this.getTabBar === 'function' && this.getTabBar()
    if (tb) tb.setData({ selected: 4 })
    this.refreshSyncStatus()
    cloudSync.hydrateIfStale().then(() => {
      this.refreshSyncStatus()
    }).catch(() => {})
  },

  refreshSyncStatus() {
    this.setData({ syncStatus: cloudSync.getSyncStatus() })
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
    if (this.data.syncing) return
    wx.showModal({
      title: '切回此设备',
      content: '会以云端最新数据覆盖本机当前 state，并踢下线另一台设备。继续？',
      // confirmText/cancelText must be ≤4 chars — longer values silently fail
      // to render the modal on some basic library versions, leaving the user
      // staring at an unresponsive button.
      confirmText: '切回',
      cancelText: '取消',
      success: async (r) => {
        if (!r.confirm) return
        this.setData({ syncing: true })
        try {
          const ok = await cloudSync.reclaim()
          this.refreshSyncStatus()
          wx.showToast({
            title: ok ? '已切回此设备' : '切回失败',
            icon: ok ? 'success' : 'none',
            duration: 2000
          })
        } catch (e) {
          console.warn('[profile] reclaim threw', e)
          wx.showToast({
            title: '切回出错：' + ((e && e.errMsg) || e || '未知错误'),
            icon: 'none',
            duration: 2400
          })
        } finally {
          this.setData({ syncing: false })
        }
      },
      fail: (err) => {
        console.warn('[profile] reclaim modal failed', err)
        wx.showToast({
          title: '弹窗打开失败：' + ((err && err.errMsg) || '未知错误'),
          icon: 'none',
          duration: 2400
        })
      }
    })
  }
})
