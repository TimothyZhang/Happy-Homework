// 管理后台 — 用户列表页。
//
// 通过云函数 adminPanel 拉所有 user_state 摘要。非 admin 进来直接被云函数 403,
// 页面渲染错误提示并禁用所有操作。

function formatRelativeTime(ts) {
  if (!ts) return '从未'
  const diff = Date.now() - ts
  if (diff < 30 * 1000) return '刚刚'
  if (diff < 60 * 1000) return `${Math.floor(diff / 1000)} 秒前`
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`
  const d = new Date(ts)
  const pad = (n) => `${n}`.padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

Page({
  data: {
    loading: true,
    users: [],
    filteredUsers: [],
    total: 0,
    error: '',
    keyword: '',
    canUseCloud: typeof wx.cloud !== 'undefined'
  },

  onLoad() {
    this.refresh()
  },

  onPullDownRefresh() {
    this.refresh().finally(() => wx.stopPullDownRefresh())
  },

  onShow() {
    // 从 detail 页返回时刷新,确保金币调整能立即反映
    if (this.data.loading === false) {
      this.refresh()
    }
  },

  async refresh() {
    if (!this.data.canUseCloud) {
      this.setData({ loading: false, error: '云开发未启用,无法加载用户列表' })
      return
    }
    this.setData({ loading: true, error: '' })
    try {
      const res = await wx.cloud.callFunction({
        name: 'adminPanel',
        data: { action: 'listUsers', limit: 500 }
      })
      const result = (res && res.result) || {}
      if (!result.ok) {
        const msg = result.reason === 'not_admin' ? '当前账号不是管理员' : (result.reason || '加载失败')
        this.setData({ loading: false, error: msg, users: [], filteredUsers: [] })
        return
      }
      const users = (result.users || []).map((u) => {
        const displayName = u.nickname || '(未设置昵称)'
        return {
          ...u,
          updatedAtDisplay: formatRelativeTime(u.updatedAt),
          shortOpenid: u.openid ? `${u.openid.slice(0, 6)}…${u.openid.slice(-4)}` : '',
          displayName,
          avatarInitial: displayName[0] || '?',
          petDisplayName: u.pet ? (u.pet.name || '宠物') : ''
        }
      })
      this.setData({
        loading: false,
        users,
        total: result.total || users.length
      }, () => this.applyFilter())
    } catch (e) {
      console.error('[admin] listUsers failed', e)
      this.setData({
        loading: false,
        error: '加载失败:' + ((e && e.errMsg) || String(e))
      })
    }
  },

  handleKeywordInput(e) {
    this.setData({ keyword: e.detail.value || '' }, () => this.applyFilter())
  },

  applyFilter() {
    const k = (this.data.keyword || '').trim().toLowerCase()
    if (!k) {
      this.setData({ filteredUsers: this.data.users })
      return
    }
    const filtered = this.data.users.filter((u) => {
      return (u.nickname || '').toLowerCase().includes(k) ||
             (u.openid || '').toLowerCase().includes(k)
    })
    this.setData({ filteredUsers: filtered })
  },

  handleOpenDetail(e) {
    const openid = e.currentTarget.dataset.openid
    if (!openid) return
    wx.navigateTo({
      url: `/pages/admin-detail/index?openid=${encodeURIComponent(openid)}`
    })
  }
})
