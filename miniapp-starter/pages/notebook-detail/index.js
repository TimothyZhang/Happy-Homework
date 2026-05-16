const store = require('../../utils/store')
const cloudSync = require('../../utils/cloud-sync')
const shareReward = require('../../utils/share-reward')

// Subject ordering only — used to group tasks visually under subject headers.
// The add/edit form moved to /pkg-notebook/notebook-task-edit/.
const SUBJECT_ORDER = ['语文', '数学', '英语', '科学', '道法', '美术', '其他']

function formatElapsed(ms) {
  if (!ms || ms < 0) return ''
  const totalSec = Math.floor(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min === 0) return `${sec} 秒`
  if (sec === 0) return `${min} 分钟`
  return `${min} 分 ${sec} 秒`
}

function decorateTask(task, notebook, dateStr, now) {
  const occ = store.getTaskState(task, notebook, dateStr)
  let elapsedMs = occ.accumulatedMs || 0
  if (occ.status === 'doing' && occ.currentSegmentStartedAt) {
    elapsedMs += Math.max(0, now - occ.currentSegmentStartedAt)
  }
  return {
    ...task,
    subject: task.subject || '其他',
    status: occ.status,
    elapsedMs,
    elapsedDisplay: elapsedMs > 0 ? formatElapsed(elapsedMs) : ''
  }
}

// Sort tasks by subject (preferred order from SUBJECT_ORDER, unknowns last
// in name order), then by their global `order` within each subject. The
// flat list stays usable for drag — sort is stable so adjacency = group.
// Also annotate first-of-group rows so the WXML can render a header.
function arrangeBySubject(list) {
  const subjectRank = (s) => {
    const i = SUBJECT_ORDER.indexOf(s)
    return i < 0 ? SUBJECT_ORDER.length : i
  }
  const sorted = list.slice().sort((a, b) => {
    const ra = subjectRank(a.subject)
    const rb = subjectRank(b.subject)
    if (ra !== rb) return ra - rb
    if (a.subject !== b.subject) return a.subject < b.subject ? -1 : 1
    return (a.order || 0) - (b.order || 0)
  })
  let prev = null
  for (const t of sorted) {
    t.firstOfSubject = t.subject !== prev
    prev = t.subject
  }
  return sorted
}

