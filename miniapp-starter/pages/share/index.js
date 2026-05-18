const store = require('../../utils/store')
const shareReward = require('../../utils/share-reward')

// 学科顺序与 notebook-share 保持一致 — 让接收方看到的分组顺序与分享方预览一致。
const SUBJECT_ORDER = ['语文', '数学', '英语', '科学', '道法', '美术', '其他']
const ORG_ALL_LABEL = '全部组织'

function subjectRank(s) {
  const i = SUBJECT_ORDER.indexOf(s)
  return i < 0 ? SUBJECT_ORDER.length : i
}

// "5/16" — short month/day for chip 展示。
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

function buildPreviewTitle(nickname) {
  const n = (nickname || '').trim()
  return n ? `${n} 分享的作业` : '我分享的作业'
}

// 把 payload.t 按学科分组,组内保留原顺序。
function groupBySubject(tasks) {
  const buckets = new Map()
  for (const t of tasks) {
    const sub = t.s || '其他'
    if (!buckets.has(sub)) buckets.set(sub, [])
    buckets.get(sub).push(t)
  }
  const groups = Array.from(buckets.entries()).map(([subject, list]) => ({
    subject,
    tasks: list.map((t, idx) => ({
      id: `${subject}-${idx}`,
      content: t.c || '',
      organization: t.o || '校内',
      estimatedMinutes: Number(t.m) || 0,
      dueDateLabel: shortMD(t.dd || t.ed || t.sd || '')
    }))
  }))
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
    startDate: '',
    endDate: '',
    orgOptions: [ORG_ALL_LABEL],
    orgIndex: 0,
    sharerNickname: '',
    sharerAvatar: '',
    previewTitle: '',
    orgLabel: ORG_ALL_LABEL,
    dateRangeLabel: '',
    totalCount: 0,
    subjectGroups: [],
    filterEmptyHint: '该范围内没有可分享的作业',
    // 缓存最近一次序列化的 payload — onShareAppMessage 同步触发时不能再做 IO
    // (loadState 是同步的 storage,但还是把它缓存好降低开销)。
    _cachedPayload: null
  },

  onLoad(options) {
    const today = store.todayStr()
    const initialDate = (options && options.date) || today
    const orgs = store.getOrganizations()
    const orgOptions = [ORG_ALL_LABEL].concat(orgs)
    const profile = store.getProfile()
    this.setData({
      startDate: initialDate,
      endDate: initialDate,
      orgOptions,
      orgIndex: 0,
      sharerNickname: profile.nickname || '',
      sharerAvatar: profile.avatar || ''
    })
    this.refreshPreview()
    // 后台预热 openid — onShareAppMessage 同步取本地缓存即可。
    shareReward.preloadOpenid().catch(() => {})
  },

  onShow() {
    // 用户可能回到首页改了 task,再回来 — 重新算一次。
    this.refreshPreview()
  },

  handleStartDateChange(e) {
    const v = e.detail && e.detail.value
    if (!v) return
    let { startDate, endDate } = this.data
    startDate = v
    // 起点跑到终点之后 → 终点跟随,避免空范围。
    if (endDate && endDate < startDate) endDate = startDate
    this.setData({ startDate, endDate })
    this.refreshPreview()
  },

  handleEndDateChange(e) {
    const v = e.detail && e.detail.value
    if (!v) return
    let { startDate, endDate } = this.data
    endDate = v
    if (startDate && startDate > endDate) startDate = endDate
    this.setData({ startDate, endDate })
    this.refreshPreview()
  },

  handleOrgChange(e) {
    const idx = Number(e.detail && e.detail.value)
    if (!Number.isInteger(idx)) return
    this.setData({ orgIndex: idx })
    this.refreshPreview()
  },

  // 重算预览 + payload。每次过滤项变动就跑一次,纯本地。
  refreshPreview() {
    const { startDate, endDate, orgOptions, orgIndex, sharerNickname } = this.data
    const organization = orgIndex > 0 ? orgOptions[orgIndex] : ''
    const sharer = shareReward.getMyOpenidSync() || ''
    const payload = store.serializeTasksForShare({
      startDate,
      endDate,
      organization,
      sharerOpenid: sharer
    })
    const subjectGroups = groupBySubject(payload.t || [])
    const totalCount = (payload.t || []).length
    const dateRangeLabel = buildDateRangeLabel(startDate, endDate)
    const orgLabel = organization || ORG_ALL_LABEL
    const previewTitle = buildPreviewTitle(sharerNickname)
    this.setData({
      subjectGroups,
      totalCount,
      dateRangeLabel,
      orgLabel,
      previewTitle,
      _cachedPayload: payload
    })
  },

  onShareAppMessage() {
    // refreshPreview 已经把 payload 缓存到 _cachedPayload;万一缓存丢失就重算。
    let payload = this.data._cachedPayload
    if (!payload) {
      const organization = this.data.orgIndex > 0 ? this.data.orgOptions[this.data.orgIndex] : ''
      payload = store.serializeTasksForShare({
        startDate: this.data.startDate,
        endDate: this.data.endDate,
        organization,
        sharerOpenid: shareReward.getMyOpenidSync() || ''
      })
    }
    const title = buildPreviewTitle(this.data.sharerNickname)
    const encoded = encodeURIComponent(JSON.stringify(payload))
    return {
      title,
      path: `/pages/notebook-share/index?d=${encoded}`
    }
  }
})
