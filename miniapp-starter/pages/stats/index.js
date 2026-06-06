const store = require('../../utils/store')

const PERIOD_DAYS = { week: 7, month: 30 }
// 柱状区固定高度 (rpx),最大值占满,其余按比例。
const BAR_AREA_RPX = 200
// 完成时间用绝对刻度 0:00 → 24:00 → 0..BAR_AREA_RPX,跨天对比直观。
const DAY_MINUTES = 24 * 60

function pad2(n) { return `${n}`.padStart(2, '0') }
function fmtHM(mins) { return `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}` }

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
  const counts = {}     // dateStr -> done count
  const minutes = {}    // dateStr -> sum actualMinutes(实际)
  const estimated = {}  // dateStr -> sum estimatedMinutes(预计)
  for (const t of state.tasks) {
    const est = Number(t.estimatedMinutes) || 0   // 预计是 task 级,recurring 各次共用
    if (t.mode !== 'recurring') {
      if (t.status === 'done' && t.completedAt) {
        const d = store.dateToStr(new Date(t.completedAt))
        counts[d] = (counts[d] || 0) + 1
        minutes[d] = (minutes[d] || 0) + (Number(t.actualMinutes) || 0)
        estimated[d] = (estimated[d] || 0) + est
      }
    } else {
      const occs = t.occurrences || {}
      for (const k in occs) {
        const occ = occs[k]
        if (occ && occ.status === 'done' && occ.completedAt) {
          const d = store.dateToStr(new Date(occ.completedAt))
          counts[d] = (counts[d] || 0) + 1
          minutes[d] = (minutes[d] || 0) + (Number(occ.actualMinutes) || 0)
          estimated[d] = (estimated[d] || 0) + (Number(occ.estimatedMinutes) || est)
        }
      }
    }
  }
  return { counts, minutes, estimated }
}

