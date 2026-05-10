const store = require('../../utils/store')
const cloudSync = require('../../utils/cloud-sync')

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

function decorateNotebook(nb, allTasks) {
  const tasks = allTasks.filter((t) => t.notebookId === nb.id)
  const today = store.todayStr()
  const activeToday = store.isNotebookActiveOn(nb, today)
  // Count overall completion for one-shot, today's completion for recurring
  let doneCount = 0
  let totalCount = tasks.length
  if (nb.mode === 'one-shot') {
    doneCount = tasks.filter((t) => (t.status || 'todo') === 'done').length
  } else {
    doneCount = tasks.filter((t) => {
      const occ = (t.occurrences || {})[today]
      return occ && occ.status === 'done'
    }).length
  }
  // Distinct subjects within this notebook (in the order they appear)
  const seen = new Set()
  const subjects = []
  for (const t of tasks) {
    const s = t.subject || ''
    if (s && !seen.has(s)) { seen.add(s); subjects.push(s) }
  }
  return {
    ...nb,
    taskCount: totalCount,
    doneCount,
    subjects,
    progressPercent: totalCount ? Math.round((doneCount / totalCount) * 100) : 0,
    modeLabel: nb.mode === 'recurring' ? '重复' : '一次性',
    rangeLabel: describeRange(nb),
    recurrenceLabel: nb.mode === 'recurring' ? describeRecurrence(nb) : '',
    activeToday
  }
}

Page({
  data: {
    notebooks: [],
    dragId: null,
    dragDy: 0
  },

  onShow() {
    const tb = typeof this.getTabBar === 'function' && this.getTabBar()
    if (tb) tb.setData({ selected: 1 })
    this.refreshState()
    cloudSync.hydrateIfStale().then((r) => {
      if (r && r.changed) this.refreshState()
    }).catch(() => {})
  },

  refreshState() {
    const state = store.getStateWithComputed()
    const sorted = [...state.notebooks].sort((a, b) => (a.order || 0) - (b.order || 0))
    const notebooks = sorted.map((nb) => decorateNotebook(nb, state.tasks))
    this.setData({ notebooks })
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
  },

  handleViewCalendar() {
    wx.switchTab({ url: '/pages/calendar/index' })
  },

  // === Drag-reorder notebooks === //

  handleTouchStart(event) {
    if (event.touches && event.touches[0]) {
      this.touchStartY = event.touches[0].pageY
    }
  },

  handleLongPress(event) {
    const { id } = event.currentTarget.dataset
    this.dragStartY = this.touchStartY != null
      ? this.touchStartY
      : (event.detail && typeof event.detail.y === 'number' ? event.detail.y : 0)
    if (!this.itemHeightPx) {
      const q = wx.createSelectorQuery()
      q.select('.notebook-card').boundingClientRect()
      q.exec((rects) => {
        if (rects && rects[0]) this.itemHeightPx = rects[0].height + 16
      })
    }
    this.setData({ dragId: id, dragDy: 0 })
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })
  },

  handleTouchMove(event) {
    if (!this.data.dragId || this.dragStartY == null) return
    const now = Date.now()
    if (this._lastMoveAt && now - this._lastMoveAt < 16) return
    this._lastMoveAt = now
    const t = event.touches && event.touches[0]
    if (!t) return
    const dy = t.pageY - this.dragStartY
    if (Math.abs(dy - this.data.dragDy) < 2) return
    const itemH = this.itemHeightPx || 200
    const list = this.data.notebooks
    const draggedIdx = list.findIndex((n) => n.id === this.data.dragId)
    const slotsDelta = Math.round(dy / itemH)
    const hoverIdx = Math.max(0, Math.min(list.length - 1, draggedIdx + slotsDelta))
    const updated = list.map((n, i) => {
      if (n.id === this.data.dragId) return n
      let shiftY = 0
      if (draggedIdx < hoverIdx && i > draggedIdx && i <= hoverIdx) shiftY = -itemH
      else if (draggedIdx > hoverIdx && i >= hoverIdx && i < draggedIdx) shiftY = itemH
      return { ...n, shiftY }
    })
    this.setData({ notebooks: updated, dragDy: dy })
  },

  handleTouchEnd() {
    if (!this.data.dragId) {
      this.dragStartY = null
      this.touchStartY = null
      return
    }
    const dragId = this.data.dragId
    const dragDy = this.data.dragDy
    const itemH = this.itemHeightPx || 200
    const list = this.data.notebooks
    const fromIdx = list.findIndex((n) => n.id === dragId)
    const slotsDelta = Math.round(dragDy / itemH)
    const toIdx = Math.max(0, Math.min(list.length - 1, fromIdx + slotsDelta))

    if (fromIdx !== -1 && fromIdx !== toIdx) {
      const ids = list.map((n) => n.id)
      const [moved] = ids.splice(fromIdx, 1)
      ids.splice(toIdx, 0, moved)
      store.reorderNotebooks(ids)
      this.refreshState()
    } else {
      const reset = list.map((n) => ({ ...n, shiftY: 0 }))
      this.setData({ notebooks: reset })
    }
    this.dragStartY = null
    this.touchStartY = null
    this.setData({ dragId: null, dragDy: 0 })
  },

})
