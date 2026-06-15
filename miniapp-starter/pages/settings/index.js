const i18n = require('../../utils/i18n')
const cloudSync = require('../../utils/cloud-sync')
const store = require('../../utils/store')

function pad2(n) { return `${n}`.padStart(2, '0') }
// 备份时间显示成「MM-DD HH:mm」—— 备份可能是几天前的,相对时间不够明确。
function fmtBackupTime(ts) {
  const d = new Date(ts)
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

Page({
  data: {
    t: {},
    lang: 'en',
    syncStatus: { status: 'unknown', readOnly: false, lastSyncDisplay: '', lastError: null },
    syncing: false,
    backups: []
  },

  onShow() {
    this.setData({
      t: i18n.dict(),
      lang: i18n.getLang(),
      syncStatus: cloudSync.getSyncStatus()
    })
    wx.setNavigationBarTitle({ title: i18n.t('set_title') })
    this.refreshBackups()
    cloudSync.hydrateIfStale().then(() => this.refreshSyncStatus()).catch(() => {})
  },

  refreshBackups() {
    const reasonKey = { 'pre-sync': 'bk_reason_presync', 'daily': 'bk_reason_daily', 'pre-restore': 'bk_reason_prerestore', 'manual': 'bk_reason_manual' }
    const rows = store.listBackups().map((r) => ({
      at: r.at,
      timeLabel: fmtBackupTime(r.at),
      reasonLabel: i18n.t(reasonKey[r.reason] || 'bk_reason_manual'),
      metaLabel: i18n.t('bk_meta', { tasks: r.taskCount, done: r.doneCount })
    }))
    this.setData({ backups: rows })
  },

  handleBackupNow() {
    store.backupLocalState('manual')
    this.refreshBackups()
    wx.showToast({ title: i18n.t('bk_backed_up'), icon: 'success', duration: 1500 })
  },

  handleRestoreBackup(e) {
    const at = Number(e.currentTarget.dataset.at)
    if (!at) return
    wx.showModal({
      title: i18n.t('bk_restore_title'),
      content: i18n.t('bk_restore_content'),
      confirmText: i18n.t('bk_restore_confirm'),
      cancelText: i18n.t('prof_cancel'),
      success: (r) => {
        if (!r.confirm) return
        const ok = store.restoreBackup(at)
        this.refreshBackups()
        this.refreshSyncStatus()
        wx.showToast({ title: ok ? i18n.t('bk_restored') : i18n.t('prof_unknown_err'), icon: ok ? 'success' : 'none', duration: 1800 })
      }
    })
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
