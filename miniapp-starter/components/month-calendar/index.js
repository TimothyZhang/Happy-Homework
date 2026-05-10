const store = require('../../utils/store')

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
  while (cells.length % 7 !== 0) {
    cells.push({ key: `pad-trail-${cells.length}`, empty: true })
  }
  const weeks = []
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push({ key: `wk-${i}`, cells: cells.slice(i, i + 7) })
  }
  return weeks
}

Component({
  options: { addGlobalClass: true },
  properties: {
    // Date string (YYYY-MM-DD) currently highlighted as "selected".
    // Drives both the cell highlight and the month shown when it changes
    // to a date outside the current month.
    selectedDate: { type: String, value: '' }
  },
  data: {
    year: 0,
    monthIdx0: 0,
    monthLabel: '',
    weeks: [],
    weekdayHeaders: ['一', '二', '三', '四', '五', '六', '日']
  },
  observers: {
    'selectedDate': function (newVal) {
      // Initial property set fires before attached(); guard so we don't
      // rebuild twice on mount.
      if (!this._attached || !newVal) return
      const parts = newVal.split('-').map((s) => parseInt(s, 10))
      if (!parts[0] || !parts[1]) return
      if (parts[0] === this.data.year && (parts[1] - 1) === this.data.monthIdx0) return
      this.setData({ year: parts[0], monthIdx0: parts[1] - 1 })
      this._rebuild()
    }
  },
  attached() {
    let y, m
    const sel = this.data.selectedDate
    if (sel) {
      const parts = sel.split('-').map((s) => parseInt(s, 10))
      if (parts[0] && parts[1]) { y = parts[0]; m = parts[1] - 1 }
    }
    if (y == null) {
      const now = new Date()
      y = now.getFullYear(); m = now.getMonth()
    }
    this.setData({ year: y, monthIdx0: m })
    this._attached = true
    this._rebuild()
  },
  methods: {
    // Parent calls this when external state has changed (e.g. cloud sync,
    // task action) so the per-day counts repaint.
    refresh() { this._rebuild() },

    _rebuild() {
      const state = store.getStateWithComputed()
      const { year, monthIdx0 } = this.data
      const monthLabel = `${year} 年 ${monthIdx0 + 1} 月`
      // Paint chrome immediately; defer the heavy grid build so first paint
      // isn't blocked by the per-day count aggregation.
      this.setData({ monthLabel })
      wx.nextTick(() => {
        if (this.data.year !== year || this.data.monthIdx0 !== monthIdx0) return
        const weeks = buildMonthGrid(year, monthIdx0, state)
        this.setData({ weeks })
      })
    },

    handlePrevMonth() {
      let y = this.data.year
      let m = this.data.monthIdx0 - 1
      if (m < 0) { m = 11; y -= 1 }
      this.setData({ year: y, monthIdx0: m })
      this._rebuild()
    },

    handleNextMonth() {
      let y = this.data.year
      let m = this.data.monthIdx0 + 1
      if (m > 11) { m = 0; y += 1 }
      this.setData({ year: y, monthIdx0: m })
      this._rebuild()
    },

    handleToday() {
      const now = new Date()
      this.setData({ year: now.getFullYear(), monthIdx0: now.getMonth() })
      this._rebuild()
      this.triggerEvent('pick', { date: store.todayStr() })
    },

    handlePickDay(e) {
      const dateStr = e.currentTarget.dataset.date
      if (!dateStr) return
      this.triggerEvent('pick', { date: dateStr })
    }
  }
})
