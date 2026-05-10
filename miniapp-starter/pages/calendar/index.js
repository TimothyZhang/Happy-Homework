const store = require('../../utils/store')
const cloudSync = require('../../utils/cloud-sync')

function pad2(n) { return `${n}`.padStart(2, '0') }

function buildMonthGrid(year, monthIdx0, state) {
  // monthIdx0: 0=Jan
  const first = new Date(year, monthIdx0, 1)
  const daysInMonth = new Date(year, monthIdx0 + 1, 0).getDate()
  const firstDow = first.getDay() // 0=Sun..6=Sat ; we treat Mon=first
  const leadBlanks = (firstDow + 6) % 7
  const cells = []
  // Use object cells (with unique `key`) for blanks too, so wx:for / wx:key
  // never see a null and template member access is always safe.
  for (let i = 0; i < leadBlanks; i++) {
    cells.push({ key: `pad-lead-${i}`, empty: true })
  }
  const today = store.todayStr()
  // Single-pass aggregator — much faster than calling tasksForDate per day,
  // especially with long-running recurring notebooks.
  const counts = store.dateCountsForMonth(state, year, monthIdx0)
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${pad2(monthIdx0 + 1)}-${pad2(d)}`
    const c = counts[dateStr] || { total: 0, done: 0, hasOverdue: false }
    cells.push({
      key: dateStr,
      empty: false,
      day: d,
      dateStr,
      total: c.total,
      done: c.done,
      pending: c.total - c.done,
      isToday: dateStr === today,
      isFuture: dateStr > today,
      hasOverdue: c.hasOverdue
    })
  }
  // pad to multiple of 7
  while (cells.length % 7 !== 0) {
    cells.push({ key: `pad-trail-${cells.length}`, empty: true })
  }
  // group by week
  const weeks = []
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push({ key: `wk-${i}`, cells: cells.slice(i, i + 7) })
  }
  return weeks
}

function formatElapsed(ms) {
  if (!ms || ms < 0) return ''
  const totalSec = Math.floor(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min === 0) return `${sec} 秒`
  if (sec === 0) return `${min} 分钟`
  return `${min} 分 ${sec} 秒`
}

function decorateDayItems(items, now) {
  return items
    .map((it) => {
      const occ = it.occurrence
      let elapsedMs = occ.accumulatedMs || 0
      if (occ.status === 'doing' && occ.currentSegmentStartedAt) {
        elapsedMs += Math.max(0, now - occ.currentSegmentStartedAt)
      }
      const occurrenceDate = it.occurrenceDate || ''
      const rowOrder = store.getRowOrder(it.task, it.notebook, occurrenceDate)
      return {
        // composite id so multiple occurrences of the same task don't collide
        // in wx:key
        id: occurrenceDate ? `${it.task.id}__${occurrenceDate}` : it.task.id,
        taskId: it.task.id,
        occurrenceDate,
        notebookId: it.notebook.id,
        notebookName: it.notebook.name,
        subject: it.task.subject || '',
        content: it.task.content,
        estimatedMinutes: it.task.estimatedMinutes,
        rowOrder,
        createdAt: it.task.createdAt || 0,
        completedAt: occ.completedAt || 0,
        status: occ.status,
        isOverdue: it.isOverdue && occ.status !== 'done',
        elapsedMs,
        elapsedDisplay: elapsedMs > 0 ? formatElapsed(elapsedMs) : ''
      }
    })
    .sort((a, b) => {
      // Undone first by rowOrder, done at bottom by completedAt desc.
      const da = a.status === 'done'
      const db = b.status === 'done'
      if (da !== db) return da ? 1 : -1
      if (da) return (b.completedAt || 0) - (a.completedAt || 0)
      const oa = a.rowOrder || 0
      const ob = b.rowOrder || 0
      if (oa !== ob) return oa - ob
      return (a.createdAt || 0) - (b.createdAt || 0)
    })
}

Page({
  data: {
    year: 0,
    monthIdx0: 0,
    monthLabel: '',
    weeks: [],
    weekdayHeaders: ['一', '二', '三', '四', '五', '六', '日'],
    selectedDate: '',
    selectedLabel: '',
    selectedItems: []
  },

  onLoad() {
    const now = new Date()
    this.setData({
      year: now.getFullYear(),
      monthIdx0: now.getMonth(),
      selectedDate: store.todayStr()
    })
  },

  onShow() {
    const tb = typeof this.getTabBar === 'function' && this.getTabBar()
    if (tb) tb.setData({ selected: 2 })
    this.refresh()
    cloudSync.hydrateIfStale().then((r) => {
      if (r && r.changed) this.refresh()
    }).catch(() => {})
  },

  refresh(patch = {}) {
    const state = store.getStateWithComputed()
    const year = patch.year !== undefined ? patch.year : this.data.year
    const monthIdx0 = patch.monthIdx0 !== undefined ? patch.monthIdx0 : this.data.monthIdx0
    const selectedDate = patch.selectedDate || this.data.selectedDate
    const monthLabel = `${year} 年 ${monthIdx0 + 1} 月`
    const items = decorateDayItems(store.tasksForDate(state, selectedDate), Date.now())
    // Paint chrome + selected day first; the 30-day grid build is the
    // expensive part (tasksForDate × ~30) and shouldn't block first paint
    // when entering the calendar tab.
    this.setData({
      year,
      monthIdx0,
      selectedDate,
      monthLabel,
      selectedItems: items,
      selectedLabel: this.formatDateLabel(selectedDate)
    })
    wx.nextTick(() => {
      // Bail if the user already navigated away or moved months.
      if (this.data.year !== year || this.data.monthIdx0 !== monthIdx0) return
      const weeks = buildMonthGrid(year, monthIdx0, state)
      this.setData({ weeks })
    })
  },

  formatDateLabel(date) {
    const today = store.todayStr()
    if (date === today) return `今日 · ${date}`
    if (date === store.addDays(today, -1)) return `昨日 · ${date}`
    if (date === store.addDays(today, 1)) return `明日 · ${date}`
    return date
  },

  handlePrevMonth() {
    let y = this.data.year
    let m = this.data.monthIdx0 - 1
    if (m < 0) { m = 11; y -= 1 }
    this.refresh({ year: y, monthIdx0: m })
  },

  handleNextMonth() {
    let y = this.data.year
    let m = this.data.monthIdx0 + 1
    if (m > 11) { m = 0; y += 1 }
    this.refresh({ year: y, monthIdx0: m })
  },

  handleToday() {
    const now = new Date()
    this.refresh({
      year: now.getFullYear(),
      monthIdx0: now.getMonth(),
      selectedDate: store.todayStr()
    })
  },

  handlePickDay(e) {
    const dateStr = e.currentTarget.dataset.date
    if (!dateStr) return
    this.refresh({ selectedDate: dateStr })
  },

  handleOpenNotebook(e) {
    wx.navigateTo({ url: `/pages/notebook-detail/index?id=${e.currentTarget.dataset.notebookId}` })
  },

  // task-list emits this whenever an action runs or a drag commits
  handleTasksChanged() {
    this.refresh()
  }
})
