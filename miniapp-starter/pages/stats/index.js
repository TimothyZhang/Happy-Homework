const store = require('../../utils/store')

const PERIOD_DAYS = { week: 7, month: 30 }
// 柱状区固定高度 (rpx),最大值占满,其余按比例。
const BAR_AREA_RPX = 200

function buildDateList(period) {
  const days = PERIOD_DAYS[period] || 7
  const today = store.todayStr()
  const list = []
  for (let i = days - 1; i >= 0; i--) {
    list.push(store.addDays(today, -i))
  }
  return list
}

// "2026-05-18" → "5-18" (周模式) 或 "5/18" (月模式都一样)
function shortLabel(dateStr) {
  const [, m, d] = dateStr.split('-')
  return `${Number(m)}/${Number(d)}`
}

// label 策略:
//   - 周(7根):每根显示 "M/D",今天显 "今"
//   - 月(30根):太挤 → 每 5 根 + 首/尾/今天 显示,其余空字符串
function labelFor(dateStr, period, today, idx, total) {
  if (period === 'week') {
    return dateStr === today ? '今' : shortLabel(dateStr)
  }
  // month
  if (dateStr === today) return '今'
  const isFirst = idx === 0
  const isLast = idx === total - 1
  if (isFirst || isLast || idx % 5 === 0) return shortLabel(dateStr)
  return ''
}

function aggregateTasks(state) {
  const counts = {}   // dateStr -> done count
  const minutes = {}  // dateStr -> sum actualMinutes
  for (const t of state.tasks) {
    if (t.mode !== 'recurring') {
      if (t.status === 'done' && t.completedAt) {
        const d = store.dateToStr(new Date(t.completedAt))
        counts[d] = (counts[d] || 0) + 1
        minutes[d] = (minutes[d] || 0) + (Number(t.actualMinutes) || 0)
      }
    } else {
      const occs = t.occurrences || {}
      for (const k in occs) {
        const occ = occs[k]
        if (occ && occ.status === 'done' && occ.completedAt) {
          const d = store.dateToStr(new Date(occ.completedAt))
          counts[d] = (counts[d] || 0) + 1
          minutes[d] = (minutes[d] || 0) + (Number(occ.actualMinutes) || 0)
        }
      }
    }
  }
  return { counts, minutes }
}

function aggregateCoins(state) {
  const map = {}  // dateStr -> { gain, spend, net }
  for (const log of (state.coinLogs || [])) {
    if (!log || !log.ts) continue
    const d = store.dateToStr(new Date(log.ts))
    if (!map[d]) map[d] = { gain: 0, spend: 0, net: 0 }
    const delta = Number(log.delta) || 0
    if (delta > 0) map[d].gain += delta
    else map[d].spend += -delta
    map[d].net += delta
  }
  return map
}

function scaleBars(bars, valueKey) {
  let max = 0
  for (const b of bars) {
    const v = b[valueKey] || 0
    if (v > max) max = v
  }
  for (const b of bars) {
    const v = b[valueKey] || 0
    b.heightRpx = max > 0 ? Math.round((v / max) * BAR_AREA_RPX) : 0
  }
  return max
}

// 金币图:bar 上下两半,正向 gain 朝上,负向 spend 朝下,统一对 max(|gain|,|spend|) scale
function scaleCoinBars(bars) {
  let max = 0
  for (const b of bars) {
    if (b.gain > max) max = b.gain
    if (b.spend > max) max = b.spend
  }
  for (const b of bars) {
    b.gainHeightRpx = max > 0 ? Math.round((b.gain / max) * BAR_AREA_RPX) : 0
    b.spendHeightRpx = max > 0 ? Math.round((b.spend / max) * BAR_AREA_RPX) : 0
  }
  return max
}

function buildCharts(state, period) {
  const today = store.todayStr()
  const dates = buildDateList(period)
  const { counts, minutes } = aggregateTasks(state)
  const coins = aggregateCoins(state)

  const total = dates.length
  const countBars = dates.map((d, i) => ({
    date: d,
    label: labelFor(d, period, today, i, total),
    isToday: d === today,
    value: counts[d] || 0
  }))
  const countMax = scaleBars(countBars, 'value')

  const minutesBars = dates.map((d, i) => ({
    date: d,
    label: labelFor(d, period, today, i, total),
    isToday: d === today,
    value: minutes[d] || 0
  }))
  const minutesMax = scaleBars(minutesBars, 'value')

  const coinBars = dates.map((d, i) => {
    const c = coins[d] || { gain: 0, spend: 0, net: 0 }
    return {
      date: d,
      label: labelFor(d, period, today, i, total),
      isToday: d === today,
      gain: c.gain,
      spend: c.spend,
      net: c.net
    }
  })
  const coinMax = scaleCoinBars(coinBars)

  return {
    countBars,
    minutesBars,
    coinBars,
    countTotal: countBars.reduce((s, b) => s + b.value, 0),
    minutesTotal: minutesBars.reduce((s, b) => s + b.value, 0),
    coinGainTotal: coinBars.reduce((s, b) => s + b.gain, 0),
    coinSpendTotal: coinBars.reduce((s, b) => s + b.spend, 0),
    // 月模式参考线上标的数字 —— 25/50/75% 三档(金币只标 50%)
    countQ1: Math.round(countMax * 0.25),
    countQ2: Math.round(countMax * 0.5),
    countQ3: Math.round(countMax * 0.75),
    minutesQ1: Math.round(minutesMax * 0.25),
    minutesQ2: Math.round(minutesMax * 0.5),
    minutesQ3: Math.round(minutesMax * 0.75),
    coinHalf: Math.round(coinMax * 0.5)
  }
}

Page({
  data: {
    period: 'week',
    barAreaRpx: BAR_AREA_RPX,
    countBars: [],
    minutesBars: [],
    coinBars: [],
    countTotal: 0,
    minutesTotal: 0,
    coinGainTotal: 0,
    coinSpendTotal: 0,
    countQ1: 0, countQ2: 0, countQ3: 0,
    minutesQ1: 0, minutesQ2: 0, minutesQ3: 0,
    coinHalf: 0
  },

  onShow() {
    const tb = typeof this.getTabBar === 'function' && this.getTabBar()
    if (tb) tb.setData({ selected: 2 })
    this._refresh()
  },

  onPullDownRefresh() {
    this._refresh()
    wx.stopPullDownRefresh()
  },

  _refresh() {
    const state = store.getStateWithComputed()
    const charts = buildCharts(state, this.data.period)
    this.setData(charts)
  },

  onSwitchPeriod(e) {
    const next = e.currentTarget.dataset.period
    if (!next || next === this.data.period) return
    this.setData({ period: next }, () => this._refresh())
  }
})
