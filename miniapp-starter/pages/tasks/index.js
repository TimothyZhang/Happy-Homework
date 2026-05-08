const store = require('../../utils/store')

const DEFAULT_FORM = {
  subject: '语文',
  content: '',
  estimatedMinutes: ''
}

const PRIMARY_SUBJECTS = ['语文', '数学', '英语']

function groupTasksBySubject(tasks) {
  const buckets = new Map()
  for (const subject of PRIMARY_SUBJECTS) buckets.set(subject, [])
  buckets.set('其他', [])
  for (const task of tasks) {
    const key = PRIMARY_SUBJECTS.includes(task.subject) ? task.subject : '其他'
    buckets.get(key).push(task)
  }
  const groups = []
  for (const [subject, items] of buckets) {
    if (items.length === 0) continue
    groups.push({ subject, tasks: items })
  }
  return groups
}

function buildShareText(groups) {
  if (!groups || groups.length === 0) return '今日还没有作业'
  const lines = ['📚 今日作业']
  for (const group of groups) {
    lines.push('')
    lines.push(`【${group.subject}】`)
    group.tasks.forEach((task, i) => {
      lines.push(`${i + 1}. ${task.content}`)
    })
  }
  return lines.join('\n')
}

Page({
  data: {
    tasks: [],
    groupedTasks: [],
    doneCount: 0,
    editingId: null,
    formVisible: false,
    dragId: null,
    dragDy: 0,
    subjectOptions: ['语文', '数学', '英语', '科学', '道法', '其他'],
    form: { ...DEFAULT_FORM }
  },

  onShow() {
    this.refreshState()
  },

  refreshState() {
    const state = store.getStateWithComputed()
    const editingTask = state.tasks.find((task) => task.id === state.editTaskId)
    this.setData({
      tasks: state.tasks,
      groupedTasks: groupTasksBySubject(state.tasks),
      doneCount: state.tasks.filter((task) => task.status === 'done').length,
      editingId: state.editTaskId,
      form: editingTask
        ? {
            subject: editingTask.subject,
            content: editingTask.content,
            estimatedMinutes: String(editingTask.estimatedMinutes)
          }
        : { ...DEFAULT_FORM }
    })
  },

  handleSubjectChange(event) {
    const subject = this.data.subjectOptions[event.detail.value]
    this.setData({ 'form.subject': subject })
  },

  handleContentInput(event) {
    this.setData({ 'form.content': event.detail.value })
  },

  handleMinutesInput(event) {
    this.setData({ 'form.estimatedMinutes': event.detail.value })
  },

  handleShowAdd() {
    if (this.data.editingId) store.clearEditTaskId()
    this.setData({
      formVisible: true,
      editingId: null,
      form: { ...DEFAULT_FORM }
    })
    setTimeout(() => wx.pageScrollTo({ scrollTop: 9999, duration: 200 }), 80)
  },

  handleHideForm() {
    if (this.data.editingId) store.clearEditTaskId()
    this.setData({ formVisible: false, editingId: null })
  },

  handleSaveTask() {
    const { form, editingId } = this.data
    if (!form.content || !form.estimatedMinutes) {
      wx.showToast({ title: '请先补全内容和时长', icon: 'none' })
      return
    }
    const payload = {
      subject: form.subject,
      content: form.content,
      estimatedMinutes: Number(form.estimatedMinutes)
    }
    if (editingId) {
      store.updateTask(editingId, payload)
      store.clearEditTaskId()
      this.setData({ formVisible: false, editingId: null })
      this.refreshState()
      wx.showToast({ title: '已更新', icon: 'success' })
      return
    }
    store.addTask(payload)
    this.setData({ formVisible: false })
    this.refreshState()
    wx.showToast({ title: '已新增', icon: 'success' })
  },

  handleEditTask(event) {
    const { id } = event.currentTarget.dataset
    store.setEditTaskId(id)
    this.setData({ formVisible: true })
    this.refreshState()
    setTimeout(() => wx.pageScrollTo({ scrollTop: 9999, duration: 200 }), 80)
  },

  handleDeleteTask(event) {
    const { id } = event.currentTarget.dataset
    wx.showModal({
      title: '删除作业',
      content: '删掉后就不会出现在今天排期里了。',
      success: (res) => {
        if (res.confirm) {
          store.deleteTask(id)
          if (this.data.editingId === id) {
            store.clearEditTaskId()
            this.setData({ formVisible: false, editingId: null })
          }
          this.refreshState()
          wx.showToast({ title: '已删除', icon: 'success' })
        }
      }
    })
  },

  // === 分享 === //

  handleCopyToClipboard() {
    const text = buildShareText(this.data.groupedTasks)
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制，可去微信粘贴', icon: 'success', duration: 2000 })
    })
  },

  // 微信右上角「转发」+ open-type=share 都会触发这里
  onShareAppMessage() {
    const total = this.data.tasks.length
    const title = total > 0 ? `今日有 ${total} 项作业` : '今日作业'
    return {
      title,
      path: '/pages/tasks/index'
    }
  },

  // === 拖拽排序(同科目内) === //

  handleLongPress(event) {
    const { id, subject } = event.currentTarget.dataset
    if (event.touches && event.touches[0]) {
      this.dragStartY = event.touches[0].pageY
    }
    this.dragSubject = subject
    if (!this.itemHeightPx) {
      const query = wx.createSelectorQuery()
      query.select('.mgmt-task').boundingClientRect()
      query.exec((rects) => {
        if (rects && rects[0]) {
          this.itemHeightPx = rects[0].height + 10
        }
      })
    }
    this.setData({ dragId: id, dragDy: 0 })
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })
  },

  handleTouchMove(event) {
    if (!this.data.dragId || !this.dragStartY) return
    const now = Date.now()
    if (this._lastMoveAt && now - this._lastMoveAt < 16) return
    this._lastMoveAt = now
    const t = event.touches && event.touches[0]
    if (!t) return
    const dy = t.pageY - this.dragStartY
    if (Math.abs(dy - this.data.dragDy) < 2) return

    const itemH = this.itemHeightPx || 140
    const slotsDelta = Math.round(dy / itemH)
    const subject = this.dragSubject
    // 只在拖拽来源 group 内挪卡片让位;其它 group 完全不动
    const updatedGroups = this.data.groupedTasks.map((g) => {
      if (g.subject !== subject) return g
      const draggedIdx = g.tasks.findIndex((task) => task.id === this.data.dragId)
      const hoverIdx = Math.max(0, Math.min(g.tasks.length - 1, draggedIdx + slotsDelta))
      const tasks = g.tasks.map((task, i) => {
        if (task.id === this.data.dragId) return task
        let shiftY = 0
        if (draggedIdx < hoverIdx && i > draggedIdx && i <= hoverIdx) {
          shiftY = -itemH
        } else if (draggedIdx > hoverIdx && i >= hoverIdx && i < draggedIdx) {
          shiftY = itemH
        }
        return { ...task, shiftY }
      })
      return { ...g, tasks }
    })
    this.setData({ groupedTasks: updatedGroups, dragDy: dy })
  },

  handleTouchEnd() {
    if (!this.data.dragId) {
      this.dragStartY = null
      return
    }
    const dragId = this.data.dragId
    const dragDy = this.data.dragDy
    const itemH = this.itemHeightPx || 140
    const slotsDelta = Math.round(dragDy / itemH)
    const subject = this.dragSubject

    let didReorder = false
    const group = this.data.groupedTasks.find((g) => g.subject === subject)
    if (group && slotsDelta !== 0) {
      const fromIdx = group.tasks.findIndex((t) => t.id === dragId)
      const toIdx = Math.max(0, Math.min(group.tasks.length - 1, fromIdx + slotsDelta))
      if (fromIdx !== -1 && fromIdx !== toIdx) {
        const newGroupTasks = [...group.tasks]
        const [moved] = newGroupTasks.splice(fromIdx, 1)
        newGroupTasks.splice(toIdx, 0, moved)
        const flatIds = []
        for (const g of this.data.groupedTasks) {
          if (g.subject === subject) {
            for (const t of newGroupTasks) flatIds.push(t.id)
          } else {
            for (const t of g.tasks) flatIds.push(t.id)
          }
        }
        store.reorderTasks(flatIds)
        this.refreshState()
        didReorder = true
      }
    }

    if (!didReorder) {
      // 没换槽 —— 把所有 shiftY 清掉,卡片平滑归位
      const reset = this.data.groupedTasks.map((g) => ({
        ...g,
        tasks: g.tasks.map((t) => ({ ...t, shiftY: 0 }))
      }))
      this.setData({ groupedTasks: reset })
    }

    this.dragStartY = null
    this.dragSubject = null
    this.setData({ dragId: null, dragDy: 0 })
  }
})
