const store = require('../../utils/store')

function formatElapsed(ms) {
  if (!ms || ms < 0) return ''
  const totalSec = Math.floor(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min === 0) return `${sec} 秒`
  if (sec === 0) return `${min} 分钟`
  return `${min} 分 ${sec} 秒`
}

function formatDuration(minutes) {
  if (!minutes || minutes < 0) return '—'
  if (minutes < 60) return `${minutes} 分钟`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (m === 0) return `${h} 小时`
  return `${h}h${m}m`
}

function decorateItem(item, now) {
  const occ = item.occurrence
  let elapsedMs = occ.accumulatedMs || 0
  if (occ.status === 'doing' && occ.currentSegmentStartedAt) {
    elapsedMs += Math.max(0, now - occ.currentSegmentStartedAt)
  }
  return {
    id: item.task.id,
    notebookId: item.notebook.id,
    notebookName: item.notebook.name,
    subject: item.task.subject || '',
    content: item.task.content,
    estimatedMinutes: item.task.estimatedMinutes,
    order: item.task.order || 0,
    createdAt: item.task.createdAt || 0,
    completedAt: occ.completedAt || 0,
    status: occ.status,
    isOverdue: item.isOverdue,
    elapsedMs,
    elapsedDisplay: elapsedMs > 0 ? formatElapsed(elapsedMs) : ''
  }
}

// Undone first, in user-controlled order (task.order asc, createdAt as tiebreaker).
// Done sinks to bottom, sorted by completedAt desc (most recently finished on top).
function sortItems(items) {
  const undone = []
  const done = []
  for (const it of items) {
    if (it.status === 'done') done.push(it)
    else undone.push(it)
  }
  undone.sort((a, b) => {
    const oa = a.order || 0
    const ob = b.order || 0
    if (oa !== ob) return oa - ob
    return (a.createdAt || 0) - (b.createdAt || 0)
  })
  done.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
  return [...undone, ...done]
}