// 每天的"完成时间":取该日所有 done 任务里最晚的 completedAt(=当天最后一笔
// 作业完成的时刻)。返回 { dateStr: maxTs }。
function aggregateFinishTimes(state) {
  const map = {}
  const consider = (ts) => {
    if (!ts) return
    const d = store.dateToStr(new Date(ts))
    if (!map[d] || ts > map[d]) map[d] = ts
  }
  for (const t of state.tasks) {
    if (t.mode !== 'recurring') {
      if (t.status === 'done' && t.completedAt) consider(t.completedAt)
    } else {
      const occs = t.occurrences || {}
      for (const k in occs) {
        const occ = occs[k]
        if (occ && occ.status === 'done' && occ.completedAt) consider(occ.completedAt)
      }
    }
  }
  return map
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

// 完成时间用固定 0..1440 min → 0..BAR_AREA_RPX 刻度,bar 高度直接读时间段。
// max-relative scale 会让所有"傍晚完成"的柱子都贴近顶端、互相看不出差异。
function scaleFinishTimeBars(bars) {
  for (const b of bars) {
    b.heightRpx = b.value > 0
      ? Math.round((b.value / DAY_MINUTES) * BAR_AREA_RPX)
      : 0
  }
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

// 作业耗时:一根柱子里同时表达「预计」与「实际」。
// 柱高 = max(预计, 实际);下半 base = min(两者)是中性色;上半 diff = |差值|,
// 实际 < 预计(提前完成)→ 差值绿色(省下的时间);实际 > 预计(超时)→ 差值红色。
function scaleEstActBars(bars) {
  let max = 0
  for (const b of bars) {
    const hi = Math.max(b.est || 0, b.act || 0)
    if (hi > max) max = hi
  }
  for (const b of bars) {
    const est = b.est || 0
    const act = b.act || 0
    const hasBoth = est > 0 && act > 0   // 只有同时有预计+实际才比差值上色
    // base = 两者重叠的部分(中性色),diff = 差值(绿/红)。缺一个时整根中性。
    const base = hasBoth ? Math.min(est, act) : Math.max(est, act)
    const diff = hasBoth ? Math.abs(est - act) : 0
    b.over = hasBoth && act > est        // 超时(红);提前完成则绿
    b.hasData = est > 0 || act > 0
    b.baseHeightRpx = max > 0 ? Math.round((base / max) * BAR_AREA_RPX) : 0
    b.diffHeightRpx = max > 0 ? Math.round((diff / max) * BAR_AREA_RPX) : 0
  }
  return max
}

function buildCharts(state, period) {
  const today = store.todayStr()
  const dates = buildDateList(period)
  const { counts, minutes, estimated } = aggregateTasks(state)
  const coins = aggregateCoins(state)
  const finishTs = aggregateFinishTimes(state)

  const total = dates.length

  const finishTimeBars = dates.map((d, i) => {
    const ts = finishTs[d] || 0
    let value = 0
    let displayValue = ''
    if (ts > 0) {
      const dt = new Date(ts)
      value = dt.getHours() * 60 + dt.getMinutes()
      displayValue = fmtHM(value)
    }
    return {
      date: d,
      label: labelFor(d, period, today, i, total),
      isToday: d === today,
      value,
      displayValue
    }
  })
  scaleFinishTimeBars(finishTimeBars)
  const finishedDays = finishTimeBars.filter((b) => b.value > 0)
  const finishTimeAvgMin = finishedDays.length > 0
    ? Math.round(finishedDays.reduce((s, b) => s + b.value, 0) / finishedDays.length)
    : 0
  const finishTimeAvgLabel = finishTimeAvgMin > 0 ? fmtHM(finishTimeAvgMin) : '—'

  const countBars = dates.map((d, i) => ({
    date: d,
    label: labelFor(d, period, today, i, total),
    isToday: d === today,
    value: counts[d] || 0
  }))
  const countMax = scaleBars(countBars, 'value')

  const minutesBars = dates.map((d, i) => {
    const act = minutes[d] || 0
    const est = estimated[d] || 0
    const hasBoth = est > 0 && act > 0
    const diff = Math.abs(est - act)
    return {
      date: d,
      label: labelFor(d, period, today, i, total),
      isToday: d === today,
      value: act,
      est,
      act,
      // 角标:实际比预计省/超了多少分钟(只有同时有预计+实际且不等才显示)
      diffLabel: (hasBoth && diff > 0) ? ((act > est ? '+' : '-') + diff) : ''
    }
  })
  const minutesMax = scaleEstActBars(minutesBars)

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
    finishTimeBars,
    finishTimeAvgLabel,
    countBars,
    minutesBars,
    coinBars,
    countTotal: countBars.reduce((s, b) => s + b.value, 0),
    minutesTotal: minutesBars.reduce((s, b) => s + b.act, 0),
    estimatedTotal: minutesBars.reduce((s, b) => s + b.est, 0),
    coinGainTotal: coinBars.reduce((s, b) => s + b.gain, 0),
    coinSpendTotal: coinBars.reduce((s, b) => s + b.spend, 0),
    // 月模式参考线上标的数字 —— 25/50/75% 三档(金币只标 50%);完成时间用固定刻度
    countQ1: Math.round(countMax * 0.25),
    countQ2: Math.round(countMax * 0.5),
    countQ3: Math.round(countMax * 0.75),
    minutesQ1: Math.round(minutesMax * 0.25),
    minutesQ2: Math.round(minutesMax * 0.5),
    minutesQ3: Math.round(minutesMax * 0.75),
    coinHalf: Math.round(coinMax * 0.5),
    finishTimeQ1: '06:00',
    finishTimeQ2: '12:00',
    finishTimeQ3: '18:00'
  }
}

Page({
  data: {
    period: 'week',
    barAreaRpx: BAR_AREA_RPX,
    finishTimeBars: [],
    finishTimeAvgLabel: '—',
    countBars: [],
    minutesBars: [],
    coinBars: [],
    countTotal: 0,
    minutesTotal: 0,
    estimatedTotal: 0,
    coinGainTotal: 0,
    coinSpendTotal: 0,
    countQ1: 0, countQ2: 0, countQ3: 0,
    minutesQ1: 0, minutesQ2: 0, minutesQ3: 0,
    coinHalf: 0,
    finishTimeQ1: '06:00', finishTimeQ2: '12:00', finishTimeQ3: '18:00'
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
