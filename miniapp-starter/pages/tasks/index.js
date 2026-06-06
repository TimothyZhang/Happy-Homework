const store = require('../../utils/store')
const cloudSync = require('../../utils/cloud-sync')
const perf = require('../../utils/perf')
const shareReward = require('../../utils/share-reward')
const i18n = require('../../utils/i18n')

const GROUP_MODES = [
  { key: 'subject', labelKey: 'tasks_group_subject' },
  { key: 'organization', labelKey: 'tasks_group_org' },
  { key: 'none', labelKey: 'tasks_group_none' }
]
const FILTER_MODES = [
  { key: 'open', labelKey: 'tasks_filter_open' },
  { key: 'all', labelKey: 'tasks_filter_all' }
]

function buildLocalizedModes() {
  const groupModes = GROUP_MODES.map((m) => ({ key: m.key, label: i18n.t(m.labelKey) }))
  const filterModes = FILTER_MODES.map((m) => ({ key: m.key, label: i18n.t(m.labelKey) }))
  return { groupModes, filterModes }
}

function describeRecurrence(t) {
  const weekdays = i18n.t('tasks_weekdays')
  const sep = i18n.t('tasks_weekday_sep')
  if (!t.recurrence) return i18n.t('tasks_recur_daily')
  if (t.recurrence.type === 'daily') return i18n.t('tasks_recur_daily')
  if (t.recurrence.type === 'weekly') {
    const wds = (t.recurrence.weekdays || []).slice().sort()
    if (!wds.length) return i18n.t('tasks_recur_weekly_nodays')
    return i18n.t('tasks_recur_weekly') + wds.map((w) => weekdays[w - 1]).join(sep)
  }
  return ''
}

function describeSchedule(t) {
  if (t.mode === 'recurring') {
    const tail = t.endDate ? `→ ${t.endDate}` : i18n.t('tasks_schedule_ongoing')
    return `${describeRecurrence(t)} · ${t.startDate || ''} ${tail}`
  }
  const due = t.dueDate || t.endDate || t.startDate
  return due || ''
}

function isTaskDoneToday(task, today) {
  if (task.mode === 'recurring') {
    const occ = (task.occurrences || {})[today]
    return !!(occ && occ.status === 'done')
  }
  return (task.status || 'todo') === 'done'
}

function isTaskAllCleared(task) {
  // one-shot: status === done
  // recurring: 永远不算"全部完成"(会持续)
  if (task.mode === 'recurring') return false
  return (task.status || 'todo') === 'done'
}

function decorateTask(t, today) {
  const doneToday = isTaskDoneToday(t, today)
  const cleared = isTaskAllCleared(t)
  let activeToday = false
  if (t.mode === 'recurring') {
    activeToday = store.isTaskActiveOn(t, today)
  } else {
    const due = store.effectiveDueDate(t)
    activeToday = due === today || (due && due < today && !cleared)
  }
  return {
    ...t,
    scheduleLabel: describeSchedule(t),
    modeLabel: t.mode === 'recurring' ? i18n.t('tasks_mode_recurring') : i18n.t('tasks_mode_oneshot'),
    doneToday,
    cleared,
    activeToday
  }
}

