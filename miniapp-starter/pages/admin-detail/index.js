// 用户详情页 — 完整资料 + 调整金币表单 + 调整 / coinLogs 历史。

const i18n = require('../../utils/i18n')

function pad(n) { return `${n}`.padStart(2, '0') }

function formatAbsTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function shortenOpenid(openid) {
  if (!openid) return ''
  return `${openid.slice(0, 6)}…${openid.slice(-4)}`
}

// 复用主字典里的环境版本标签(develop/trial/release → 开发版/体验版/正式版)。
function envLabelKey(env) {
  if (env === 'develop') return 'll_env_develop'
  if (env === 'trial') return 'll_env_trial'
  if (env === 'release') return 'll_env_release'
  return 'll_env_unknown'
}

// coin_ledger.kind → 标签。新增 kind 时在这里加一行即可。
const LEDGER_KIND_KEYS = {
  task_reward: 'admind_kindTaskReward',
  task_refund: 'admind_kindTaskRefund',
  pet_purchase: 'admind_kindPetPurchase',
  level_upgrade: 'admind_kindLevelUpgrade',
  pet_skin_switch: 'admind_kindPetSkinSwitch',
  admin_coin_claim: 'admind_kindAdminCoinClaim',
  share_reward_claim: 'admind_kindShareReward'
}

function summarizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return ''
  // 常见字段抽出来,其它字段一律 JSON 折叠
  const parts = []
  if (meta.taskId) parts.push(`task:${meta.taskId}`)
  if (meta.itemId) parts.push(`item:${meta.itemId}`)
  if (meta.species) parts.push(`species:${meta.species}`)
  if (meta.level) parts.push(`lv:${meta.level}`)
  if (typeof meta.count === 'number') parts.push(`x${meta.count}`)
  if (meta.reason) parts.push(meta.reason)
  return parts.join(' · ')
}

