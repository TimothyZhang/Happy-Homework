const store = require('../../utils/store')
const shareReward = require('../../utils/share-reward')

// 学科顺序与 notebook-share 保持一致 — 让接收方看到的分组顺序与分享方预览一致。
const SUBJECT_ORDER = ['语文', '数学', '英语', '科学', '道法', '美术', '其他']

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

// chip 上展示的"短日期"。带前缀 emoji,让 chip 一眼是日期(picker 触发器)。
function chipDateLabel(dateStr, prefix) {
  if (!dateStr) return prefix
  return `${prefix}${shortMD(dateStr)}`
}

// 默认标题:{组织}作业({日期}) —— 客态视角(接收方看到的就是这个),不要再写
// "我分享的作业" 这类主态文案。空 organization 退化为 "作业"。
function buildDefaultTitle(organization, startDate, endDate) {
  const org = (organization || '').trim()
  const range = buildDateRangeLabel(startDate, endDate)
  const prefix = org ? `${org}作业` : '作业'
  return range ? `${prefix}(${range})` : prefix
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
    // 组织 picker:必选一个,无"全部"项 — 业务上每次分享一个组织的作业列表。
    orgOptions: [],
    orgIndex: 0,
    sharerAvatar: '',
    // 自定义标题:用户在 input 里手输,空字符串=用 titlePlaceholder 当默认。
    customTitle: '',
    titlePlaceholder: '',
    orgLabel: '',
    dateRangeLabel: '',
    startDateLabel: '',
    endDateLabel: '',
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
    const orgOptions = store.getOrganizations()
    const profile = store.getProfile()
    this.setData({
      startDate: initialDate,
      endDate: initialDate,
      orgOptions,
      orgIndex: 0,
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

  // 自定义标题输入。空串等价于 "用默认 placeholder"。
  onTitleInput(e) {
    const v = (e.detail && e.detail.value) || ''
    this.setData({ customTitle: v })
    // 刷一遍 payload 缓存,让 onShareAppMessage 同步取到带新 title 的版本。
    this.refreshPreview()
  },

  // 算出实际生效的 title:用户输入有就用,没有走默认。共用给预览和 onShareAppMessage。
  resolveTitle() {
    const { customTitle, titlePlaceholder } = this.data
    const t = (customTitle || '').trim()
    return t || titlePlaceholder
  },

  // 重算预览 + payload。每次过滤项变动就跑一次,纯本地。
  refreshPreview() {
    const { startDate, endDate, orgOptions, orgIndex } = this.data
    const organization = orgOptions[orgIndex] || ''
    const sharer = shareReward.getMyOpenidSync() || ''
    const titlePlaceholder = buildDefaultTitle(organization, startDate, endDate)
    // resolveTitle 依赖 titlePlaceholder,先把它写进 data 再读 —— setData 是同步合并,
    // 但 this.data 在同一 setData 调用内不会立即更新。所以这里手算一遍生效 title。
    const customTrim = (this.data.customTitle || '').trim()
    const effectiveTitle = customTrim || titlePlaceholder
    const payload = store.serializeTasksForShare({
      startDate,
      endDate,
      organization,
      sharerOpenid: sharer,
      title: effectiveTitle
    })
    const subjectGroups = groupBySubject(payload.t || [])
    const totalCount = (payload.t || []).length
    const dateRangeLabel = buildDateRangeLabel(startDate, endDate)
    this.setData({
      subjectGroups,
      totalCount,
      dateRangeLabel,
      startDateLabel: chipDateLabel(startDate, '📅 '),
      endDateLabel: chipDateLabel(endDate, '至 '),
      orgLabel: organization,
      titlePlaceholder,
      _cachedPayload: payload
    })
  },

  onShareAppMessage() {
    // refreshPreview 已经把 payload 缓存到 _cachedPayload;万一缓存丢失就重算。
    let payload = this.data._cachedPayload
    const title = this.resolveTitle()
    if (!payload) {
      const organization = this.data.orgOptions[this.data.orgIndex] || ''
      payload = store.serializeTasksForShare({
        startDate: this.data.startDate,
        endDate: this.data.endDate,
        organization,
        sharerOpenid: shareReward.getMyOpenidSync() || '',
        title
      })
    } else if (payload.title !== title) {
      // 缓存的 payload title 可能跟当前 input 不一致(refreshPreview 节流场景);
      // 直接替换 payload.title 而不重新 serialize,避免重跑 task collection。
      payload = { ...payload, title }
    }
    const encoded = encodeURIComponent(JSON.stringify(payload))
    return {
      title,
      path: `/pages/notebook-share/index?d=${encoded}`
    }
  }
})
