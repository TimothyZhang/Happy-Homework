const store = require('../../utils/store')
const shareReward = require('../../utils/share-reward')

const SUBJECT_ORDER = ['语文', '数学', '英语', '科学', '道法', '美术', '其他']
const WEEKDAY_NAMES = ['一', '二', '三', '四', '五', '六', '日']

function subjectRank(s) {
  const i = SUBJECT_ORDER.indexOf(s)
  return i < 0 ? SUBJECT_ORDER.length : i
}

function describeRecurrence(r) {
  if (!r) return '每日'
  if (r.type === 'daily') return '每日'
  if (r.type === 'weekly') {
    const wds = (r.weekdays || []).slice().sort()
    if (!wds.length) return '每周（未选日）'
    return '每周' + wds.map((w) => WEEKDAY_NAMES[w - 1]).join('、')
  }
  return ''
}

function describeTaskSchedule(t) {
  if (t.mo === 'recurring') {
    const tail = t.ed ? `→ ${t.ed}` : '→ 长期'
    return `重复 · ${describeRecurrence(t.r)} · ${t.sd || ''} ${tail}`
  }
  return `一次性 · ${t.ed || t.sd || ''}`
}

// 按学科分组、保持组内原序。每组首行打 firstOfSubject=true 给 UI 画分组头。
function arrangeBySubject(rawTasks) {
  const list = rawTasks.map((t, idx) => ({
    _idx: idx,
    selected: true,
    subject: t.s || '其他',
    organization: t.o || '其他',
    content: t.c || '',
    estimatedMinutes: Number(t.m) || 0,
    scheduleLabel: describeTaskSchedule(t)
  }))
  list.sort((a, b) => {
    const ra = subjectRank(a.subject)
    const rb = subjectRank(b.subject)
    if (ra !== rb) return ra - rb
    if (a.subject !== b.subject) return a.subject < b.subject ? -1 : 1
    return a._idx - b._idx
  })
  let prev = null
  for (const t of list) {
    t.firstOfSubject = t.subject !== prev
    prev = t.subject
  }
  return list
}

Page({
  data: {
    payload: null,
    arrangedTasks: [],
    headerTitle: '',
    sharerLabel: '',
    sharerNickname: '',
    sharerAvatar: '',
    selectedCount: 0,
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
      // sanitize 把 schema 收敛到 v2 schema(v1 老链接也会被 sanitize 转换)。
      const payload = store.sanitizeSharePayload(rawPayload)
      if (!payload || !Array.isArray(payload.t) || payload.t.length === 0) {
        throw new Error('payload invalid')
      }
      const arranged = arrangeBySubject(payload.t)
      const headerTitle = payload.d ? `${payload.d} 的作业` : '好友分享的作业'
      this.setData({
        payload,
        arrangedTasks: arranged,
        selectedCount: arranged.length,
        headerTitle,
        sharerLabel: '好友分享给你的作业'
      })
      wx.setNavigationBarTitle({ title: '导入作业' })
      if (payload.sharer) {
        shareReward.fetchSharerProfile(payload.sharer).then((profile) => {
          if (!profile) return
          const nickname = (profile.nickname || '').trim()
          this.setData({
            sharerNickname: nickname,
            sharerAvatar: profile.avatar || '',
            sharerLabel: nickname ? `${nickname} 分享给你的作业` : '好友分享给你的作业'
          })
        }).catch(() => {})
      }
    } catch (e) {
      this.setData({ error: '分享数据已损坏，无法读取' })
    }
  },

  handleToggleTask(event) {
    const idx = Number(event.currentTarget.dataset.idx)
    if (!Number.isInteger(idx)) return
    const arranged = this.data.arrangedTasks.slice()
    if (!arranged[idx]) return
    arranged[idx] = { ...arranged[idx], selected: !arranged[idx].selected }
    const selectedCount = arranged.filter((t) => t.selected).length
    this.setData({ arrangedTasks: arranged, selectedCount })
  },

  handleToggleAll() {
    const arranged = this.data.arrangedTasks
    const allOn = arranged.every((t) => t.selected)
    const next = arranged.map((t) => ({ ...t, selected: !allOn }))
    this.setData({ arrangedTasks: next, selectedCount: allOn ? 0 : next.length })
  },

  handleImport() {
    if (this.data.importing) return
    if (!this.data.payload) return
    const payload = this.data.payload
    // arranged 是排过序的索引,要把 selected 索引映射回 payload.t 的原索引
    const selectedOriginalIndexes = this.data.arrangedTasks
      .filter((t) => t.selected)
      .map((t) => t._idx)
    if (selectedOriginalIndexes.length === 0) {
      wx.showToast({ title: '至少勾选 1 项', icon: 'none' })
      return
    }
    this.setData({ importing: true })
    const newIds = store.importSharedTasks(payload, { selectedIndexes: selectedOriginalIndexes })
    if (!newIds || newIds.length === 0) {
      this.setData({ importing: false, error: '保存失败，请稍后再试' })
      return
    }
    wx.showToast({ title: `已导入 ${newIds.length} 项`, icon: 'success' })
    // 服务端 shareReward 给分享者 +3 coin(以 shareId 做 dedup,重复导入不会重复发)。
    if (payload.sharer && payload.shareId) {
      shareReward.reportShareSave({
        sharerOpenid: payload.sharer,
        notebookId: payload.shareId,   // 云函数字段名暂用旧名,Phase 12 一起改
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
      ? `${this.data.sharerNickname} 分享给你的作业`
      : '好友分享给你的作业'
    const encoded = encodeURIComponent(JSON.stringify(forwarded))
    return { title, path: `/pages/notebook-share/index?d=${encoded}` }
  }
})
