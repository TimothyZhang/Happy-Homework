const store = require('../../utils/store')

function formatElapsed(ms) {
  if (!ms || ms < 0) return ''
  const totalSec = Math.floor(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min === 0) return `${sec} 秒`
  if (sec === 0) return `${min} 分钟`
  return `${min} 分 ${sec} 秒`
}

function formatDuration(minutes) {
  if (!minutes || minutes < 0) return '—'
  if (minutes < 60) return `${minutes} 分钟`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (m === 0) return `${h} 小时`
  return `${h}h${m}m`
}

function decorateItem(item, now) {
  const occ = item.occurrence
  let elapsedMs = occ.accumulatedMs || 0
  if (occ.status === 'doing' && occ.currentSegmentStartedAt) {
    elapsedMs += Math.max(0, now - occ.currentSegmentStartedAt)
  }
  // The "overdue" treatment (red row bg, 逾期 chip) only applies while the
  // task is still open. Once it's done, drop the urgency styling.
  const visualOverdue = !!item.isOverdue && occ.status !== 'done'
  const occurrenceDate = item.occurrenceDate || ''
  const rowOrder = store.getRowOrder(item.task, item.notebook, occurrenceDate)
  return {
    // composite key — same task across multiple missed dates needs distinct
    // wx:key entries
    id: occurrenceDate ? `${item.task.id}__${occurrenceDate}` : item.task.id,
    taskId: item.task.id,
    occurrenceDate,
    notebookId: item.notebook.id,
    notebookName: item.notebook.name,
    subject: item.task.subject || '',
    content: item.task.content,
    estimatedMinutes: item.task.estimatedMinutes,
    rowOrder,
    createdAt: item.task.createdAt || 0,
    completedAt: occ.completedAt || 0,
    status: occ.status,
    isOverdue: visualOverdue,
    elapsedMs,
    elapsedDisplay: elapsedMs > 0 ? formatElapsed(elapsedMs) : ''
  }
}

// Sort undone purely by user-controlled rowOrder. Overdue / virtual /
// today rows all live in the same orderable pool now — the user is free
// to interleave a missed-Monday recurring row between today's tasks.
function sortUndone(items) {
  return items.sort((a, b) => {
    const oa = a.rowOrder || 0
    const ob = b.rowOrder || 0
    if (oa !== ob) return oa - ob
    return (a.createdAt || 0) - (b.createdAt || 0)
  })
}

// Done sorted by most recent completion first.
function sortDone(items) {
  return items.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
}

Page({
  data: {
    activeDate: '',
    activeDateLabel: '',
    isToday: true,
    overview: { totalCount: 0, pendingCount: 0, doneCount: 0 },
    remainingMinutesDisplay: '—',
    undoneItems: [],
    doneItems: [],
    showCongrats: false,
    totalElapsedDisplay: '',
    lastReward: null
  },

  onShow() {
    if (!this.data.activeDate) {
      this.setData({ activeDate: store.todayStr() })
    }
    this.refreshState()
  },

  refreshState(opts = {}) {
    const today = store.todayStr()
    const activeDate = this.data.activeDate || today
    const isToday = activeDate === today
    const state = store.getStateWithComputed()
    const now = Date.now()
    const raw = store.tasksForDate(state, activeDate)
    const decorated = raw.map((it) => decorateItem(it, now))
    const undoneItems = sortUndone(decorated.filter((it) => it.status !== 'done'))
    const doneItems = sortDone(decorated.filter((it) => it.status === 'done'))
    const total = decorated.length
    const remainingMinutes = undoneItems
      .reduce((s, it) => s + Number(it.estimatedMinutes || 0), 0)
    this.setData({
      activeDate,
      activeDateLabel: this.formatDateLabel(activeDate, today),
      isToday,
      overview: { totalCount: total, pendingCount: undoneItems.length, doneCount: doneItems.length },
      remainingMinutesDisplay: formatDuration(remainingMinutes),
      undoneItems,
      doneItems,
      lastReward: state.lastReward || null
    })
    if (opts.maybeCelebrate) this.maybeShowCongrats({ undone: undoneItems, done: doneItems })
  },

  formatDateLabel(date, today) {
    if (date === today) return `今日 · ${date}`
    if (date === store.addDays(today, -1)) return `昨日 · ${date}`
    if (date === store.addDays(today, 1)) return `明日 · ${date}`
    return date
  },

  maybeShowCongrats({ undone, done }) {
    if (!this.data.isToday) return
    if (!undone || undone.length !== 0) return
    if (!done || done.length === 0) return
    const totalMs = done.reduce((s, it) => s + (it.elapsedMs || 0), 0)
    this.setData({
      showCongrats: true,
      totalElapsedDisplay: totalMs > 0 ? formatElapsed(totalMs) : ''
    })
  },

  handleDismissCongrats() { this.setData({ showCongrats: false }) },

  handleTasksChanged(e) {
    const finished = e && e.detail && e.detail.finished
    this.refreshState({ maybeCelebrate: finished })
  },

  // === Day switcher === //

  handlePrevDay() {
    this.setData({ activeDate: store.addDays(this.data.activeDate, -1) })
    this.refreshState()
  },

  handleNextDay() {
    this.setData({ activeDate: store.addDays(this.data.activeDate, 1) })
    this.refreshState()
  },

  handleJumpToday() {
    this.setData({ activeDate: store.todayStr() })
    this.refreshState()
  }
})
