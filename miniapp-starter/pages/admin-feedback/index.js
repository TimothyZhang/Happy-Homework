// 管理后台·反馈列表 —— 拉 adminPanel.listFeedback(管理员限定)。非管理员被云函数挡。
const i18n = require('../../utils/i18n')

const PAGE_SIZE = 30

function formatRelativeTime(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 30 * 1000) return i18n.t('sync_just_now')
  if (diff < 60 * 1000) return i18n.t('sync_sec_ago', { n: Math.floor(diff / 1000) })
  if (diff < 60 * 60 * 1000) return i18n.t('sync_min_ago', { n: Math.floor(diff / 60000) })
  if (diff < 24 * 60 * 60 * 1000) return i18n.t('sync_hr_ago', { n: Math.floor(diff / 3600000) })
  const d = new Date(ts)
  const pad = (n) => `${n}`.padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function decorate(row) {
  return {
    id: row._id || (row.createdAt + '-' + (row._openid || '').slice(-4)),
    text: row.text || '',
    nickname: row.nickname || i18n.t('afb_anon'),
    contactLabel: row.contact ? i18n.t('afb_contact', { c: row.contact }) : '',
    version: row.version || '',
    timeLabel: formatRelativeTime(row.createdAt)
  }
}

Page({
  data: {
    t: {},
    loading: true,
    error: '',
    rows: [],
    total: 0,
    totalLabel: '',
    hasMore: false,
    loadingMore: false,
    canUseCloud: typeof wx.cloud !== 'undefined'
  },

  onLoad() {
    this.setData({ t: i18n.dict() })
    wx.setNavigationBarTitle({ title: i18n.t('afb_navtitle') })
    this.refresh()
  },

  onShow() {
    this.setData({ t: i18n.dict() })
    wx.setNavigationBarTitle({ title: i18n.t('afb_navtitle') })
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh())
  },

  async refresh() {
    if (!this.data.canUseCloud) {
      this.setData({ loading: false, error: i18n.t('afb_err_no_cloud') })
      return
    }
    this.setData({ loading: true, error: '', rows: [] })
    const r = await this._fetch(0)
    if (!r) return
    this.setData({
      loading: false,
      rows: r.rows.map(decorate),
      total: r.total,
      totalLabel: i18n.t('afb_total', { n: r.total }),
      hasMore: r.rows.length >= PAGE_SIZE && (0 + r.rows.length) < r.total
    })
  },

  async loadMore() {
    if (this.data.loadingMore || !this.data.hasMore) return
    this.setData({ loadingMore: true })
    const r = await this._fetch(this.data.rows.length)
    if (!r) { this.setData({ loadingMore: false }); return }
    const rows = this.data.rows.concat(r.rows.map(decorate))
    this.setData({
      loadingMore: false,
      rows,
      total: r.total,
      totalLabel: i18n.t('afb_total', { n: r.total }),
      hasMore: r.rows.length >= PAGE_SIZE && rows.length < r.total
    })
  },

  // 返回 { rows, total } 或 null(已设置 error)。
  async _fetch(skip) {
    try {
      const res = await wx.cloud.callFunction({ name: 'adminPanel', data: { action: 'listFeedback', limit: PAGE_SIZE, skip } })
      const result = (res && res.result) || {}
      if (!result.ok) {
        const msg = result.reason === 'not_admin' ? i18n.t('afb_err_not_admin') : (result.reason || i18n.t('afb_err_load'))
        this.setData({ loading: false, error: msg })
        return null
      }
      return { rows: result.rows || [], total: result.total || 0 }
    } catch (e) {
      console.error('[admin-feedback] listFeedback failed', e)
      this.setData({ loading: false, error: i18n.t('afb_err_load') })
      return null
    }
  }
})
