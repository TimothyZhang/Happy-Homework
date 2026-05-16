const store = require('../../utils/store')
const cloudSync = require('../../utils/cloud-sync')
const perf = require('../../utils/perf')

const WEEKDAY_NAMES = ['一', '二', '三', '四', '五', '六', '日']

function describeRecurrence(nb) {
  if (!nb.recurrence) return '每日'
  if (nb.recurrence.type === 'daily') return '每日'
  if (nb.recurrence.type === 'weekly') {
    const wds = (nb.recurrence.weekdays || []).slice().sort()
    if (!wds.length) return '每周（未选日）'
    return '每周' + wds.map((w) => WEEKDAY_NAMES[w - 1]).join('、')
  }
  return ''
}

function describeRange(nb) {
  if (nb.mode === 'one-shot') {
    const start = nb.startDate
    const end = nb.endDate || nb.startDate
    if (start === end) return `${end}`
    return `${start} → ${end}`
  }
  const tail = nb.endDate ? `→ ${nb.endDate}` : '→ 长期'
  return `${nb.startDate} ${tail}`
}

function decorateNotebook(nb, tasks, today) {
  // 卡片"今日"chip 的判定:
  //   - 一次性:本里有任意 task 今天到期(effectiveDueDate=today)或有过期未完成 task。
  //     不再仅看 notebook.endDate,跟首页一致。
  //   - 周期性:沿用 notebook 调度。
  let activeToday = false
  if (nb.mode === 'one-shot') {
    for (const t of tasks) {
      const due = store.effectiveDueDate(t, nb)
      if (!due) continue
      if (due === today) { activeToday = true; break }
      if (due < today && (t.status || 'todo') !== 'done') { activeToday = true; break }
    }
  } else {
    activeToday = store.isNotebookActiveOn(nb, today)
  }
  // Count overall completion for one-shot, today's completion for recurring
  let doneCount = 0
  const totalCount = tasks.length
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
  // Distinct subjects within this notebook (in the order they appear)
  const seen = new Set()
  const subjects = []
  for (const t of tasks) {
    const s = t.subject || ''
    if (s && !seen.has(s)) { seen.add(s); subjects.push(s) }
  }
  // Visual fade-out: one-shot notebooks where every task is done. Recurring
  // notebooks loop forever — they're never "complete", so they don't fade.
  const allDone = nb.mode === 'one-shot' && totalCount > 0 && doneCount === totalCount
  return {
    ...nb,
    taskCount: totalCount,
    doneCount,
    subjects,
    progressPercent: totalCount ? Math.round((doneCount / totalCount) * 100) : 0,
    modeLabel: nb.mode === 'recurring' ? '重复' : '一次性',
    rangeLabel: describeRange(nb),
    recurrenceLabel: nb.mode === 'recurring' ? describeRecurrence(nb) : '',
    activeToday,
    allDone
  }
}

Page({
  data: {
    notebooks: [],
    completedNotebooks: [],
    hiddenEmpty: [],
    showCompleted: false,
    showHiddenEmpty: false
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
    // Group tasks by notebook once → O(N+M) instead of N filters over M tasks.
    const tasksByNb = {}
    for (const t of state.tasks) {
      const list = tasksByNb[t.notebookId] || (tasksByNb[t.notebookId] = [])
      list.push(t)
    }
    // Sort by effective end date, latest first. Recurring notebooks without
    // an end date are ongoing — treat them as "ends later than anything
    // dated" and float them to the top.
    const effectiveEnd = (nb) => nb.endDate || (nb.mode === 'one-shot' ? nb.startDate : null)
    const sorted = [...state.notebooks].sort((a, b) => {
      const ea = effectiveEnd(a)
      const eb = effectiveEnd(b)
      if (ea === eb) return (b.createdAt || 0) - (a.createdAt || 0)
      if (!ea) return -1
      if (!eb) return 1
      return ea < eb ? 1 : -1
    })
    const all = sorted.map((nb) => decorateNotebook(nb, tasksByNb[nb.id] || [], today))
    const notebooks = []
    const completedNotebooks = []
    const hiddenEmpty = []
    for (const nb of all) {
      if (nb.allDone) {
        completedNotebooks.push(nb)
      } else if (nb.taskCount === 0) {
        const end = effectiveEnd(nb)
        if (end && end < today) hiddenEmpty.push(nb)
        else notebooks.push(nb)
      } else {
        notebooks.push(nb)
      }
    }
    this.setData({ notebooks, completedNotebooks, hiddenEmpty }, perfStamp ? () => perf.markPaint(perfStamp) : undefined)
  },

  handleToggleCompleted() {
    this.setData({ showCompleted: !this.data.showCompleted })
  },

  handleToggleHiddenEmpty() {
    this.setData({ showHiddenEmpty: !this.data.showHiddenEmpty })
  },

  handleAddNotebook() {
    wx.navigateTo({ url: '/pkg-notebook/notebook-edit/index' })
  },

  handleOpenNotebook(event) {
    const { id } = event.currentTarget.dataset
    wx.navigateTo({ url: `/pages/notebook-detail/index?id=${id}` })
  },

  handleEditNotebook(event) {
    const { id } = event.currentTarget.dataset
    wx.navigateTo({ url: `/pkg-notebook/notebook-edit/index?id=${id}` })
  },

  handleDeleteNotebook(event) {
    const { id } = event.currentTarget.dataset
    const nb = this.data.notebooks.find((n) => n.id === id)
    if (!nb) return
    wx.showModal({
      title: `删除作业本「${nb.name}」？`,
      content: `本里 ${nb.taskCount} 项作业也会一起删除。`,
      confirmColor: '#e54545',
      success: (res) => {
        if (res.confirm) {
          store.deleteNotebook(id)
          this.refreshState()
          wx.showToast({ title: '已删除', icon: 'success' })
        }
      }
    })
  }
})
