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
    order: item.task.order || 0,
    createdAt: item.task.createdAt || 0,
    completedAt: occ.completedAt || 0,
    status: occ.status,
    isOverdue: visualOverdue,
    elapsedMs,
    elapsedDisplay: elapsedMs > 0 ? formatElapsed(elapsedMs) : ''
  }
}

// Undone first (overdue floats to the very top within undone, oldest missed
// first), done by completedAt desc.
function sortItems(items) {
  const undone = []
  const done = []
  for (const it of items) {
    if (it.status === 'done') done.push(it)
    else undone.push(it)
  }
  undone.sort((a, b) => {
    if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1
    if (a.isOverdue) {
      // older missed dates first
      if (a.occurrenceDate !== b.occurrenceDate) {
        return a.occurrenceDate < b.occurrenceDate ? -1 : 1
      }
    }
    const oa = a.order || 0
    const ob = b.order || 0
    if (oa !== ob) return oa - ob
    return (a.createdAt || 0) - (b.createdAt || 0)
  })
  done.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
  return [...undone, ...done]
}

Page({
  data: {
    activeDate: '',
    activeDateLabel: '',
    isToday: true,
    overview: { totalCount: 0, pendingCount: 0, doneCount: 0 },
    remainingMinutesDisplay: '—',
    items: [],
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
    // One unified list — overdue items carry isOverdue flag so the row stays
    // styled red while still being part of the same scrollable list and the
    // same drag-reorder pool.
    const items = sortItems(raw.map((it) => decorateItem(it, now)))
    const total = items.length
    const done = items.filter((it) => it.status === 'done').length
    const pending = total - done
    const remainingMinutes = items
      .filter((it) => it.status !== 'done')
      .reduce((s, it) => s + Number(it.estimatedMinutes || 0), 0)
    this.setData({
      activeDate,
      activeDateLabel: this.formatDateLabel(activeDate, today),
      isToday,
      overview: { totalCount: total, pendingCount: pending, doneCount: done },
      remainingMinutesDisplay: formatDuration(remainingMinutes),
      items,
      lastReward: state.lastReward || null
    })
    if (opts.maybeCelebrate) this.maybeShowCongrats(items)
  },

  formatDateLabel(date, today) {
    if (date === today) return `今日 · ${date}`
    if (date === store.addDays(today, -1)) return `昨日 · ${date}`
    if (date === store.addDays(today, 1)) return `明日 · ${date}`
    return date
  },

  maybeShowCongrats(items) {
    if (!items || items.length === 0) return
    if (!this.data.isToday) return
    const allDone = items.every((it) => it.status === 'done')
    if (!allDone) return
    const totalMs = items.reduce((s, it) => s + (it.elapsedMs || 0), 0)
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
  },

  handleOpenCalendar() {
    wx.switchTab({ url: '/pages/calendar/index' })
  }
})
