const store = require('../../utils/store')
const shareReward = require('../../utils/share-reward')

const SUBJECT_ORDER = ['语文', '数学', '英语', '科学', '道法', '美术', '其他']

function subjectRank(s) {
  const i = SUBJECT_ORDER.indexOf(s)
  return i < 0 ? SUBJECT_ORDER.length : i
}

function shortMD(dateStr) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(dateStr || '')
  if (!m) return dateStr || ''
  return `${Number(m[1])}/${Number(m[2])}`
}

function buildDateRangeLabel(start, end) {
  if (!start) return ''
  if (!end || end === start) return shortMD(start)
  return `${shortMD(start)} – ${shortMD(end)}`
}

// payload.t 按学科分组,组内保留原顺序。每条 task 保留原下标 _idx 让导入时
// 可以精准定位回 payload.t。
function groupBySubject(tasks) {
  const list = tasks.map((t, idx) => ({
    _idx: idx,
    id: `${t.s || '其他'}-${idx}`,
    subject: t.s || '其他',
    content: t.c || '',
    organization: t.o || '校内',
    estimatedMinutes: Number(t.m) || 0,
    dueDateLabel: shortMD(t.dd || t.ed || t.sd || '')
  }))
  const buckets = new Map()
  for (const t of list) {
    if (!buckets.has(t.subject)) buckets.set(t.subject, [])
    buckets.get(t.subject).push(t)
  }
  const groups = Array.from(buckets.entries()).map(([subject, items]) => ({ subject, tasks: items }))
  groups.sort((a, b) => {
    const ra = subjectRank(a.subject)
    const rb = subjectRank(b.subject)
    if (ra !== rb) return ra - rb
    return a.subject.localeCompare(b.subject, 'zh')
  })
  return groups
}

Page({
  data: {
    payload: null,
    subjectGroups: [],
    headerTitle: '',
    sharerNickname: '',
    sharerAvatar: '',
    orgLabel: '全部组织',
    dateRangeLabel: '',
    error: '',
    importing: false
  },

  onLoad(options) {
    const raw = options && options.d
    if (!raw) {
      this.setData({ error: '分享链接里没有作业数据' })
      return
    }
    try {
      const rawPayload = JSON.parse(decodeURIComponent(raw))
      const payload = store.sanitizeSharePayload(rawPayload)
      if (!payload || !Array.isArray(payload.t)) {
        throw new Error('payload invalid')
      }
      const subjectGroups = groupBySubject(payload.t)
      const headerTitle = '好友分享的作业'
      const orgLabel = payload.org ? payload.org : '全部组织'
      const dateRangeLabel = buildDateRangeLabel(payload.d, payload.de)
      this.setData({
        payload,
        subjectGroups,
        headerTitle,
        orgLabel,
        dateRangeLabel
      })
      wx.setNavigationBarTitle({ title: '导入作业' })
      if (payload.sharer) {
        shareReward.fetchSharerProfile(payload.sharer).then((profile) => {
          if (!profile) return
          const nickname = (profile.nickname || '').trim()
          this.setData({
            sharerNickname: nickname,
            sharerAvatar: profile.avatar || '',
            headerTitle: nickname ? `${nickname} 分享的作业` : '好友分享的作业'
          })
        }).catch(() => {})
      }
    } catch (e) {
      this.setData({ error: '分享数据已损坏，无法读取' })
    }
  },

  handleImport() {
    if (this.data.importing) return
    if (!this.data.payload) return
    const payload = this.data.payload
    if (!payload.t || payload.t.length === 0) {
      wx.showToast({ title: '没有可保存的作业', icon: 'none' })
      return
    }
    this.setData({ importing: true })
    const newIds = store.importSharedTasks(payload)
    if (!newIds || newIds.length === 0) {
      this.setData({ importing: false, error: '保存失败，请稍后再试' })
      return
    }
    wx.showToast({ title: `已保存 ${newIds.length} 项`, icon: 'success' })
    // 服务端 shareReward 给分享者 +3 coin(以 shareId 做 dedup,重复导入不会重复发)。
    if (payload.sharer && payload.shareId) {
      shareReward.reportShareSave({
        sharerOpenid: payload.sharer,
        notebookId: payload.shareId,
        notebookName: this.data.headerTitle
      }).catch(() => {})
    }
    setTimeout(() => {
      // 没有 notebook-detail 可跳,直接回任务列表
      wx.switchTab({ url: '/pages/tasks/index' })
    }, 600)
  },

  handleCancel() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack()
    } else {
      wx.switchTab({ url: '/pages/home/index' })
    }
  },

  // 转发卡片继续往下传播 — payload 里包含 shareId,reportShareSave 仍归属原作者。
  onShareAppMessage() {
    const payload = this.data.payload
    if (!payload) return { title: '作业分享', path: '/pages/tasks/index' }
    const forwarded = { ...payload }
    delete forwarded.from
    const title = this.data.sharerNickname
      ? `${this.data.sharerNickname} 分享的作业`
      : '好友分享的作业'
    const encoded = encodeURIComponent(JSON.stringify(forwarded))
    return { title, path: `/pages/notebook-share/index?d=${encoded}` }
  }
})
