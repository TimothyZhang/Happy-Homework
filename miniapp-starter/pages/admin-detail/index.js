// 用户详情页 — 完整资料 + 调整金币表单 + 调整 / coinLogs 历史。

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
    // logs
    adjustments: [],
    coinLogs: [],
    canUseCloud: typeof wx.cloud !== 'undefined'
  },

  onLoad(query) {
    const openid = decodeURIComponent(query.openid || '')
    if (!openid) {
      this.setData({ loading: false, error: '缺少 openid 参数' })
      return
    }
    this.setData({ openid })
    this.refresh()
  },

  async refresh() {
    if (!this.data.canUseCloud) {
      this.setData({ loading: false, error: '云开发未启用' })
      return
    }
    this.setData({ loading: true, error: '' })
    try {
      const [userRes, logRes] = await Promise.all([
        wx.cloud.callFunction({
          name: 'adminPanel',
          data: { action: 'getUser', openid: this.data.openid }
        }),
        wx.cloud.callFunction({
          name: 'adminPanel',
          data: { action: 'listAdjustments', targetOpenid: this.data.openid, limit: 50 }
        })
      ])

      const userResult = (userRes && userRes.result) || {}
      if (!userResult.ok) {
        const msg = userResult.reason === 'not_admin' ? '当前账号不是管理员'
          : userResult.reason === 'not_found' ? '未找到该用户的云端数据'
          : (userResult.reason || '加载失败')
        this.setData({ loading: false, error: msg })
        return
      }

      const summary = userResult.summary || {}
      summary.shortOpenid = shortenOpenid(summary.openid)
      summary.displayName = summary.nickname || '(未设置昵称)'
      summary.avatarInitial = (summary.nickname && summary.nickname[0]) || '?'
      summary.petDisplayName = (summary.pet && summary.pet.name) || '(未起名)'

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
        adminShort: shortenOpenid(r.adminOpenid)
      }))

      this.setData({
        loading: false,
        summary,
        state,
        sessionId: userResult.sessionId || '',
        updatedAtDisplay: formatAbsTime(userResult.updatedAt),
        claimedAtDisplay: formatAbsTime(userResult.claimedAt),
        coinLogs: coinLogsDisplay,
        adjustments
      })
    } catch (e) {
      console.error('[admin-detail] load failed', e)
      this.setData({
        loading: false,
        error: '加载失败:' + ((e && e.errMsg) || String(e))
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
      wx.showToast({ title: '请输入非零整数', icon: 'none' })
      return
    }
    const reason = (this.data.reasonInput || '').trim()
    if (!reason) {
      wx.showToast({ title: '请填写调整原因', icon: 'none' })
      return
    }

    const confirmContent =
      `${delta > 0 ? '增加' : '减少'} ${Math.abs(delta)} 金币\n\n` +
      `调整会进入用户的待领取队列,用户下次打开 App 自动到账(失败也不会丢)。`

    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '确认调整',
        content: confirmContent,
        confirmText: '确认',
        cancelText: '取消',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false)
      })
    })
    if (!confirmed) return

    this.setData({ submitting: true })
    wx.showLoading({ title: '提交中…', mask: true })
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
        const msg = result.reason === 'not_admin' ? '当前账号不是管理员'
          : result.reason === 'not_found' ? '未找到该用户'
          : result.reason === 'invalid_delta' ? '金币变化值无效'
          : result.reason === 'delta_too_large' ? '单次变化超过上限'
          : (result.message || result.reason || '调整失败')
        wx.showToast({ title: msg, icon: 'none', duration: 2200 })
        return
      }
      wx.showToast({
        title: `已加入待领取队列(${delta > 0 ? '+' : ''}${delta})`,
        icon: 'none',
        duration: 2400
      })
      this.setData({ deltaInput: '', reasonInput: '' })
      await this.refresh()
    } catch (e) {
      wx.hideLoading()
      console.error('[admin-detail] adjustCoins failed', e)
      wx.showToast({ title: '调整出错:' + ((e && e.errMsg) || String(e)), icon: 'none', duration: 2400 })
    } finally {
      this.setData({ submitting: false })
    }
  },

  handleCopyOpenid() {
    if (!this.data.openid) return
    wx.setClipboardData({ data: this.data.openid })
  }
})
