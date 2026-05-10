const store = require('../../utils/store')
const cloudSync = require('../../utils/cloud-sync')

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
    selectedDate: '',
    selectedLabel: '',
    selectedItems: []
  },

  onLoad() {
    this.setData({ selectedDate: store.todayStr() })
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
    const selectedDate = patch.selectedDate || this.data.selectedDate
    const items = decorateDayItems(store.tasksForDate(state, selectedDate), Date.now())
    this.setData({
      selectedDate,
      selectedItems: items,
      selectedLabel: this.formatDateLabel(selectedDate)
    })
    // Per-day counts depend on the same store state — re-aggregate the grid.
    const cal = this.selectComponent('#month-cal')
    if (cal) cal.refresh()
  },

  formatDateLabel(date) {
    const today = store.todayStr()
    if (date === today) return `今日 · ${date}`
    if (date === store.addDays(today, -1)) return `昨日 · ${date}`
    if (date === store.addDays(today, 1)) return `明日 · ${date}`
    return date
  },

  handleCalPick(e) {
    const date = e.detail && e.detail.date
    if (!date) return
    this.refresh({ selectedDate: date })
  },

  handleOpenNotebook(e) {
    wx.navigateTo({ url: `/pages/notebook-detail/index?id=${e.currentTarget.dataset.notebookId}` })
  },

  // task-list emits this whenever an action runs or a drag commits
  handleTasksChanged() {
    this.refresh()
  }
})
