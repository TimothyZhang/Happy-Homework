const store = require('../../utils/store')

const SUBJECT_OPTIONS = ['语文', '数学', '英语', '科学', '道法', '美术', '其他']
const ORGANIZATION_OPTIONS = ['校内', '校外', '其他']
const MODE_OPTIONS = [
  { key: 'one-shot', label: '一次性' },
  { key: 'recurring', label: '重复' }
]
const RECURRENCE_TYPE_OPTIONS = [
  { key: 'daily', label: '每日' },
  { key: 'weekly', label: '每周' }
]
const WEEKDAYS = [
  { day: 1, label: '一' },
  { day: 2, label: '二' },
  { day: 3, label: '三' },
  { day: 4, label: '四' },
  { day: 5, label: '五' },
  { day: 6, label: '六' },
  { day: 7, label: '日' }
]
const INFER_DEBOUNCE_MS = 300

Page({
  data: {
    isEdit: false,
    // 飞书日程式 "编辑此次" 模式:从 recurring task 的某一日 occurrence 进来,
    // 保存时先 detachOccurrence 拆出独立 one-shot task,再 updateTask 应用表单。
    // 取消则不 detach,原 recurring 完全不动。
    isInstanceDetach: false,
    originalTaskId: '',
    instanceDate: '',
    taskId: '',
    // 基本信息
    formContent: '',
    formMinutes: '',
    formSubject: '语文',
    formSubjectIndex: 0,
    subjectOptions: SUBJECT_OPTIONS,
    // 新增模式默认"校内"(Tim 大部分作业是学校布置的);编辑模式从 task 自身读。
    formOrganization: '校内',
    formOrganizationIndex: 0,
    organizationOptions: ORGANIZATION_OPTIONS,
    // 调度
    formMode: 'one-shot',
    modeOptions: MODE_OPTIONS,
    formStartDate: '',
    formEndDate: '',
    formRecurrenceType: 'daily',
    recurrenceTypeOptions: RECURRENCE_TYPE_OPTIONS,
    formRecurrenceTypeIndex: 0,
    formWeekdays: [],     // [1..7]
    weekdayOptions: WEEKDAYS,
    // 历史推断
    formEstMinutes: 0,
    formEstHint: '',
    estAutoFilled: false,
    inferredSubject: '',
    showInferHint: false
  },

  onLoad(options) {
    const opts = options || {}
    const taskId = opts.id || ''
    const instance = opts.instance || ''
    // date 参数:首页 + 入口传过来的当前选中日期(今天/明天/后天/日历选的日子)。
    // 仅新增模式生效;编辑模式从 task 自身读 startDate。
    const seedDate = opts.date || ''
    const today = store.todayStr()

    if (taskId) {
      const state = store.getStateWithComputed()
      const task = state.tasks.find((t) => t.id === taskId)
      if (!task) {
        wx.showToast({ title: '作业不存在', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 600)
        return
      }
      const subj = task.subject || '语文'
      const subjIdx = Math.max(0, SUBJECT_OPTIONS.indexOf(subj))
      const org = ORGANIZATION_OPTIONS.includes(task.organization) ? task.organization : '其他'
      const orgIdx = ORGANIZATION_OPTIONS.indexOf(org)
      this._userSelectedSubject = true

      // 编辑此次:从 recurring 的某天 instance 进来。表单强制 one-shot,
      // 日期锚到 instance。保存时 store.detachOccurrence 拆出独立 task,
      // 再 updateTask 把表单字段(包括可能的日期改动)应用到新 task。
      if (instance && task.mode === 'recurring') {
        this.setData({
          isEdit: true,
          isInstanceDetach: true,
          originalTaskId: taskId,
          instanceDate: instance,
          taskId: '',  // 这一刻还没新 task,留空
          formContent: task.content || '',
          formMinutes: task.estimatedMinutes ? String(task.estimatedMinutes) : '',
          formSubject: SUBJECT_OPTIONS[subjIdx],
          formSubjectIndex: subjIdx,
          formOrganization: org,
          formOrganizationIndex: orgIdx,
          // 关键:detach 后是独立 one-shot,所以 mode 锁定 one-shot;
          // 用户改回 recurring 也允许,但会创建一个新 recurring(语义上是"把这次实例
          // 变成另一个 recurring 起点",不常用但合法)。
          formMode: 'one-shot',
          formStartDate: instance,
          formEndDate: instance,
          formRecurrenceType: 'daily',
          formRecurrenceTypeIndex: 0,
          formWeekdays: []
        }, () => this.recalcEstimate())
        wx.setNavigationBarTitle({ title: `编辑此次 (${instance})` })
        return
      }

      // 整个作业编辑:沿用原 task 完整字段。
      const mode = task.mode === 'recurring' ? 'recurring' : 'one-shot'
      const recurrenceType = task.recurrence && task.recurrence.type === 'weekly' ? 'weekly' : 'daily'
      const weekdays = task.recurrence && Array.isArray(task.recurrence.weekdays)
        ? task.recurrence.weekdays.slice()
        : []
      this.setData({
        isEdit: true,
        taskId,
        formContent: task.content || '',
        formMinutes: task.estimatedMinutes ? String(task.estimatedMinutes) : '',
        formSubject: SUBJECT_OPTIONS[subjIdx],
        formSubjectIndex: subjIdx,
        formOrganization: org,
        formOrganizationIndex: orgIdx,
        formMode: mode,
        formStartDate: task.startDate || today,
        formEndDate: task.endDate === null ? '' : (task.endDate || today),
        formRecurrenceType: recurrenceType,
        formRecurrenceTypeIndex: recurrenceType === 'weekly' ? 1 : 0,
        formWeekdays: weekdays
      }, () => this.recalcEstimate())
      wx.setNavigationBarTitle({ title: '编辑作业' })
      return
    }

    // New mode — 开始日期默认跟随首页选中(seedDate),没有则 today;
    // 重复作业默认结束日期留空 = 长期。
    this._userSelectedSubject = false
    this.setData({
      isEdit: false,
      taskId: '',
      formStartDate: seedDate || today,
      formEndDate: ''
    })
    wx.setNavigationBarTitle({ title: '新增作业' })
  },

  scheduleInferAndEstimate() {
    if (this._inferTimer) { clearTimeout(this._inferTimer); this._inferTimer = null }
    this._inferTimer = setTimeout(() => {
      this._inferTimer = null
      this.maybeInferSubject()
      this.recalcEstimate()
    }, INFER_DEBOUNCE_MS)
  },

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
    const canAutoFill = !this.data.formMinutes || this.data.estAutoFilled
    if (!content) {
      const updates = { formEstHint: '', formEstMinutes: 0 }
      if (canAutoFill && this.data.formMinutes) {
        updates.formMinutes = ''
        updates.estAutoFilled = false
      }
      this.setData(updates)
      return
    }
    const est = store.estimateTaskMinutes(content, this.data.formSubject || '')
    if (est) {
      const updates = {
        formEstMinutes: est,
        formEstHint: canAutoFill ? `已按历史预估 ${est} 分钟，可改` : `历史预估约 ${est} 分钟`
      }
      if (canAutoFill) {
        updates.formMinutes = String(est)
        updates.estAutoFilled = true
      }
      this.setData(updates)
    } else {
      const updates = { formEstMinutes: 0, formEstHint: '' }
      if (canAutoFill && this.data.formMinutes) {
        updates.formMinutes = ''
        updates.estAutoFilled = false
      }
      this.setData(updates)
    }
  },

  handleContentInput(e) {
    this.setData({ formContent: e.detail.value })
    this.scheduleInferAndEstimate()
  },

  handleMinutesInput(e) {
    this.setData({ formMinutes: e.detail.value, estAutoFilled: false })
  },

  handleSubjectChange(e) {
    const idx = Number(e.detail.value)
    this._userSelectedSubject = true
    this.setData({
      formSubjectIndex: idx,
      formSubject: SUBJECT_OPTIONS[idx],
      showInferHint: false
    }, () => this.recalcEstimate())
  },

  handleOrganizationChange(e) {
    const idx = Number(e.detail.value)
    this.setData({
      formOrganizationIndex: idx,
      formOrganization: ORGANIZATION_OPTIONS[idx]
    })
  },

  handleModeChange(e) {
    // 编辑此次模式下,类型锁定在 one-shot — detach 出的实例本质就是独立 one-shot,
    // 不允许重新选回 recurring(语义混乱)。UI 也加了 .locked 样式。
    if (this.data.isInstanceDetach) return
    const key = e.currentTarget.dataset.key
    if (!key) return
    this.setData({ formMode: key })
  },

  handleRecurrenceTypeChange(e) {
    const idx = Number(e.detail.value)
    this.setData({
      formRecurrenceTypeIndex: idx,
      formRecurrenceType: RECURRENCE_TYPE_OPTIONS[idx].key
    })
  },

  handleToggleWeekday(e) {
    const day = Number(e.currentTarget.dataset.day)
    if (!day) return
    const cur = this.data.formWeekdays.slice()
    const i = cur.indexOf(day)
    if (i >= 0) cur.splice(i, 1)
    else cur.push(day)
    cur.sort((a, b) => a - b)
    this.setData({ formWeekdays: cur })
  },

  handleStartDateChange(e) {
    const v = e.detail.value
    const next = { formStartDate: v }
    // 一次性时,endDate 默认跟随 startDate(可以再独立改)
    if (this.data.formMode === 'one-shot' && (!this.data.formEndDate || this.data.formEndDate < v)) {
      next.formEndDate = v
    }
    this.setData(next)
  },

  handleEndDateChange(e) {
    this.setData({ formEndDate: e.detail.value })
  },

  handleClearEndDate() {
    this.setData({ formEndDate: '' })
  },

  handleAcceptEstimate() {
    if (this.data.formEstMinutes) {
      this.setData({ formMinutes: String(this.data.formEstMinutes), estAutoFilled: true })
    }
  },

  handleSwitchToOcr() {
    // 用 redirectTo 替换页面栈,这样视觉上像是 tab 切换(而非 navigateTo 叠栈)。
    wx.redirectTo({ url: '/pages/ocr-import/index' })
  },

  handleSave() {
    const d = this.data
    if (!d.formContent || !d.formContent.trim()) {
      wx.showToast({ title: '请填作业内容', icon: 'none' })
      return
    }
    const payload = {
      content: d.formContent.trim(),
      estimatedMinutes: d.formMinutes ? Number(d.formMinutes) : 0,
      subject: d.formSubject,
      organization: d.formOrganization,
      mode: d.formMode,
      startDate: d.formStartDate || store.todayStr(),
      endDate: d.formMode === 'recurring'
        ? (d.formEndDate || null)
        : (d.formEndDate || d.formStartDate || store.todayStr()),
      recurrence: d.formMode === 'recurring'
        ? { type: d.formRecurrenceType, weekdays: d.formWeekdays.slice() }
        : null
    }
    if (d.isInstanceDetach) {
      // 1) detach 原 recurring 在 instanceDate 的实例,拿到新 task id
      const newId = store.detachOccurrence(d.originalTaskId, d.instanceDate)
      if (!newId) {
        wx.showToast({ title: '拆分失败', icon: 'none' })
        return
      }
      // 2) 把表单字段(可能改了日期/内容/分钟)写到新 task
      store.updateTask(newId, payload)
      wx.showToast({ title: '已拆出独立作业', icon: 'success' })
    } else if (d.isEdit) {
      store.updateTask(d.taskId, payload)
      wx.showToast({ title: '已保存', icon: 'success' })
    } else {
      store.addTask(payload)
      wx.showToast({ title: '已添加', icon: 'success' })
    }
    setTimeout(() => wx.navigateBack(), 200)
  },

  handleDelete() {
    if (!this.data.isEdit) return
    // "编辑此次"模式:只删该天的 occurrence,原 recurring 不动。
    if (this.data.isInstanceDetach) {
      const taskId = this.data.originalTaskId
      const date = this.data.instanceDate
      if (!taskId || !date) return
      wx.showModal({
        title: '删除此次?',
        content: '只删除当天这次,后续日期照常出现。',
        confirmColor: '#e54545',
        success: (res) => {
          if (res.confirm) {
            store.excludeOccurrence(taskId, date)
            wx.showToast({ title: '已删除此次', icon: 'success' })
            setTimeout(() => wx.navigateBack(), 200)
          }
        }
      })
      return
    }
    if (!this.data.taskId) return
    wx.showModal({
      title: '删除这条作业?',
      content: '历史完成记录保留,但以后不再出现。',
      confirmColor: '#e54545',
      success: (res) => {
        if (res.confirm) {
          store.deleteTask(this.data.taskId)
          wx.showToast({ title: '已删除', icon: 'success' })
          setTimeout(() => wx.navigateBack(), 200)
        }
      }
    })
  },

  onUnload() {
    if (this._inferTimer) { clearTimeout(this._inferTimer); this._inferTimer = null }
  }
})
