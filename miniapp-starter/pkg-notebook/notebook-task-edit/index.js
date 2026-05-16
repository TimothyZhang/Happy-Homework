const store = require('../../utils/store')

const SUBJECT_OPTIONS = ['语文', '数学', '英语', '科学', '道法', '美术', '其他']
// Wait this long after the last keystroke before re-running infer/estimate.
// Short enough to feel responsive on a typed name, long enough that we don't
// thrash the store walk on every character.
const INFER_DEBOUNCE_MS = 300

Page({
  data: {
    isEdit: false,
    notebookId: null,
    taskId: null,
    notebookName: '',
    formContent: '',
    formMinutes: '',
    formSubject: '语文',
    formSubjectIndex: 0,
    subjectOptions: SUBJECT_OPTIONS,
    // Auto-estimate (existing): suggested minutes from finished history of
    // (content, subject). Same heuristic as before.
    formEstMinutes: 0,
    formEstHint: '',
    // Auto-infer subject (new): when the user hasn't manually chosen a
    // subject yet, we look up history for this content and pre-fill if one
    // subject dominates. The hint chip shows so it's not a surprise.
    inferredSubject: '',
    showInferHint: false,
    // 截止日期(仅多天一次性作业本显示)。空字符串 = 跟随作业本 endDate。
    // dueDateMin/Max 是 picker 范围,跟随作业本起止日期。
    showDueDate: false,
    formDueDate: '',
    dueDateMin: '',
    dueDateMax: '',
    notebookEndDate: ''
  },

  onLoad(options) {
    const opts = options || {}
    const notebookId = opts.notebookId || ''
    const taskId = opts.taskId || ''
    if (!notebookId && !taskId) {
      wx.showToast({ title: '缺少作业本', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 600)
      return
    }
    if (taskId) {
      // Edit mode: hydrate from existing task. Mark subject as user-chosen
      // so the infer pass doesn't override what the user already saved.
      const state = store.getStateWithComputed()
      const task = state.tasks.find((t) => t.id === taskId)
      if (!task) {
        wx.showToast({ title: '作业不存在', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 600)
        return
      }
      const nb = state.notebooks.find((n) => n.id === task.notebookId)
      const subj = task.subject || '语文'
      const subjIdx = Math.max(0, SUBJECT_OPTIONS.indexOf(subj))
      this._userSelectedSubject = true
      this.setData({
        isEdit: true,
        notebookId: task.notebookId,
        taskId,
        notebookName: nb ? nb.name : '',
        formContent: task.content || '',
        formMinutes: task.estimatedMinutes ? String(task.estimatedMinutes) : '',
        formSubject: SUBJECT_OPTIONS[subjIdx],
        formSubjectIndex: subjIdx,
        ...this.computeDueDateFields(nb, task.dueDate || '')
      }, () => this.recalcEstimate())
      wx.setNavigationBarTitle({ title: '编辑作业' })
      return
    }
    // New mode.
    const nb = store.getNotebookById(notebookId)
    if (!nb) {
      wx.showToast({ title: '作业本不存在', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 600)
      return
    }
    this._userSelectedSubject = false
    this.setData({
      isEdit: false,
      notebookId,
      taskId: '',
      notebookName: nb.name,
      ...this.computeDueDateFields(nb, '')
    })
    wx.setNavigationBarTitle({ title: '新增作业' })
  },

  // 只在「多天的一次性作业本」里展示截止日期 picker。单天本只有一个日期,设了
  // 也没意义;周期性作业本截止概念在 occurrence 层,跟 task.dueDate 不冲突。
  computeDueDateFields(nb, currentDueDate) {
    if (!nb || nb.mode !== 'one-shot') {
      return { showDueDate: false, formDueDate: '', dueDateMin: '', dueDateMax: '', notebookEndDate: '' }
    }
    const start = nb.startDate
    const end = nb.endDate || nb.startDate
    if (!start || !end || start === end) {
      return { showDueDate: false, formDueDate: '', dueDateMin: '', dueDateMax: '', notebookEndDate: end || '' }
    }
    return {
      showDueDate: true,
      formDueDate: currentDueDate || '',
      dueDateMin: start,
      dueDateMax: end,
      notebookEndDate: end
    }
  },

  // Debounced re-evaluation triggered on content / subject change.
  scheduleInferAndEstimate() {
    if (this._inferTimer) { clearTimeout(this._inferTimer); this._inferTimer = null }
    this._inferTimer = setTimeout(() => {
      this._inferTimer = null
      this.maybeInferSubject()
      this.recalcEstimate()
    }, INFER_DEBOUNCE_MS)
  },

  // Only fires when the user hasn't picked a subject yet (otherwise their
  // choice would silently get overwritten). Fills the picker AND surfaces
  // the "根据历史推断" hint so the change isn't invisible.
  maybeInferSubject() {
    if (this._userSelectedSubject) return
    const content = (this.data.formContent || '').trim()
    if (!content) {
      this.setData({ inferredSubject: '', showInferHint: false })
      return
    }
    const result = store.inferSubjectByName(content)
    if (!result) {
      this.setData({ inferredSubject: '', showInferHint: false })
      return
    }
    const idx = SUBJECT_OPTIONS.indexOf(result.subject)
    if (idx < 0) {
      this.setData({ inferredSubject: '', showInferHint: false })
      return
    }
    this.setData({
      formSubject: result.subject,
      formSubjectIndex: idx,
      inferredSubject: result.subject,
      showInferHint: true
    })
  },

  recalcEstimate() {
    const content = (this.data.formContent || '').trim()
    if (!content) {
      this.setData({ formEstHint: '', formEstMinutes: 0 })
      return
    }
    const est = store.estimateTaskMinutes(content, this.data.formSubject || '')
    if (est) {
      this.setData({ formEstMinutes: est, formEstHint: `预估 ${est} 分钟（基于历史，点这里使用）` })
    } else {
      this.setData({ formEstMinutes: 0, formEstHint: '' })
    }
  },

  handleContentInput(e) {
    this.setData({ formContent: e.detail.value })
    this.scheduleInferAndEstimate()
  },

  handleMinutesInput(e) {
    this.setData({ formMinutes: e.detail.value })
  },

  handleSubjectChange(e) {
    const idx = Number(e.detail.value)
    // Manual pick — never overwrite from infer again on this page session.
    this._userSelectedSubject = true
    this.setData({
      formSubjectIndex: idx,
      formSubject: SUBJECT_OPTIONS[idx],
      // Hide the "根据历史推断" chip once the user has taken control.
      showInferHint: false
    }, () => this.recalcEstimate())
  },

  handleAcceptEstimate() {
    if (this.data.formEstMinutes) {
      this.setData({ formMinutes: String(this.data.formEstMinutes) })
    }
  },

  handleDueDateChange(e) {
    this.setData({ formDueDate: e.detail.value })
  },

  handleClearDueDate() {
    this.setData({ formDueDate: '' })
  },

  handleSave() {
    const { formContent, formMinutes, formSubject, formDueDate, showDueDate, isEdit, taskId, notebookId } = this.data
    if (!formContent || !formContent.trim()) {
      wx.showToast({ title: '请填作业内容', icon: 'none' })
      return
    }
    const payload = {
      content: formContent.trim(),
      // Minutes is optional — addTask coerces blanks to 0.
      estimatedMinutes: formMinutes ? Number(formMinutes) : 0,
      subject: formSubject
    }
    // Only attach dueDate when the picker is shown (= 多天一次性作业本).
    // 空字符串 → null,作业本默认按 endDate 落到最后一天 folder。
    if (showDueDate) {
      payload.dueDate = formDueDate || null
    }
    if (isEdit) {
      store.updateTask(taskId, payload)
      wx.showToast({ title: '已保存', icon: 'success' })
    } else {
      store.addTask({ ...payload, notebookId })
      wx.showToast({ title: '已添加', icon: 'success' })
    }
    setTimeout(() => wx.navigateBack(), 200)
  },

  onUnload() {
    if (this._inferTimer) { clearTimeout(this._inferTimer); this._inferTimer = null }
  }
})