Page({
  data: {
    openid: '',
    loading: true,
    error: '',
    summary: null,
    state: null,
    sessionId: '',
    updatedAtDisplay: '',
    claimedAtDisplay: '',
    // form
    deltaInput: '',
    reasonInput: '',
    submitting: false,
    // labels
    metaStreakLabel: '',
    metaNotebooksLabel: '',
    metaTasksLabel: '',
    adjustCurrentLabel: '',
    auditRecentLabel: '',
    ledgerCountLabel: '',
    localCountLabel: '',
    // logs
    adjustments: [],
    coinLogs: [],
    ledger: [],
    ledgerTotal: 0,
    ledgerLoading: false,
    logins: [],
    cloudBackups: [],
    t: {},
    canUseCloud: typeof wx.cloud !== 'undefined'
  },

  onLoad(query) {
    const openid = decodeURIComponent(query.openid || '')
    if (!openid) {
      this.setData({ loading: false, error: i18n.t('admind_errorMissingOpenid') })
      return
    }
    this.setData({ openid })
    this.refresh()
  },

  onShow() {
    this.setData({ t: i18n.dict() })
    wx.setNavigationBarTitle({ title: i18n.t('admind_navtitle') })
  },

  async refresh() {
    if (!this.data.canUseCloud) {
      this.setData({ loading: false, error: i18n.t('admind_errorNoCloud') })
      return
    }
    this.setData({ loading: true, error: '' })
    try {
      const [userRes, logRes, ledgerRes, loginRes, cbkRes] = await Promise.all([
        wx.cloud.callFunction({
          name: 'adminPanel',
          data: { action: 'getUser', openid: this.data.openid }
        }),
        wx.cloud.callFunction({
          name: 'adminPanel',
          data: { action: 'listAdjustments', targetOpenid: this.data.openid, limit: 50 }
        }),
        wx.cloud.callFunction({
          name: 'adminPanel',
          data: { action: 'listCoinLedger', targetOpenid: this.data.openid, limit: 100 }
        }),
        wx.cloud.callFunction({
          name: 'adminPanel',
          data: { action: 'listLogins', targetOpenid: this.data.openid, limit: 50 }
        }),
        wx.cloud.callFunction({
          name: 'adminPanel',
          data: { action: 'listUserBackups', targetOpenid: this.data.openid, limit: 30 }
        })
      ])

      const userResult = (userRes && userRes.result) || {}
      if (!userResult.ok) {
        const msg = userResult.reason === 'not_admin' ? i18n.t('admind_errorNotAdmin')
          : userResult.reason === 'not_found' ? i18n.t('admind_errorNotFound')
          : (userResult.reason || i18n.t('admind_errorLoadFail'))
        this.setData({ loading: false, error: msg })
        return
      }

      const summary = userResult.summary || {}
      summary.shortOpenid = shortenOpenid(summary.openid)
      summary.displayName = summary.nickname || i18n.t('admind_noNickname')
      summary.avatarInitial = (summary.nickname && summary.nickname[0]) || '?'
      summary.petDisplayName = (summary.pet && summary.pet.name) || i18n.t('admind_noPetName')

      const state = userResult.state || {}
      const coinLogs = Array.isArray(state.coinLogs) ? state.coinLogs.slice().reverse().slice(0, 100) : []
      const coinLogsDisplay = coinLogs.map((l) => ({
        ...l,
        atDisplay: formatAbsTime(l.at),
        signed: l.delta > 0 ? `+${l.delta}` : `${l.delta}`,
        isAdmin: typeof l.reason === 'string' && l.reason.indexOf('admin-adjust') === 0
      }))

      const logResult = (logRes && logRes.result) || {}
      const adjustments = (logResult.rows || []).map((r) => ({
        ...r,
        createdAtDisplay: formatAbsTime(r.createdAt),
        claimedAtDisplay: r.claimedAt ? formatAbsTime(r.claimedAt) : '',
        signed: r.delta > 0 ? `+${r.delta}` : `${r.delta}`,
        adminShort: shortenOpenid(r.adminOpenid),
        claimLabel: r.claimed ? i18n.t('admind_claimed') : i18n.t('admind_pending'),
        noReasonLabel: i18n.t('admind_noReason'),
        adminPrefix: i18n.t('admind_adminShort', { s: shortenOpenid(r.adminOpenid) }),
        claimedAtLabel: r.claimedAt ? i18n.t('admind_claimedAt', { t: formatAbsTime(r.claimedAt) }) : ''
      }))

      const ledgerResult = (ledgerRes && ledgerRes.result) || {}
      const ledger = (ledgerResult.rows || []).map((r) => ({
        ...r,
        kindLabel: i18n.t(LEDGER_KIND_KEYS[r.kind] || 'admind_kindUnknown') || r.kind || i18n.t('admind_kindUnknown'),
        createdAtDisplay: formatAbsTime(r.createdAt),
        signed: r.delta > 0 ? `+${r.delta}` : `${r.delta}`,
        balanceAfterDisplay: (typeof r.balanceAfter === 'number') ? `${r.balanceAfter}` : '—',
        metaSummary: summarizeMeta(r.meta),
        balanceAfterLabel: i18n.t('admind_balanceAfter', { n: (typeof r.balanceAfter === 'number') ? r.balanceAfter : '—' })
      }))

      const ledgerTotal = typeof ledgerResult.total === 'number' ? ledgerResult.total : ledger.length

      const loginResult = (loginRes && loginRes.result) || {}
      const logins = (loginResult.rows || []).map((r) => ({
        at: r.at,
        timeLabel: formatAbsTime(r.at),
        env: r.envVersion || '',
        envLabel: i18n.t(envLabelKey(r.envVersion)),
        device: [r.brand, r.model].filter(Boolean).join(' ') || r.system || '—',
        buildVersion: r.buildVersion || '',
        sessionShort: shortenOpenid(r.sessionId || '')
      }))

      const REASON_KEYS = { 'pre-sync': 'bk_reason_presync', 'daily': 'bk_reason_daily', 'pre-restore': 'bk_reason_prerestore', 'manual': 'bk_reason_manual' }
      const cbkResult = (cbkRes && cbkRes.result) || {}
      const cloudBackups = (cbkResult.rows || []).map((r) => ({
        at: r.at,
        timeLabel: formatAbsTime(r.at || r.clientAt),
        reasonLabel: i18n.t(REASON_KEYS[r.reason] || 'bk_reason_manual'),
        metaLabel: i18n.t('bk_meta', { tasks: r.taskCount || 0, done: r.doneCount || 0 })
      }))

      this.setData({
        loading: false,
        summary,
        state,
        logins,
        cloudBackups,
        sessionId: userResult.sessionId || '',
        updatedAtDisplay: formatAbsTime(userResult.updatedAt),
        claimedAtDisplay: formatAbsTime(userResult.claimedAt),
        coinLogs: coinLogsDisplay,
        adjustments,
        ledger,
        ledgerTotal,
        metaStreakLabel: i18n.t('admind_metaStreakVal', { n: summary.streakDays }),
        metaNotebooksLabel: i18n.t('admind_metaNotebooksVal', { n: summary.notebookCount }),
        metaTasksLabel: i18n.t('admind_metaTasksVal', { n: summary.taskCount }),
        adjustCurrentLabel: i18n.t('admind_adjustCurrent', { n: summary.coins }),
        auditRecentLabel: i18n.t('admind_auditRecent', { n: adjustments.length }),
        ledgerCountLabel: i18n.t('admind_ledgerCount', { total: ledgerTotal, shown: ledger.length }),
        localCountLabel: i18n.t('admind_localCount', { n: coinLogsDisplay.length })
      })
    } catch (e) {
      console.error('[admin-detail] load failed', e)
      this.setData({
        loading: false,
        error: i18n.t('admind_errorLoadFailDetail', { msg: (e && e.errMsg) || String(e) })
      })
    }
  },

  handleDeltaInput(e) { this.setData({ deltaInput: e.detail.value }) },
  handleReasonInput(e) { this.setData({ reasonInput: e.detail.value }) },

  // 快捷加减按钮
  handleQuickDelta(e) {
    const delta = Number(e.currentTarget.dataset.delta) || 0
    if (!delta) return
    this.setData({ deltaInput: String(delta) })
  },

  async handleSubmit() {
    if (this.data.submitting) return
    const raw = (this.data.deltaInput || '').trim()
    const delta = Math.trunc(Number(raw))
    if (!Number.isFinite(delta) || delta === 0) {
      wx.showToast({ title: i18n.t('admind_toastNeedDelta'), icon: 'none' })
      return
    }
    const reason = (this.data.reasonInput || '').trim()
    if (!reason) {
      wx.showToast({ title: i18n.t('admind_toastNeedReason'), icon: 'none' })
      return
    }

    const changeLabel = delta > 0
      ? i18n.t('admind_confirmAdd', { n: Math.abs(delta) })
      : i18n.t('admind_confirmSub', { n: Math.abs(delta) })
    const confirmContent = `${changeLabel}\n\n${i18n.t('admind_confirmBody')}`

    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: i18n.t('admind_confirmTitle'),
        content: confirmContent,
        confirmText: i18n.t('admind_confirmOk'),
        cancelText: i18n.t('admind_confirmCancel'),
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false)
      })
    })
    if (!confirmed) return

    this.setData({ submitting: true })
    wx.showLoading({ title: i18n.t('admind_submitting'), mask: true })
    try {
      const res = await wx.cloud.callFunction({
        name: 'adminPanel',
        data: {
          action: 'adjustCoins',
          openid: this.data.openid,
          delta,
          reason
        }
      })
      const result = (res && res.result) || {}
      wx.hideLoading()
      if (!result.ok) {
        const msg = result.reason === 'not_admin' ? i18n.t('admind_errorSubmitNotAdmin')
          : result.reason === 'not_found' ? i18n.t('admind_errorSubmitNotFound')
          : result.reason === 'invalid_delta' ? i18n.t('admind_errorSubmitInvalidDelta')
          : result.reason === 'delta_too_large' ? i18n.t('admind_errorSubmitTooLarge')
          : (result.message || result.reason || i18n.t('admind_errorSubmitFail'))
        wx.showToast({ title: msg, icon: 'none', duration: 2200 })
        return
      }
      const signed = `${delta > 0 ? '+' : ''}${delta}`
      wx.showToast({
        title: i18n.t('admind_toastQueued', { signed }),
        icon: 'none',
        duration: 2400
      })
      this.setData({ deltaInput: '', reasonInput: '' })
      await this.refresh()
    } catch (e) {
      wx.hideLoading()
      console.error('[admin-detail] adjustCoins failed', e)
      wx.showToast({
        title: i18n.t('admind_errorSubmitError', { msg: (e && e.errMsg) || String(e) }),
        icon: 'none',
        duration: 2400
      })
    } finally {
      this.setData({ submitting: false })
    }
  },

  handleCopyOpenid() {
    if (!this.data.openid) return
    wx.setClipboardData({ data: this.data.openid })
  }
})
