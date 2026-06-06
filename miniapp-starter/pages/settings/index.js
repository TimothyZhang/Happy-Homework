const i18n = require('../../utils/i18n')
const cloudSync = require('../../utils/cloud-sync')

Page({
  data: {
    t: {},
    lang: 'en',
    syncStatus: { status: 'unknown', readOnly: false, lastSyncDisplay: '', lastError: null },
    syncing: false
  },

  onShow() {
    this.setData({
      t: i18n.dict(),
      lang: i18n.getLang(),
      syncStatus: cloudSync.getSyncStatus()
    })
    wx.setNavigationBarTitle({ title: i18n.t('set_title') })
    cloudSync.hydrateIfStale().then(() => this.refreshSyncStatus()).catch(() => {})
  },

  // 切换语言:写本地 + 重注入当前页字典;其它页/tabbar 各自 onShow 时更新。
  setLang(e) {
    const l = e.currentTarget.dataset.lang
    if (l === this.data.lang) return
    i18n.setLang(l)
    this.setData({ t: i18n.dict(), lang: i18n.getLang() })
    wx.setNavigationBarTitle({ title: i18n.t('set_title') })
    const tb = typeof this.getTabBar === 'function' && this.getTabBar()
    if (tb && tb.setData) tb.setData({ t: i18n.dict() })
  },

  goOrgTags() {
    wx.navigateTo({ url: '/pages/org-tags/index' })
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
        wx.showToast({ title: i18n.t('prof_sync_fail', { e: status.lastError }), icon: 'none', duration: 2400 })
      } else {
        wx.showToast({ title: i18n.t('sync_synced'), icon: 'success' })
      }
    } catch (e) {
      wx.showToast({ title: i18n.t('prof_sync_error'), icon: 'none' })
    } finally {
      this.setData({ syncing: false })
    }
  },

  handleReclaim() {
    if (this.data.syncing) return
    wx.showModal({
      title: i18n.t('prof_switch_title'),
      content: i18n.t('prof_switch_content'),
      confirmText: i18n.t('prof_switch_confirm'),
      cancelText: i18n.t('prof_cancel'),
      success: async (r) => {
        if (!r.confirm) return
        this.setData({ syncing: true })
        try {
          const ok = await cloudSync.reclaim()
          this.refreshSyncStatus()
          if (ok) {
            wx.showToast({ title: i18n.t('prof_switch_done'), icon: 'success', duration: 2000 })
          } else {
            const status = cloudSync.getSyncStatus()
            wx.showToast({ title: i18n.t('prof_switch_fail') + (status.lastError ? ': ' + status.lastError : ''), icon: 'none', duration: 2400 })
          }
        } catch (e) {
          wx.showToast({ title: i18n.t('prof_switch_error') + ': ' + ((e && e.errMsg) || e || i18n.t('prof_unknown_err')), icon: 'none', duration: 2400 })
        } finally {
          this.setData({ syncing: false })
        }
      }
    })
  }
})
