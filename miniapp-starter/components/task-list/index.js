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

Component({
  options: { addGlobalClass: true },
  properties: {
    // Pre-decorated items (id, notebookId, notebookName, subject, content,
    // estimatedMinutes, status, order, completedAt, isOverdue,
    // elapsedMs, elapsedDisplay)
    items: { type: Array, value: [] },
    // Date the items belong to. Passed through to store control calls so
    // recurring tasks update the right occurrence.
    activeDate: { type: String, value: '' },
    // Whether to enable long-press drag reorder.
    enableDrag: { type: Boolean, value: true },
    // Optional row variant class (e.g. 'is-overdue') applied to every row.
    rowVariant: { type: String, value: '' }
  },
  data: {
    list: [],
    dragId: null,
    dragDy: 0
  },
  observers: {
    'items': function (items) {
      const list = (items || []).map((it) => ({ ...it, shiftY: 0 }))
      this.setData({ list })
      this.startTickerIfNeeded()
    }
  },
  detached() { this.stopTicker() },
  methods: {
    startTickerIfNeeded() {
      this.stopTicker()
      const list = this.data.list || []
      if (!list.some((it) => it.status === 'doing')) return
      this.tickerId = setInterval(() => {
        const next = (this.data.list || []).map((it) => {
          let ms = it.elapsedMs || 0
          if (it.status === 'doing') ms += 1000
          return { ...it, elapsedMs: ms, elapsedDisplay: formatElapsed(ms) }
        })
        this.setData({ list: next })
        if (!next.some((it) => it.status === 'doing')) this.stopTicker()
      }, 1000)
    },
    stopTicker() {
      if (this.tickerId) { clearInterval(this.tickerId); this.tickerId = null }
    },

    // === Drag === //

    handleTouchStart(e) {
      if (!this.data.enableDrag) return
      if (e.touches && e.touches[0]) this.touchStartY = e.touches[0].pageY
    },
    handleLongPress(e) {
      if (!this.data.enableDrag) return
      const id = e.currentTarget.dataset.id
      const item = this.data.list.find((it) => it.id === id)
      if (!item || item.status === 'done') return
      this.dragStartY = this.touchStartY != null
        ? this.touchStartY
        : (e.detail && typeof e.detail.y === 'number' ? e.detail.y : 0)
      if (!this.itemHeightPx) {
        const q = this.createSelectorQuery()
        q.select('.task-row').boundingClientRect()
        q.exec((rects) => { if (rects && rects[0]) this.itemHeightPx = rects[0].height + 12 })
      }
      this.setData({ dragId: id, dragDy: 0 })
      if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })
    },
    handleTouchMove(e) {
      if (!this.data.dragId || this.dragStartY == null) return
      const now = Date.now()
      if (this._lastMoveAt && now - this._lastMoveAt < 16) return
      this._lastMoveAt = now
      const t = e.touches && e.touches[0]
      if (!t) return
      const dy = t.pageY - this.dragStartY
      if (Math.abs(dy - this.data.dragDy) < 2) return
      const itemH = this.itemHeightPx || 140
      const list = this.data.list
      const draggedIdx = list.findIndex((it) => it.id === this.data.dragId)
      const undoneCount = list.filter((it) => it.status !== 'done').length
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
      this.setData({ list: updated, dragDy: dy })
    },
    handleTouchEnd() {
      if (!this.data.dragId) {
        this.dragStartY = null
        this.touchStartY = null
        return
      }
      const dragId = this.data.dragId
      const dragDy = this.data.dragDy
      const itemH = this.itemHeightPx || 140
      const list = this.data.list
      const undoneCount = list.filter((it) => it.status !== 'done').length
      const fromIdx = list.findIndex((it) => it.id === dragId)
      const slotsDelta = Math.round(dragDy / itemH)
      const toIdx = Math.max(0, Math.min(undoneCount - 1, fromIdx + slotsDelta))

      if (fromIdx !== -1 && fromIdx !== toIdx && fromIdx < undoneCount) {
        const undoneIds = list.filter((it) => it.status !== 'done').map((it) => it.id)
        const [moved] = undoneIds.splice(fromIdx, 1)
        undoneIds.splice(toIdx, 0, moved)
        store.reorderTasks(undoneIds)
        this.triggerEvent('changed')
      } else {
        this.setData({ list: list.map((it) => ({ ...it, shiftY: 0 })) })
      }
      this.dragStartY = null
      this.touchStartY = null
      this.setData({ dragId: null, dragDy: 0 })
    },

    // === Actions === //

    handleStart(e) {
      store.startTask(e.currentTarget.dataset.id, this.data.activeDate)
      this.triggerEvent('changed')
    },
    handlePause(e) {
      store.pauseTask(e.currentTarget.dataset.id, this.data.activeDate)
      this.triggerEvent('changed')
    },
    handleResume(e) {
      store.resumeTask(e.currentTarget.dataset.id, this.data.activeDate)
      this.triggerEvent('changed')
    },
    handleFinish(e) {
      store.finishTask(e.currentTarget.dataset.id, this.data.activeDate)
      this.triggerEvent('changed', { finished: true })
    },
    handleOpenNotebook(e) {
      const { notebookId } = e.currentTarget.dataset
      if (!notebookId) return
      wx.navigateTo({ url: `/pages/notebook-detail/index?id=${notebookId}` })
    }
  }
})
