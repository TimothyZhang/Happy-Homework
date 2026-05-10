// Standalone Node.js benchmark for store hot paths.
// Run: `node scripts/perf-bench.js [notebookCount] [tasksPerNotebook]`
// Mocks wx storage API so the real store.js can be required as-is.

// Real wx.getStorageSync deserializes from disk each call — mimic with
// JSON round-trip so the bench accounts for that cost.
let storage = {}
global.wx = {
  getStorageSync: (k) => {
    if (!(k in storage)) return ''
    return JSON.parse(storage[k])
  },
  setStorageSync: (k, v) => { storage[k] = JSON.stringify(v) },
  // cloud-sync probes wx.cloud and bails when missing — leave undefined
  cloud: undefined,
  showToast: () => {},
  showModal: () => {}
}

// ---- seed ----
function seedState(N_NOTEBOOKS, N_TASKS_PER_NB, RECURRING_HISTORY_DAYS) {
  const histDays = RECURRING_HISTORY_DAYS || 30
  const today = (() => {
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  })()
  // recurring notebooks start histDays ago, so they have a histDays backlog
  const backlogStart = (() => {
    const d = new Date()
    d.setDate(d.getDate() - histDays)
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  })()

  const notebooks = []
  const tasks = []
  for (let i = 0; i < N_NOTEBOOKS; i++) {
    const isRecurring = i % 5 === 0  // 20% recurring
    notebooks.push({
      id: `nb_${i}`,
      name: `本${i}`,
      mode: isRecurring ? 'recurring' : 'one-shot',
      startDate: isRecurring ? backlogStart : today,
      endDate: isRecurring ? null : today,
      recurrence: isRecurring ? { type: 'daily', weekdays: [] } : null,
      createdAt: Date.now() - i * 1000,
      order: i
    })
    for (let j = 0; j < N_TASKS_PER_NB; j++) {
      const t = {
        id: `tk_${i}_${j}`,
        notebookId: `nb_${i}`,
        subject: ['语文', '数学', '英语'][j % 3],
        content: `作业${j}`,
        estimatedMinutes: 10,
        order: i * N_TASKS_PER_NB + j,
        createdAt: Date.now() - (i * N_TASKS_PER_NB + j) * 100
      }
      if (isRecurring) {
        t.occurrences = {}
      } else {
        t.status = 'todo'
        t.startedAt = null
        t.currentSegmentStartedAt = null
        t.accumulatedMs = 0
        t.completedAt = null
        t.actualMinutes = null
      }
      tasks.push(t)
    }
  }
  storage['homework-pet-v1'] = JSON.stringify({
    schemaVersion: 2,
    coins: 0,
    streakDays: 0,
    bonusCoins: 10,
    editTaskId: null,
    editNotebookId: null,
    ocrCurrentJob: null,
    ocrJobs: [],
    rewardRules: [],
    pet: { name: 'p', emoji: '🐮', level: 1, growth: 0, nextLevelGrowth: 60, happiness: 50, fullness: 50 },
    shopItems: [],
    notebooks,
    tasks
  })
}

// ---- bench helper ----
function bench(label, fn, iters) {
  // warmup
  for (let i = 0; i < 2; i++) fn()
  const start = process.hrtime.bigint()
  for (let i = 0; i < iters; i++) fn()
  const ns = Number(process.hrtime.bigint() - start)
  const ms = ns / 1e6 / iters
  console.log(`  ${label.padEnd(50)} ${ms.toFixed(2).padStart(8)} ms × ${iters}`)
  return ms
}

