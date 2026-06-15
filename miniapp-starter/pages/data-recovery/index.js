// 数据恢复子页:数据同步 + 本地备份 + 云端备份 + 登录记录。
// 从「设置」拆出来集中放,设置页只留一个入口跳进来。逻辑整体从 settings 搬过来,未改行为。
const i18n = require('../../utils/i18n')
const cloudSync = require('../../utils/cloud-sync')
const store = require('../../utils/store')
const cloudBackup = require('../../utils/cloud-backup')

function pad2(n) { return `${n}`.padStart(2, '0') }
// 时间显示成「MM-DD HH:mm」—— 备份/登录可能是几天前的,相对时间不够明确。
function fmtBackupTime(ts) {
  const d = new Date(ts)
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function envLabelKey(env) {
  if (env === 'develop') return 'll_env_develop'
  if (env === 'trial') return 'll_env_trial'
  if (env === 'release') return 'll_env_release'
  return 'll_env_unknown'
}

Page({
  data: {
    t: {},
    syncStatus: { status: 'unknown', readOnly: false, lastSyncDisplay: '', lastError: null },
    syncing: false,
    backups: [],
    cloudBackups: [],
    cloudBackupsLoading: false,
    cloudBackupsLoaded: false,
    logins: [],
    loginsLoading: false,
    loginsLoaded: false
  },

  onShow() {
    this.setData({ t: i18n.dict(), syncStatus: cloudSync.getSyncStatus() })
    wx.setNavigationBarTitle({ title: i18n.t('set_dataRecovery') })
    this.refreshBackups()
    if (!this.data.cloudBackupsLoaded) this.loadCloudBackups()
    if (!this.data.loginsLoaded) this.loadLogins()
    cloudSync.hydrateIfStale().then(() => this.refreshSyncStatus()).catch(() => {})
  },

  // === 同步 ===
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
  },

  // === 本地备份 ===
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

  // === 云端备份 ===
  loadCloudBackups() {
    if (this.data.cloudBackupsLoading) return
    this.setData({ cloudBackupsLoading: true })
    const reasonKey = { 'pre-sync': 'bk_reason_presync', 'daily': 'bk_reason_daily', 'pre-restore': 'bk_reason_prerestore', 'manual': 'bk_reason_manual' }
    cloudBackup.listMine(30).then((rows) => {
      const list = (rows || []).map((r) => ({
        id: r._id,
        timeLabel: fmtBackupTime(r.at || r.clientAt || 0),
        reasonLabel: i18n.t(reasonKey[r.reason] || 'bk_reason_manual'),
        metaLabel: i18n.t('bk_meta', { tasks: r.taskCount || 0, done: r.doneCount || 0 })
      }))
      this.setData({ cloudBackups: list, cloudBackupsLoaded: true, cloudBackupsLoading: false })
    }).catch(() => this.setData({ cloudBackupsLoaded: true, cloudBackupsLoading: false }))
  },

  handleRefreshCloudBackups() {
    this.loadCloudBackups()
  },

  handleRestoreCloudBackup(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.showModal({
      title: i18n.t('cbk_restore_title'),
      content: i18n.t('bk_restore_content'),
      confirmText: i18n.t('bk_restore_confirm'),
      cancelText: i18n.t('prof_cancel'),
      success: (r) => {
        if (!r.confirm) return
        wx.showLoading({ title: i18n.t('ll_loading'), mask: true })
        cloudBackup.getMine(id).then((backup) => {
          wx.hideLoading()
          const okState = backup && backup.state
          const ok = okState ? store.restoreFromState(backup.state) : false
          this.refreshBackups()
          this.refreshSyncStatus()
          wx.showToast({ title: ok ? i18n.t('bk_restored') : i18n.t('prof_unknown_err'), icon: ok ? 'success' : 'none', duration: 1800 })
        }).catch(() => {
          wx.hideLoading()
          wx.showToast({ title: i18n.t('prof_unknown_err'), icon: 'none' })
        })
      }
    })
  },

  // === 登录记录 ===
  loadLogins() {
    if (this.data.loginsLoading) return
    if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) {
      this.setData({ loginsLoaded: true, logins: [] })
      return
    }
    this.setData({ loginsLoading: true })
    wx.cloud.callFunction({ name: 'adminPanel', data: { action: 'listMyLogins', limit: 50 } })
      .then((res) => {
        const r = (res && res.result) || {}
        const rows = (r.rows || []).map((x) => ({
          at: x.at,
          timeLabel: fmtBackupTime(x.at),
          env: x.envVersion || '',
          envLabel: i18n.t(envLabelKey(x.envVersion)),
          device: [x.brand, x.model].filter(Boolean).join(' ') || x.system || '—',
          buildVersion: x.buildVersion || ''
        }))
        this.setData({ logins: rows, loginsLoaded: true, loginsLoading: false })
      })
      .catch(() => this.setData({ loginsLoaded: true, loginsLoading: false }))
  },

  handleRefreshLogins() {
    this.loadLogins()
  }
})
