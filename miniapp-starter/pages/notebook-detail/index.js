const store = require('../../utils/store')

const SUBJECT_OPTIONS = ['语文', '数学', '英语', '科学', '道法', '美术', '其他']

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
    subject: task.subject || '',
    status: occ.status,
    elapsedMs,
    elapsedDisplay: elapsedMs > 0 ? formatElapsed(elapsedMs) : ''
  }
}

Page({
  data: {
    notebookId: null,
    notebook: null,
    notebookSummary: '',
    tasks: [],
    activeDate: '',
    activeDateLabel: '',
    activeOnDate: false,
    showForm: false,
    editingId: null,
    formContent: '',
    formMinutes: '',
    formSubject: '语文',
    formSubjectIndex: 0,
    subjectOptions: SUBJECT_OPTIONS,
    dragId: null,
    dragDy: 0
  },

  onLoad(options) {
    if (options && options.id) this.setData({ notebookId: options.id })
  },

  onShow() {
    this.refreshState()
    this.startTickerIfNeeded()
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
    const activeDate = this.data.activeDate || today
    const activeOnDate = store.isNotebookActiveOn(nb, activeDate)
    const now = Date.now()
    const list = store.tasksOfNotebook(state, id).map((t) => decorateTask(t, nb, activeDate, now))
    wx.setNavigationBarTitle({ title: nb.name })
    this.setData({
      notebook: nb,
      notebookSummary: this.summarize(nb),
      tasks: list,
      activeDate,
      activeDateLabel: this.formatDateLabel(activeDate, today),
      activeOnDate
    })
    this.startTickerIfNeeded()
  },

  formatDateLabel(date, today) {
    if (date === today) return `今日 · ${date}`
    if (date === store.addDays(today, -1)) return `昨日 · ${date}`
    if (date === store.addDays(today, 1)) return `明日 · ${date}`
    return date
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
      const now = Date.now()
      const tasks = (this.data.tasks || []).map((t) => {
        let ms = t.elapsedMs || 0
        if (t.status === 'doing') ms += 1000
        return { ...t, elapsedMs: ms, elapsedDisplay: formatElapsed(ms) }
      })
      this.setData({ tasks })
    }, 1000)
  },

  stopTicker() {
    if (this.tickerId) { clearInterval(this.tickerId); this.tickerId = null }
  },

  // === Date switcher === //

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

  handlePickDate(e) {
    this.setData({ activeDate: e.detail.value })
    this.refreshState()
  },

  // === Task control === //

  handleStart(e) {
    store.startTask(e.currentTarget.dataset.id, this.data.activeDate)
    this.refreshState()
  },

  handlePause(e) {
    store.pauseTask(e.currentTarget.dataset.id, this.data.activeDate)
    this.refreshState()
  },

  handleResume(e) {
    store.resumeTask(e.currentTarget.dataset.id, this.data.activeDate)
    this.refreshState()
  },

  handleFinish(e) {
    store.finishTask(e.currentTarget.dataset.id, this.data.activeDate)
    this.refreshState()
  },

  // === Task CRUD === //

  handleShowAdd() {
    this.setData({
      showForm: true,
      editingId: null,
      formContent: '',
      formMinutes: '',
      formSubject: '语文',
      formSubjectIndex: 0
    })
  },

  handleEditTask(e) {
    const id = e.currentTarget.dataset.id
    const task = this.data.tasks.find((t) => t.id === id)
    if (!task) return
    const subj = task.subject || '语文'
    const subjIdx = Math.max(0, SUBJECT_OPTIONS.indexOf(subj))
    this.setData({
      showForm: true,
      editingId: id,
      formContent: task.content,
      formMinutes: String(task.estimatedMinutes || ''),
      formSubject: SUBJECT_OPTIONS[subjIdx],
      formSubjectIndex: subjIdx
    })
  },

  handleHideForm() {
    this.setData({ showForm: false, editingId: null })
  },

  handleContentInput(e) { this.setData({ formContent: e.detail.value }) },
  handleMinutesInput(e) { this.setData({ formMinutes: e.detail.value }) },
  handleSubjectChange(e) {
    const idx = Number(e.detail.value)
    this.setData({ formSubjectIndex: idx, formSubject: SUBJECT_OPTIONS[idx] })
  },

  handleSaveTask() {
    const { formContent, formMinutes, formSubject, editingId, notebookId } = this.data
    if (!formContent || !formMinutes) {
      wx.showToast({ title: '请补全内容和时长', icon: 'none' })
      return
    }
    const payload = {
      content: formContent.trim(),
      estimatedMinutes: Number(formMinutes),
      subject: formSubject
    }
    if (editingId) {
      store.updateTask(editingId, payload)
    } else {
      store.addTask({ ...payload, notebookId })
    }
    this.setData({ showForm: false, editingId: null })
    this.refreshState()
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
    const list = this.data.tasks
    const draggedIdx = list.findIndex((task) => task.id === this.data.dragId)
    const slotsDelta = Math.round(dy / itemH)
    const hoverIdx = Math.max(0, Math.min(list.length - 1, draggedIdx + slotsDelta))
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
    const slotsDelta = Math.round(dragDy / itemH)
    const toIdx = Math.max(0, Math.min(list.length - 1, fromIdx + slotsDelta))
    if (fromIdx !== -1 && fromIdx !== toIdx) {
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
    this.setData({ dragId: null, dragDy: 0 })
  }
})