function main() {
  const N = Number(process.argv[2] || 1000)
  const M = Number(process.argv[3] || 5)
  const H = Number(process.argv[4] || 30)
  console.log(`\n=== Benchmark: ${N} notebooks × ${M} tasks each (= ${N * M} tasks), recurring history ${H}d ===\n`)
  seedState(N, M, H)

  const storePath = require('path').resolve(__dirname, '../utils/store.js')
  delete require.cache[require.resolve(storePath)]
  const store = require(storePath)

  // 1. Read state
  bench('getStateWithComputed (load+parse+overview)', () => store.getStateWithComputed(), 5)

  // 2. tasksForDate today
  const stateRef = store.getStateWithComputed()
  bench('tasksForDate(today)', () => store.tasksForDate(stateRef, store.todayStr()), 5)

  // 3. tasks page refresh — mirrors pages/tasks/index.js refreshState()
  const today = store.todayStr()
  const decorateNotebook = (nb, tasks) => {
    let doneCount = 0
    if (nb.mode === 'one-shot') {
      for (const t of tasks) {
        if ((t.status || 'todo') === 'done') doneCount++
      }
    } else {
      for (const t of tasks) {
        const occ = (t.occurrences || {})[today]
        if (occ && occ.status === 'done') doneCount++
      }
    }
    const seen = new Set()
    const subjects = []
    for (const t of tasks) {
      const s = t.subject || ''
      if (s && !seen.has(s)) { seen.add(s); subjects.push(s) }
    }
    return { id: nb.id, taskCount: tasks.length, doneCount, subjects }
  }
  bench('tasks page refresh (decorate × N)', () => {
    const s = store.getStateWithComputed()
    const tasksByNb = {}
    for (const t of s.tasks) {
      const list = tasksByNb[t.notebookId] || (tasksByNb[t.notebookId] = [])
      list.push(t)
    }
    const effEnd = (nb) => nb.endDate || (nb.mode === 'one-shot' ? nb.startDate : null)
    const sorted = [...s.notebooks].sort((a, b) => {
      const ea = effEnd(a)
      const eb = effEnd(b)
      if (ea === eb) return (b.createdAt || 0) - (a.createdAt || 0)
      if (!ea) return -1
      if (!eb) return 1
      return ea < eb ? 1 : -1
    })
    return sorted.map((nb) => decorateNotebook(nb, tasksByNb[nb.id] || []))
  }, 5)

  // 4. Calendar month grid (current month — includes today's expensive backlog)
  const now = new Date()
  const buildGridFromTasksForDate = (year, month) => {
    const s = store.getStateWithComputed()
    const days = new Date(year, month + 1, 0).getDate()
    const cells = []
    const cache = {}
    for (let d = 1; d <= days; d++) {
      const pad = (n) => String(n).padStart(2, '0')
      const ds = `${year}-${pad(month + 1)}-${pad(d)}`
      const items = store.tasksForDate(s, ds, cache)
      cells.push({
        total: items.length,
        done: items.filter((it) => it.occurrence.status === 'done').length,
        hasOverdue: items.some((it) => it.isOverdue)
      })
    }
    return cells
  }
  bench('calendar grid: current month (with today)', () =>
    buildGridFromTasksForDate(now.getFullYear(), now.getMonth()), 3)
  // Past month — no today, so no backlog walk
  const pastMonth = (() => {
    const d = new Date(now)
    d.setMonth(d.getMonth() - 2)
    return { y: d.getFullYear(), m: d.getMonth() }
  })()
  bench('calendar grid: past month (no today)', () =>
    buildGridFromTasksForDate(pastMonth.y, pastMonth.m), 3)
  // Calendar grid using new aggregator (will be added)
  if (typeof store.dateCountsForMonth === 'function') {
    bench('calendar grid: aggregator current', () => {
      const s = store.getStateWithComputed()
      return store.dateCountsForMonth(s, now.getFullYear(), now.getMonth())
    }, 5)
    bench('calendar grid: aggregator past', () => {
      const s = store.getStateWithComputed()
      return store.dateCountsForMonth(s, pastMonth.y, pastMonth.m)
    }, 5)
  }

  // 5. Mutation: finishTask
  bench('finishTask (mutation: load+map+save)', () => {
    // pick a random one-shot task each call to avoid cache
    const idx = Math.floor(Math.random() * (N * M))
    const i = Math.floor(idx / M)
    const j = idx % M
    if (i % 5 !== 0) {  // skip recurring (would mutate occurrences)
      store.finishTask(`tk_${i}_${j}`, store.todayStr())
    }
  }, 5)

  // 6. Stats lifetime aggregation
  bench('stats onShow (lifetime done aggregation)', () => {
    const s = store.getStateWithComputed()
    const today = store.todayStr()
    const todayItems = store.tasksForDate(s, today)
    const notebookById = {}
    for (const nb of s.notebooks) notebookById[nb.id] = nb
    let lifetimeDone = 0
    for (const t of s.tasks) {
      const nb = notebookById[t.notebookId]
      if (!nb) continue
      if (nb.mode === 'one-shot') {
        if ((t.status || 'todo') === 'done') lifetimeDone++
      } else {
        const occ = t.occurrences || {}
        for (const dateStr of Object.keys(occ)) {
          if (occ[dateStr].status === 'done') lifetimeDone++
        }
      }
    }
    return { todayItems: todayItems.length, lifetimeDone }
  }, 5)

  console.log()
}

main()