Page({
  data: {
    groupMode: 'subject',  // 'subject' | 'organization' | 'none'
    filterMode: 'open',    // 'open' | 'all'
    groups: [],            // [{ key, label, tasks: [decoratedTask] }]
    flatList: [],          // when groupMode === 'none'
    totalCount: 0,
    GROUP_MODES: GROUP_MODES.map((m) => ({ key: m.key, label: '' })),
    FILTER_MODES: FILTER_MODES.map((m) => ({ key: m.key, label: '' })),
    t: {}
  },

  onShow() {
    const stamp = perf.markPageShow('tasks')
    const tb = typeof this.getTabBar === 'function' && this.getTabBar()
    if (tb) tb.setData({ selected: 1 })
    const { groupModes, filterModes } = buildLocalizedModes()
    this.setData({ t: i18n.dict(), GROUP_MODES: groupModes, FILTER_MODES: filterModes })
    wx.setNavigationBarTitle({ title: i18n.t('tasks_navtitle') })
    this.refreshState(stamp)
    cloudSync.hydrateIfStale().then((r) => {
      if (r && r.changed) this.refreshState()
    }).catch(() => {})
  },

  refreshState(perfStamp) {
    const state = store.getStateWithComputed()
    const today = store.todayStr()
    const all = state.tasks.map((t) => decorateTask(t, today))

    const filtered = this.data.filterMode === 'all'
      ? all
      : all.filter((t) => !t.cleared)

    let groups = []
    let flatList = []
    if (this.data.groupMode === 'none') {
      flatList = filtered.slice().sort((a, b) => {
        // 活跃今日的排前面,然后按 createdAt 倒序
        if (a.activeToday !== b.activeToday) return a.activeToday ? -1 : 1
        return (b.createdAt || 0) - (a.createdAt || 0)
      })
    } else {
      const key = this.data.groupMode
      const buckets = new Map()
      for (const t of filtered) {
        const k = (t[key] || '其他')
        if (!buckets.has(k)) buckets.set(k, [])
        buckets.get(k).push(t)
      }
      groups = Array.from(buckets.entries()).map(([label, tasks]) => ({
        key: `${key}-${label}`,
        label,
        tasks: tasks.sort((a, b) => {
          if (a.activeToday !== b.activeToday) return a.activeToday ? -1 : 1
          return (b.createdAt || 0) - (a.createdAt || 0)
        })
      }))
      // 学科分组:按学科名字母 / 中文排;组织分组:按用户在我 Tab 配置的列表顺序,
      // 未在列表里的标签(老 task 残留)排到最后。
      if (key === 'organization') {
        const order = store.getOrganizations()
        groups.sort((a, b) => {
          const ia = order.indexOf(a.label)
          const ib = order.indexOf(b.label)
          const ra = ia < 0 ? Number.MAX_SAFE_INTEGER : ia
          const rb = ib < 0 ? Number.MAX_SAFE_INTEGER : ib
          if (ra !== rb) return ra - rb
          return a.label.localeCompare(b.label, 'zh')
        })
      } else {
        groups.sort((a, b) => a.label.localeCompare(b.label, 'zh'))
      }
    }

    this.setData(
      { groups, flatList, totalCount: filtered.length },
      perfStamp ? () => perf.markPaint(perfStamp) : undefined
    )
  },

  handleGroupChange(event) {
    const key = event.currentTarget.dataset.key
    if (!key || key === this.data.groupMode) return
    this.setData({ groupMode: key })
    this.refreshState()
  },

  handleFilterChange(event) {
    const key = event.currentTarget.dataset.key
    if (!key || key === this.data.filterMode) return
    this.setData({ filterMode: key })
    this.refreshState()
  },

  handleAddTask() {
    wx.navigateTo({ url: '/pkg-notebook/task-edit/index' })
  },

  handleEditTask(event) {
    const { id } = event.currentTarget.dataset
    wx.navigateTo({ url: `/pkg-notebook/task-edit/index?id=${id}` })
  },

  handleDeleteTask(event) {
    const { id } = event.currentTarget.dataset
    const task = (this.data.flatList.concat(...this.data.groups.map((g) => g.tasks)))
      .find((t) => t.id === id)
    if (!task) return
    wx.showModal({
      title: i18n.t('tasks_delete_title', { name: task.content || i18n.t('tasks_navtitle') }),
      content: i18n.t('tasks_delete_content'),
      confirmColor: '#e54545',
      success: (res) => {
        if (res.confirm) {
          store.deleteTask(id)
          this.refreshState()
          wx.showToast({ title: i18n.t('tasks_deleted'), icon: 'success' })
        }
      }
    })
  },

  handleShareEntry() {
    // 引导 wx 分享面板 — 真正的 serializeTasksForShare 在 onShareAppMessage 里
    // 落地。一次只能分一份,通常分享方拍一遍当日的全部任务。
    wx.showShareMenu({ withShareTicket: false, menus: ['shareAppMessage'] })
    wx.showToast({ title: i18n.t('tasks_share_hint'), icon: 'none' })
  },

  // wx 分享面板回调 — 默认序列化当日全部任务。学科/组织过滤可在分享前
  // 通过页面顶部 group toolbar 视觉筛选,但 payload 这里固定取 today
  // 全部 task,避免过滤状态和分享内容不一致。
  onShareAppMessage() {
    const sharer = shareReward.getMyOpenidSync() || ''
    const today = store.todayStr()
    const payload = store.serializeTasksForShare(today, { sharerOpenid: sharer })
    const encoded = encodeURIComponent(JSON.stringify(payload))
    return {
      title: i18n.t('tasks_share_title', { n: (payload.t || []).length }),
      path: `/pages/notebook-share/index?d=${encoded}`
    }
  }
})