Page({
  data: {
    activeDate: '',
    activeDateLabel: '',
    isToday: true,
    canPrev: true,
    canNext: true,
    overview: { totalCount: 0, pendingCount: 0, doneCount: 0 },
    remainingMinutesDisplay: '—',
    items: [],
    overdueItems: [],
    showCongrats: false,
    totalElapsedDisplay: '',
    lastReward: null,
    dragId: null,
    dragDy: 0
  },

  onShow() {
    if (!this.data.activeDate) {
      this.setData({ activeDate: store.todayStr() })
    }
    this.refreshState()
    this.startTickerIfNeeded()
  },
  onHide() { this.stopTicker() },
  onUnload() { this.stopTicker() },

  refreshState(opts = {}) {
    const today = store.todayStr()
    const activeDate = this.data.activeDate || today
    const isToday = activeDate === today
    const state = store.getStateWithComputed()
    const now = Date.now()
    const raw = store.tasksForDate(state, activeDate)
    // Today view splits scheduled-today vs overdue-from-past so they live
    // in separate cards.
    const todayRaw = raw.filter((it) => !it.isOverdue)
    const overdueRaw = isToday ? raw.filter((it) => it.isOverdue) : []
    const items = sortItems(todayRaw.map((it) => decorateItem(it, now)))
    const overdueItems = overdueRaw
      .map((it) => decorateItem(it, now))
      .sort((a, b) => (a.order || 0) - (b.order || 0))
    const total = items.length
    const done = items.filter((it) => it.status === 'done').length
    const pending = total - done
    const remainingMinutes = items
      .filter((it) => it.status !== 'done')
      .reduce((s, it) => s + Number(it.estimatedMinutes || 0), 0)
    this.setData({
      activeDate,
      activeDateLabel: this.formatDateLabel(activeDate, today),
      isToday,
      overview: { totalCount: total, pendingCount: pending, doneCount: done },
      remainingMinutesDisplay: formatDuration(remainingMinutes),
      items,
      overdueItems,
      lastReward: state.lastReward || null
    })
    this.startTickerIfNeeded()
    if (opts.maybeCelebrate) this.maybeShowCongrats(items)
  },

  formatDateLabel(date, today) {
    if (date === today) return `今日 · ${date}`
    if (date === store.addDays(today, -1)) return `昨日 · ${date}`
    if (date === store.addDays(today, 1)) return `明日 · ${date}`
    return date
  },

  startTickerIfNeeded() {
    this.stopTicker()
    if (!this.data.isToday) return
    const hasRunning = (this.data.items || []).some((it) => it.status === 'doing')
    if (!hasRunning) return
    this.tickerId = setInterval(() => {
      const items = (this.data.items || []).map((it) => {
        let ms = it.elapsedMs || 0
        if (it.status === 'doing') ms += 1000
        return { ...it, elapsedMs: ms, elapsedDisplay: formatElapsed(ms) }
      })
      this.setData({ items })
      if (!items.some((it) => it.status === 'doing')) this.stopTicker()
    }, 1000)
  },

  stopTicker() {
    if (this.tickerId) { clearInterval(this.tickerId); this.tickerId = null }
  },

  maybeShowCongrats(items) {
    if (!items || items.length === 0) return
    if (!this.data.isToday) return
    const allDone = items.every((it) => it.status === 'done')
    if (!allDone) return
    const totalMs = items.reduce((s, it) => s + (it.elapsedMs || 0), 0)
    this.setData({
      showCongrats: true,
      totalElapsedDisplay: totalMs > 0 ? formatElapsed(totalMs) : ''
    })
  },

  handleDismissCongrats() { this.setData({ showCongrats: false }) },

  // === Day switcher === //

  handlePrevDay() {
    this.setData({ activeDate: store.addDays(this.data.activeDate, -1) })
    this.refreshState()
  },

  handleNextDay() {
    this.setData({ activeDate: store.addDays(this.data.activeDate, 1) })
    this.refreshState()
  },

  handleJumpToday() {
    this.setData({ activeDate: store.todayStr() })
    this.refreshState()
  },

  handleOpenCalendar() {
    wx.switchTab({ url: '/pages/calendar/index' })
  },

  // === Task control (locked to active date) === //

  handleStartTask(e) {
    store.startTask(e.currentTarget.dataset.id, this.data.activeDate)
    this.refreshState()
  },

  handlePauseTask(e) {
    store.pauseTask(e.currentTarget.dataset.id, this.data.activeDate)
    this.refreshState()
  },

  handleResumeTask(e) {
    store.resumeTask(e.currentTarget.dataset.id, this.data.activeDate)
    this.refreshState()
  },

  handleFinishTask(e) {
    store.finishTask(e.currentTarget.dataset.id, this.data.activeDate)
    this.refreshState({ maybeCelebrate: true })
  },

  // === Navigation === //

  handleManageTasks() { wx.switchTab({ url: '/pages/tasks/index' }) },

  handleAddHomework() { wx.switchTab({ url: '/pages/tasks/index' }) },

  handlePhotoImport() { wx.navigateTo({ url: '/pages/ocr-import/index' }) },

  handleOpenNotebook(e) {
    const { notebookId } = e.currentTarget.dataset
    wx.navigateTo({ url: `/pages/notebook-detail/index?id=${notebookId}` })
  },

  // === Drag-reorder (today only, all undone tasks regardless of notebook) === //

  handleLongPress(e) {
    if (!this.data.isToday) return
    const { id } = e.currentTarget.dataset
    const item = this.data.items.find((it) => it.id === id)
    if (!item || item.status === 'done') return
    if (e.touches && e.touches[0]) this.dragStartY = e.touches[0].pageY
    if (!this.itemHeightPx) {
      const q = wx.createSelectorQuery()
      q.select('.task-row').boundingClientRect()
      q.exec((rects) => { if (rects && rects[0]) this.itemHeightPx = rects[0].height + 12 })
    }
    this.setData({ dragId: id, dragDy: 0 })
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })
  },

  handleTouchMove(e) {
    if (!this.data.dragId || !this.dragStartY) return
    const now = Date.now()
    if (this._lastMoveAt && now - this._lastMoveAt < 16) return
    this._lastMoveAt = now
    const t = e.touches && e.touches[0]
    if (!t) return
    const dy = t.pageY - this.dragStartY
    if (Math.abs(dy - this.data.dragDy) < 2) return
    const itemH = this.itemHeightPx || 140
    const list = this.data.items
    const undoneCount = list.filter((it) => it.status !== 'done').length
    const draggedIdx = list.findIndex((it) => it.id === this.data.dragId)
    const slotsDelta = Math.round(dy / itemH)
    const hoverIdx = Math.max(0, Math.min(undoneCount - 1, draggedIdx + slotsDelta))
    const updated = list.map((it, i) => {
      if (it.id === this.data.dragId) return it
      if (it.status === 'done') return it
      let shiftY = 0
      if (draggedIdx < hoverIdx && i > draggedIdx && i <= hoverIdx) shiftY = -itemH
      else if (draggedIdx > hoverIdx && i >= hoverIdx && i < draggedIdx) shiftY = itemH
      return { ...it, shiftY }
    })
    this.setData({ items: updated, dragDy: dy })
  },

  handleTouchEnd() {
    if (!this.data.dragId) {
      this.dragStartY = null
      return
    }
    const dragId = this.data.dragId
    const dragDy = this.data.dragDy
    const itemH = this.itemHeightPx || 140
    const list = this.data.items
    const undoneCount = list.filter((it) => it.status !== 'done').length
    const fromIdx = list.findIndex((it) => it.id === dragId)
    const slotsDelta = Math.round(dragDy / itemH)
    const toIdx = Math.max(0, Math.min(undoneCount - 1, fromIdx + slotsDelta))

    if (fromIdx !== -1 && fromIdx !== toIdx && fromIdx < undoneCount) {
      const undoneIds = list.filter((it) => it.status !== 'done').map((it) => it.id)
      const [moved] = undoneIds.splice(fromIdx, 1)
      undoneIds.splice(toIdx, 0, moved)
      store.reorderTasks(undoneIds)
      this.refreshState()
    } else {
      this.setData({ items: list.map((it) => ({ ...it, shiftY: 0 })) })
    }
    this.dragStartY = null
    this.setData({ dragId: null, dragDy: 0 })
  }
})
