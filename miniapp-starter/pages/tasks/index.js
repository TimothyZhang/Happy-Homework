const store = require('../../utils/store')
const cloudSync = require('../../utils/cloud-sync')
const perf = require('../../utils/perf')
const shareReward = require('../../utils/share-reward')

const WEEKDAY_NAMES = ['一', '二', '三', '四', '五', '六', '日']
const GROUP_MODES = [
  { key: 'subject', label: '按学科' },
  { key: 'organization', label: '按组织' },
  { key: 'none', label: '不分组' }
]
const FILTER_MODES = [
  { key: 'open', label: '待办' },
  { key: 'all', label: '全部' }
]

function describeRecurrence(t) {
  if (!t.recurrence) return '每日'
  if (t.recurrence.type === 'daily') return '每日'
  if (t.recurrence.type === 'weekly') {
    const wds = (t.recurrence.weekdays || []).slice().sort()
    if (!wds.length) return '每周（未选日）'
    return '每周' + wds.map((w) => WEEKDAY_NAMES[w - 1]).join('、')
  }
  return ''
}

function describeSchedule(t) {
  if (t.mode === 'recurring') {
    const tail = t.endDate ? `→ ${t.endDate}` : '→ 长期'
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
    modeLabel: t.mode === 'recurring' ? '重复' : '一次性',
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
    GROUP_MODES,
    FILTER_MODES
  },

  onShow() {
    const stamp = perf.markPageShow('tasks')
    const tb = typeof this.getTabBar === 'function' && this.getTabBar()
    if (tb) tb.setData({ selected: 1 })
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
      // 学科分组:按学科名字母 / 中文排;组织分组:固定顺序(校内/校外/其他)。
      if (key === 'organization') {
        const order = ['校内', '校外', '其他']
        groups.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label))
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
      title: `删除「${task.content || '该作业'}」？`,
      content: '历史完成记录不变,但这条作业以后不再出现。',
      confirmColor: '#e54545',
      success: (res) => {
        if (res.confirm) {
          store.deleteTask(id)
          this.refreshState()
          wx.showToast({ title: '已删除', icon: 'success' })
        }
      }
    })
  },

  handleShareEntry() {
    // 引导 wx 分享面板 — 真正的 serializeTasksForShare 在 onShareAppMessage 里
    // 落地。一次只能分一份,通常分享方拍一遍当日的全部任务。
    wx.showShareMenu({ withShareTicket: false, menus: ['shareAppMessage'] })
    wx.showToast({ title: '点右上角「···」分享', icon: 'none' })
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
      title: `今天的作业 (${(payload.t || []).length} 项)`,
      path: `/pages/notebook-share/index?d=${encoded}`
    }
  }
})
