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

// undone row 只有 "编辑" 按钮(删除入口收进编辑页内) → 120rpx;
// done row 有 "编辑" + "继续" → 240rpx。
const SWIPE_MAX_RPX = { done: 240, undone: 120 }

Component({
  options: { addGlobalClass: true },
  properties: {
    // Pre-decorated items (id, taskId, taskMode, subject, organization, content,
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
    dragDy: 0,
    swipeId: null,       // 当前正在 swipe 的 row id(touchmove 中)
    swipeDx: 0,          // swipe 期间 row 的 x 位移(rpx)
    swipeOpenId: null,   // 当前展开 swipe-action 的 row id
    swipeOpenMax: 0      // 当前展开的 max 偏移(rpx) — done 120 / undone 240
  },
  observers: {
    'items': function (items) {
      const list = (items || []).map((it) => ({
        ...it,
        shiftY: 0,
        swipeMax: it.status === 'done' ? SWIPE_MAX_RPX.done : SWIPE_MAX_RPX.undone
      }))
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

    // === Unified gesture dispatcher === //
    // 一条 row 同时支持:
    //   - 长按 → 拖拽排序(longpress 触发 mode=drag)
    //   - 横滑 → 显示 swipe-action(touchmove 横向偏移 > 阈值时 mode=swipe)
    //   - 纵滑 → 让父 scroll-view 滚(mode=scroll,不阻止)
    // 进入 drag/swipe 后,模式互斥到 touchend。

    handleRowTouchStart(e) {
      const t = (e.touches && e.touches[0]) || null
      this.touchStartX = t ? t.pageX : 0
      this.touchStartY = t ? t.pageY : 0
      this._gestureMode = 'pending'
      this._gestureRowId = e.currentTarget.dataset.id
      // 触摸到另一个 row 时,关闭已展开的 swipe-action
      if (this.data.swipeOpenId && this.data.swipeOpenId !== this._gestureRowId) {
        this.setData({ swipeOpenId: null, swipeOpenMax: 0 })
      }
    },

    handleRowLongPress(e) {
      // longpress 触发拖拽 — 仅 pending 状态可升级(用户没移动)
      if (this._gestureMode !== 'pending') return
      if (!this.data.enableDrag) return
      const id = e.currentTarget.dataset.id
      const item = this.data.list.find((it) => it.id === id)
      if (!item || item.status === 'done') return
      this._gestureMode = 'drag'
      this.dragStartY = this.touchStartY != null ? this.touchStartY : 0
      if (!this.itemHeightPx) {
        const q = this.createSelectorQuery()
        q.select('.task-row').boundingClientRect()
        q.exec((rects) => { if (rects && rects[0]) this.itemHeightPx = rects[0].height + 12 })
      }
      this.setData({ dragId: id, dragDy: 0 })
      if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })
      this.triggerEvent('dragstart')
    },

    handleRowTouchMove(e) {
      const t = e.touches && e.touches[0]
      if (!t) return
      const dx = t.pageX - (this.touchStartX || 0)
      const dy = t.pageY - (this.touchStartY || 0)

      if (this._gestureMode === 'pending') {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return
        if (Math.abs(dx) > Math.abs(dy)) {
          this._gestureMode = 'swipe'
        } else {
          this._gestureMode = 'scroll'
          return
        }
      }

      if (this._gestureMode === 'drag') {
        const now = Date.now()
        if (this._lastMoveAt && now - this._lastMoveAt < 16) return
        this._lastMoveAt = now
        if (Math.abs(dy - this.data.dragDy) < 2) return
        const itemH = this.itemHeightPx || 140
        const list = this.data.list
        const draggedIdx = list.findIndex((it) => it.id === this.data.dragId)
        const dragZone = []
        list.forEach((it, i) => {
          if (it.status === 'done') return
          dragZone.push(i)
        })
        if (dragZone.length === 0) return
        const minIdx = dragZone[0]
        const maxIdx = dragZone[dragZone.length - 1]
        const slotsDelta = Math.round(dy / itemH)
        const hoverIdx = Math.max(minIdx, Math.min(maxIdx, draggedIdx + slotsDelta))
        const updated = list.map((it, i) => {
          if (it.id === this.data.dragId) return it
          if (it.status === 'done') return it
          let shiftY = 0
          if (draggedIdx < hoverIdx && i > draggedIdx && i <= hoverIdx) shiftY = -itemH
          else if (draggedIdx > hoverIdx && i >= hoverIdx && i < draggedIdx) shiftY = itemH
          return { ...it, shiftY }
        })
        this.setData({ list: updated, dragDy: dy })
      } else if (this._gestureMode === 'swipe') {
        const id = this._gestureRowId
        const item = this.data.list.find((it) => it.id === id)
        if (!item) return
        const swipeMax = item.swipeMax || SWIPE_MAX_RPX.undone
        const isOpen = this.data.swipeOpenId === id
        const base = isOpen ? -swipeMax : 0
        const tx = Math.max(-swipeMax, Math.min(0, base + dx))
        this.setData({ swipeId: id, swipeDx: tx })
      }
    },

    handleRowTouchEnd() {
      if (this._gestureMode === 'drag') {
        this.triggerEvent('dragend')
        const dragId = this.data.dragId
        const dragDy = this.data.dragDy
        const itemH = this.itemHeightPx || 140
        const list = this.data.list
        const dragZone = []
        list.forEach((it, i) => {
          if (it.status === 'done') return
          dragZone.push(i)
        })
        const fromIdx = list.findIndex((it) => it.id === dragId)
        const fromZoneIdx = dragZone.indexOf(fromIdx)
        const slotsDelta = Math.round(dragDy / itemH)
        const toZoneIdx = Math.max(0, Math.min(dragZone.length - 1, fromZoneIdx + slotsDelta))
        if (fromZoneIdx !== -1 && fromZoneIdx !== toZoneIdx) {
          const rows = dragZone.map((listIdx) => {
            const it = list[listIdx]
            return { taskId: it.taskId || it.id, occurrenceDate: it.occurrenceDate || '' }
          })
          const [moved] = rows.splice(fromZoneIdx, 1)
          rows.splice(toZoneIdx, 0, moved)
          store.reorderRows(rows)
          this.triggerEvent('changed')
        } else {
          this.setData({ list: list.map((it) => ({ ...it, shiftY: 0 })) })
        }
        this.setData({ dragId: null, dragDy: 0 })
      } else if (this._gestureMode === 'swipe') {
        const id = this._gestureRowId
        const item = this.data.list.find((it) => it.id === id)
        const swipeMax = (item && item.swipeMax) || SWIPE_MAX_RPX.undone
        const dx = this.data.swipeDx
        const opened = dx <= -swipeMax / 2
        this.setData({
          swipeId: null,
          swipeDx: 0,
          swipeOpenId: opened ? id : null,
          swipeOpenMax: opened ? swipeMax : 0
        })
      }
      this.touchStartX = null
      this.touchStartY = null
      this.dragStartY = null
      this._gestureMode = null
      this._gestureRowId = null
    },

    // === Actions === //

    _actionTarget(e) {
      const ds = e.currentTarget.dataset
      return {
        taskId: ds.taskId || ds.id,
        date: ds.occurrenceDate || this.data.activeDate
      }
    },
    handleStart(e) {
      const t = this._actionTarget(e)
      store.startTask(t.taskId, t.date)
      this.triggerEvent('changed')
      // 开始后立即进入全屏 focus 页(大时钟 + 暂停/完成大按钮)。
      this._openFocus(t.taskId, t.date)
    },
    handlePause(e) {
      const t = this._actionTarget(e)
      store.pauseTask(t.taskId, t.date)
      this.triggerEvent('changed')
    },
    handleResume(e) {
      const t = this._actionTarget(e)
      store.resumeTask(t.taskId, t.date)
      this.triggerEvent('changed')
      // 继续(从 paused 进 doing)也跳 focus 页 — 跟 handleStart 一致。
      this._openFocus(t.taskId, t.date)
    },
    handleFinish(e) {
      const t = this._actionTarget(e)
      store.finishTask(t.taskId, t.date)
      this.triggerEvent('changed', { finished: true })
    },

    // 整行 tap:进行中的作业 → 进 focus 页;其他状态忽略(start/resume/pause/
    // finish/edit/swipe 各自的按钮 / 手势已覆盖,行 tap 不做事)。touchmove
    // 触发 swipe/drag 后,小程序不会再触发 bindtap,所以不会跟手势冲突。
    handleRowTap(e) {
      const ds = e.currentTarget.dataset
      if (ds.status !== 'doing') return
      this._openFocus(ds.taskId || ds.id, ds.occurrenceDate || this.data.activeDate)
    },

    _openFocus(taskId, date) {
      if (!taskId) return
      const query = date ? `id=${taskId}&date=${date}` : `id=${taskId}`
      wx.navigateTo({ url: `/pkg-notebook/task-focus/index?${query}` })
    },

    // 左滑后的"编辑"按钮。recurring 弹"此次/整个"二选;one-shot 直接跳整个编辑。
    handleEdit(e) {
      const { taskId, occurrenceDate, taskMode } = e.currentTarget.dataset
      if (!taskId) return
      const date = occurrenceDate || ''
      this.setData({ swipeOpenId: null, swipeOpenMax: 0 })
      if (taskMode === 'recurring' && date) {
        wx.showActionSheet({
          itemList: ['仅编辑此次', '编辑整个作业'],
          success(res) {
            if (res.tapIndex === 0) {
              wx.navigateTo({ url: `/pkg-notebook/task-edit/index?id=${taskId}&instance=${date}` })
            } else if (res.tapIndex === 1) {
              wx.navigateTo({ url: `/pkg-notebook/task-edit/index?id=${taskId}` })
            }
          }
        })
      } else {
        wx.navigateTo({ url: `/pkg-notebook/task-edit/index?id=${taskId}` })
      }
    },

    // done 行 swipe 后的"继续"按钮 — 把任务从 done 退回 paused。
    handleRevert(e) {
      const ds = e.currentTarget.dataset
      const taskId = ds.taskId || ds.id
      const date = ds.occurrenceDate || this.data.activeDate
      store.revertTask(taskId, date)
      this.setData({ swipeOpenId: null, swipeOpenMax: 0, swipeId: null, swipeDx: 0 })
      this.triggerEvent('changed')
    }
  }
})
