const store = require('../../utils/store')

function pad2(n) { return `${n}`.padStart(2, '0') }

function buildMonthGrid(year, monthIdx0, state) {
  // monthIdx0: 0=Jan
  const first = new Date(year, monthIdx0, 1)
  const daysInMonth = new Date(year, monthIdx0 + 1, 0).getDate()
  const firstDow = first.getDay() // 0=Sun..6=Sat ; we treat Mon=first
  const leadBlanks = (firstDow + 6) % 7
  const cells = []
  for (let i = 0; i < leadBlanks; i++) cells.push(null)
  const today = store.todayStr()
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${pad2(monthIdx0 + 1)}-${pad2(d)}`
    const items = store.tasksForDate(state, dateStr)
    const total = items.length
    const done = items.filter((it) => it.occurrence.status === 'done').length
    cells.push({
      day: d,
      dateStr,
      total,
      done,
      pending: total - done,
      isToday: dateStr === today,
      isFuture: dateStr > today,
      hasOverdue: items.some((it) => it.isOverdue)
    })
  }
  // pad to multiple of 7
  while (cells.length % 7 !== 0) cells.push(null)
  // group by week
  const weeks = []
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7))
  }
  return weeks
}

function decorateDayItems(items, now) {
  return items.map((it) => ({
    id: it.task.id,
    notebookId: it.notebook.id,
    notebookName: it.notebook.name,
    subject: it.task.subject || '',
    content: it.task.content,
    estimatedMinutes: it.task.estimatedMinutes,
    status: it.occurrence.status,
    isOverdue: it.isOverdue
  }))
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
    this.refresh()
  },

  refresh() {
    const state = store.getStateWithComputed()
    const weeks = buildMonthGrid(this.data.year, this.data.monthIdx0, state)
    const monthLabel = `${this.data.year} 年 ${this.data.monthIdx0 + 1} 月`
    const items = decorateDayItems(store.tasksForDate(state, this.data.selectedDate), Date.now())
    this.setData({
      weeks,
      monthLabel,
      selectedItems: items,
      selectedLabel: this.formatDateLabel(this.data.selectedDate)
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
    this.setData({ year: y, monthIdx0: m })
    this.refresh()
  },

  handleNextMonth() {
    let y = this.data.year
    let m = this.data.monthIdx0 + 1
    if (m > 11) { m = 0; y += 1 }
    this.setData({ year: y, monthIdx0: m })
    this.refresh()
  },

  handleToday() {
    const now = new Date()
    this.setData({
      year: now.getFullYear(),
      monthIdx0: now.getMonth(),
      selectedDate: store.todayStr()
    })
    this.refresh()
  },

  handlePickDay(e) {
    const dateStr = e.currentTarget.dataset.date
    if (!dateStr) return
    this.setData({ selectedDate: dateStr })
    this.refresh()
  },

  handleOpenNotebook(e) {
    wx.navigateTo({ url: `/pages/notebook-detail/index?id=${e.currentTarget.dataset.notebookId}` })
  }
})