Page({
  data: {
    notebookId: null,
    notebook: null,
    notebookSummary: '',
    tasks: [],
    dragId: null,
    dragDy: 0,
    // Bound to <page-meta disable-scroll>. WXML can't toggle catch/bind on
    // touchmove dynamically, so we use bindtouchmove (lets ordinary swipes
    // scroll the page) and flip this flag during a drag to suppress scroll.
    disableScroll: false
  },

  onLoad(options) {
    if (options && options.id) this.setData({ notebookId: options.id })
  },

  onShow() {
    this.refreshState()
    this.startTickerIfNeeded()
    cloudSync.hydrateIfStale().then((r) => {
      if (r && r.changed) this.refreshState()
    }).catch(() => {})
    // Warm the openid cache so onShareAppMessage (sync) can embed it.
    shareReward.preloadOpenid().catch(() => {})
  },

  onHide() { this.stopTicker() },
  onUnload() { this.stopTicker() },

  refreshState() {
    const id = this.data.notebookId
    if (!id) return
    const state = store.getStateWithComputed()
    const nb = state.notebooks.find((n) => n.id === id)
    if (!nb) {
      wx.showToast({ title: '作业本不存在', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 600)
      return
    }
    const today = store.todayStr()
    const now = Date.now()
    const list = arrangeBySubject(
      store.tasksOfNotebook(state, id).map((t) => decorateTask(t, nb, today, now))
    )
    wx.setNavigationBarTitle({ title: nb.name })
    this.setData({
      notebook: nb,
      notebookSummary: this.summarize(nb),
      tasks: list
    })
    this.startTickerIfNeeded()
  },

  summarize(nb) {
    if (nb.mode === 'one-shot') {
      const due = nb.endDate || nb.startDate
      return `一次性 · 截止 ${due}`
    }
    const rec = nb.recurrence || { type: 'daily' }
    let recLabel = '每日'
    if (rec.type === 'weekly') {
      const names = ['一', '二', '三', '四', '五', '六', '日']
      recLabel = '每周' + (rec.weekdays || []).slice().sort().map((w) => names[w - 1]).join('、')
    }
    const range = `${nb.startDate} → ${nb.endDate || '长期'}`
    return `重复 · ${recLabel} · ${range}`
  },

  startTickerIfNeeded() {
    this.stopTicker()
    const hasRunning = (this.data.tasks || []).some((t) => t.status === 'doing')
    if (!hasRunning) return
    this.tickerId = setInterval(() => {
      const tasks = (this.data.tasks || []).map((t) => {
        let ms = t.elapsedMs || 0
        if (t.status === 'doing') ms += 1000
        return { ...t, elapsedMs: ms, elapsedDisplay: formatElapsed(ms) }
      })
      this.setData({ tasks })
      if (!tasks.some((t) => t.status === 'doing')) this.stopTicker()
    }, 1000)
  },

  stopTicker() {
    if (this.tickerId) { clearInterval(this.tickerId); this.tickerId = null }
  },

  // === Notebook actions === //

  handleEditNotebook() {
    wx.navigateTo({ url: `/pkg-notebook/notebook-edit/index?id=${this.data.notebookId}` })
  },

  onShareAppMessage() {
    const nb = this.data.notebook
    if (!nb) return { title: '作业本', path: '/pages/tasks/index' }
    const state = store.getStateWithComputed()
    const nickname = ((state.profile && state.profile.nickname) || '').trim() || '好友'
    const title = `${nickname}分享给你的作业：${nb.name}`
    // Embed the notebook + tasks into the share path so the receiver can
    // import it. The receiver's local store doesn't have our notebook id,
    // so a bare ?id=... would just toast "作业本不存在".
    // Read sharer openid from cache (preloaded during onShow); if unset
    // here the share still works, just no reward attribution.
    const myOpenid = shareReward.getMyOpenidSync() || ''
    const payload = store.serializeNotebookForShare(nb.id, myOpenid)
    if (payload) {
      const encoded = encodeURIComponent(JSON.stringify(payload))
      const sharePath = `/pages/notebook-share/index?d=${encoded}`
      // WeChat caps share path length around 1024 chars; if a notebook
      // grew very large, fall back to the local-only path rather than
      // silently producing a broken share link.
      if (sharePath.length <= 1024) {
        return { title, path: sharePath }
      }
    }
    return { title, path: `/pages/notebook-detail/index?id=${nb.id}` }
  },

  handleDeleteNotebook() {
    const nb = this.data.notebook
    if (!nb) return
    wx.showModal({
      title: `删除作业本「${nb.name}」？`,
      content: `本里 ${this.data.tasks.length} 项作业也会一起删除。`,
      confirmColor: '#e54545',
      success: (res) => {
        if (res.confirm) {
          store.deleteNotebook(this.data.notebookId)
          setTimeout(() => wx.navigateBack(), 200)
        }
      }
    })
  },

  // === Task CRUD === //
  // Add/edit moved to /pkg-notebook/notebook-task-edit/. We push that page
  // and rely on onShow → refreshState() to repaint when the user backs out.

  handleAddTask() {
    wx.navigateTo({
      url: `/pkg-notebook/notebook-task-edit/index?notebookId=${this.data.notebookId}`
    })
  },

  handleOcrImport() {
    wx.navigateTo({
      url: `/pages/ocr-import/index?notebookId=${this.data.notebookId}`
    })
  },

  handleEditTask(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({
      url: `/pkg-notebook/notebook-task-edit/index?notebookId=${this.data.notebookId}&taskId=${id}`
    })
  },

  handleDeleteTask(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除作业？',
      confirmColor: '#e54545',
      success: (res) => {
        if (res.confirm) {
          store.deleteTask(id)
          this.refreshState()
        }
      }
    })
  },

  // === Drag-reorder within this notebook === //

  handleTouchStart(e) {
    if (e.touches && e.touches[0]) this.touchStartY = e.touches[0].pageY
  },

  handleLongPress(e) {
    const id = e.currentTarget.dataset.id
    this.dragStartY = this.touchStartY != null
      ? this.touchStartY
      : (e.detail && typeof e.detail.y === 'number' ? e.detail.y : 0)
    if (!this.itemHeightPx) {
      const q = wx.createSelectorQuery()
      q.select('.task-row').boundingClientRect()
      q.exec((rects) => { if (rects && rects[0]) this.itemHeightPx = rects[0].height + 12 })
    }
    this.setData({ dragId: id, dragDy: 0, disableScroll: true })
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })
  },

  // Find the [start, end] index range of the dragged task's subject group
  // within the flat task list (sorted-by-subject = group members are
  // contiguous). Drag is constrained to this range.
  _subjectGroupRange(list, draggedIdx) {
    const subj = list[draggedIdx].subject
    let start = draggedIdx
    while (start > 0 && list[start - 1].subject === subj) start--
    let end = draggedIdx
    while (end < list.length - 1 && list[end + 1].subject === subj) end++
    return [start, end]
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
    const list = this.data.tasks
    const draggedIdx = list.findIndex((task) => task.id === this.data.dragId)
    if (draggedIdx < 0) return
    const [groupStart, groupEnd] = this._subjectGroupRange(list, draggedIdx)
    const slotsDelta = Math.round(dy / itemH)
    const hoverIdx = Math.max(groupStart, Math.min(groupEnd, draggedIdx + slotsDelta))
    const updated = list.map((task, i) => {
      if (task.id === this.data.dragId) return task
      let shiftY = 0
      if (draggedIdx < hoverIdx && i > draggedIdx && i <= hoverIdx) shiftY = -itemH
      else if (draggedIdx > hoverIdx && i >= hoverIdx && i < draggedIdx) shiftY = itemH
      return { ...task, shiftY }
    })
    this.setData({ tasks: updated, dragDy: dy })
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
    const list = this.data.tasks
    const fromIdx = list.findIndex((t) => t.id === dragId)
    if (fromIdx < 0) {
      this.dragStartY = null
      this.touchStartY = null
      this.setData({ dragId: null, dragDy: 0, disableScroll: false })
      return
    }
    const [groupStart, groupEnd] = this._subjectGroupRange(list, fromIdx)
    const slotsDelta = Math.round(dragDy / itemH)
    const toIdx = Math.max(groupStart, Math.min(groupEnd, fromIdx + slotsDelta))
    if (fromIdx !== toIdx) {
      const ids = list.map((t) => t.id)
      const [moved] = ids.splice(fromIdx, 1)
      ids.splice(toIdx, 0, moved)
      store.reorderTasksInNotebook(this.data.notebookId, ids)
      this.refreshState()
    } else {
      this.setData({ tasks: list.map((t) => ({ ...t, shiftY: 0 })) })
    }
    this.dragStartY = null
    this.touchStartY = null
    this.setData({ dragId: null, dragDy: 0, disableScroll: false })
  }
})
