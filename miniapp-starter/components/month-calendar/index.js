const store = require('../../utils/store')

function pad2(n) { return `${n}`.padStart(2, '0') }

function buildMonthGrid(year, monthIdx0, state, selectedDate) {
  const first = new Date(year, monthIdx0, 1)
  const daysInMonth = new Date(year, monthIdx0 + 1, 0).getDate()
  const firstDow = first.getDay()
  const leadBlanks = (firstDow + 6) % 7
  const cells = []
  for (let i = 0; i < leadBlanks; i++) {
    cells.push({ key: `pad-lead-${i}`, empty: true })
  }
  const today = store.todayStr()
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
      isSelected: dateStr === selectedDate,
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
    // YYYY-MM-DD string of the currently-selected day. The component
    // highlights this cell and snaps the visible month to contain it
    // when it changes externally.
    value: {
      type: String,
      value: '',
      observer(newVal) {
        if (!newVal) return
        // Snap visible month to contain the new value.
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(newVal)
        if (!m) return
        const y = Number(m[1])
        const monthIdx0 = Number(m[2]) - 1
        if (y !== this.data.year || monthIdx0 !== this.data.monthIdx0) {
          this._render({ year: y, monthIdx0 })
        } else {
          // Same month — just rebuild grid so selected highlight follows.
          this._render({})
        }
      }
    }
  },
  data: {
    year: 0,
    monthIdx0: 0,
    monthLabel: '',
    weeks: [],
    weekdayHeaders: ['一', '二', '三', '四', '五', '六', '日']
  },
  lifetimes: {
    attached() {
      const seed = this.data.value || store.todayStr()
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(seed)
      const now = new Date()
      const y = m ? Number(m[1]) : now.getFullYear()
      const mi = m ? Number(m[2]) - 1 : now.getMonth()
      this._render({ year: y, monthIdx0: mi })
    }
  },
  methods: {
    // Public — host calls this when store changes (e.g. task finished),
    // so day-count bubbles repaint.
    refresh() {
      this._render({})
    },

    _render(patch) {
      const state = store.getStateWithComputed()
      const year = patch.year !== undefined ? patch.year : this.data.year
      const monthIdx0 = patch.monthIdx0 !== undefined ? patch.monthIdx0 : this.data.monthIdx0
      const monthLabel = `${year} 年 ${monthIdx0 + 1} 月`
      // Paint chrome first; defer the per-day grid build (the costly part)
      // a tick so first paint stays snappy when toggling open.
      this.setData({ year, monthIdx0, monthLabel })
      wx.nextTick(() => {
        if (this.data.year !== year || this.data.monthIdx0 !== monthIdx0) return
        const weeks = buildMonthGrid(year, monthIdx0, state, this.data.value)
        this.setData({ weeks })
      })
    },

    handlePrevMonth() {
      let y = this.data.year
      let m = this.data.monthIdx0 - 1
      if (m < 0) { m = 11; y -= 1 }
      this._render({ year: y, monthIdx0: m })
    },

    handleNextMonth() {
      let y = this.data.year
      let m = this.data.monthIdx0 + 1
      if (m > 11) { m = 0; y += 1 }
      this._render({ year: y, monthIdx0: m })
    },

    handleToday() {
      const today = store.todayStr()
      const now = new Date()
      this._render({ year: now.getFullYear(), monthIdx0: now.getMonth() })
      this.triggerEvent('change', { date: today })
    },

    handlePickDay(e) {
      const dateStr = e.currentTarget.dataset.date
      if (!dateStr) return
      this.triggerEvent('change', { date: dateStr })
    }
  }
})
