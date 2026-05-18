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
      const rowOrder = store.getRowOrder(it.task, occurrenceDate)
      return {
        // composite id so multiple occurrences of the same task don't collide
        // in wx:key
        id: occurrenceDate ? `${it.task.id}__${occurrenceDate}` : it.task.id,
        taskId: it.task.id,
        taskMode: it.task.mode || 'one-shot',
        occurrenceDate,
        subject: it.task.subject || '',
        recurrenceLabel: store.formatRecurrenceLabel(it.task),
        organization: it.task.organization || '其他',
        content: it.task.content,
        estimatedMinutes: it.task.estimatedMinutes,
        rowOrder,
        createdAt: it.task.createdAt || 0,
        completedAt: occ.completedAt || 0,
        status: occ.status,
        // store.tasksForDate 在历史视图里已经只对"本日漏做被后来补的"标
        // isOverdue=true,正常 done 不会带,所以直接透传就行。
        isOverdue: it.isOverdue,
        isMakeup: !!it.isMakeup,
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
    selectedItems: [],
    // Locks the inner <scroll-view> while a task-list drag is in progress.
    // See pages/home/index.js for the rationale.
    disableScroll: false
  },

  onReady() {
    this.createSelectorQuery().select('#scrollarea').node().exec((res) => {
      if (res && res[0]) this._scrollVw = res[0].node
    })
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

  refresh() {
    const state = store.getStateWithComputed()
    const selectedDate = this.data.selectedDate || store.todayStr()
    const items = decorateDayItems(store.tasksForDate(state, selectedDate), Date.now())
    this.setData({
      selectedDate,
      selectedItems: items,
      selectedLabel: this.formatDateLabel(selectedDate)
    })
    const cal = this.selectComponent('#cal')
    if (cal) cal.refresh()
  },

  formatDateLabel(date) {
    const today = store.todayStr()
    if (date === today) return `今日 · ${date}`
    if (date === store.addDays(today, -1)) return `昨日 · ${date}`
    if (date === store.addDays(today, 1)) return `明日 · ${date}`
    return date
  },

  handleCalendarChange(e) {
    const date = e.detail && e.detail.date
    if (!date) return
    this.setData({ selectedDate: date })
    this.refresh()
  },

  // task-list emits this whenever an action runs or a drag commits
  handleTasksChanged() {
    this.refresh()
  },

  handleDragStart() { this.setData({ disableScroll: true }) },
  handleDragEnd() { this.setData({ disableScroll: false }) },

  handleScrollAreaScroll(e) {
    this._curScrollTop = (e && e.detail && e.detail.scrollTop) || 0
  },

  handleScrollBy(e) {
    const deltaY = (e && e.detail && e.detail.deltaY) || 0
    if (!deltaY || !this._scrollVw) return
    const next = Math.max(0, (this._curScrollTop || 0) + deltaY)
    this._curScrollTop = next
    this._scrollVw.scrollTo({ top: next, duration: 0 })
  }
})
