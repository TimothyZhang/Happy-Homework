const store = require('../../utils/store')
const i18n = require('../../utils/i18n')

const SUBJECT_OPTIONS = ['语文', '数学', '英语', '科学', '道法', '美术', '其他']

// 标签列表来源 = store.getOrganizations()(用户在我 Tab 自定义)。
// 编辑模式若 task.organization 不在列表里(用户事后删除了该标签),把它临时
// 加到列表头部,picker 仍能展示当前值。新增模式默认取列表第一项。
function buildOrgPickerOptions(currentValue) {
  const base = store.getOrganizations()
  if (currentValue && !base.includes(currentValue)) {
    return [currentValue].concat(base)
  }
  return base
}

function buildModeOptions() {
  return [
    { key: 'one-shot', label: i18n.t('tedit_mode_oneshot') },
    { key: 'recurring', label: i18n.t('tedit_mode_recurring') }
  ]
}

function buildRecurrenceTypeOptions() {
  return [
    { key: 'daily', label: i18n.t('tedit_recur_daily') },
    { key: 'weekly', label: i18n.t('tedit_recur_weekly') }
  ]
}

function buildWeekdayOptions() {
  return [
    { day: 1, label: i18n.t('tedit_wd_1') },
    { day: 2, label: i18n.t('tedit_wd_2') },
    { day: 3, label: i18n.t('tedit_wd_3') },
    { day: 4, label: i18n.t('tedit_wd_4') },
    { day: 5, label: i18n.t('tedit_wd_5') },
    { day: 6, label: i18n.t('tedit_wd_6') },
    { day: 7, label: i18n.t('tedit_wd_7') }
  ]
}

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
    // 已完成作业才显示:手动修正实际用时(分钟)
    isDoneEdit: false,
    formActualMinutes: '',
    formSubject: '语文',
    formSubjectIndex: 0,
    subjectOptions: SUBJECT_OPTIONS,
    // 新增模式默认第一项(用户可在我 Tab 自定义列表顺序);编辑模式从 task 自身读。
    formOrganization: '',
    formOrganizationIndex: 0,
    organizationOptions: [],
    // 调度
    formMode: 'one-shot',
    modeOptions: [],
    formStartDate: '',
    formEndDate: '',
    formRecurrenceType: 'daily',
    recurrenceTypeOptions: [],
    formRecurrenceTypeIndex: 0,
    formWeekdays: [],     // [1..7]
    weekdayOptions: [],
    // 历史推断
    formEstMinutes: 0,
    formEstHint: '',
    estAutoFilled: false,
    inferredSubject: '',
    showInferHint: false,
    tedit_infer_hint_rendered: '',
    // i18n dict
    t: {}
  },

  onShow() {
    this.setData({
      t: i18n.dict(),
      modeOptions: buildModeOptions(),
      recurrenceTypeOptions: buildRecurrenceTypeOptions(),
      weekdayOptions: buildWeekdayOptions()
    })
  },

  onLoad(options) {
    const opts = options || {}
    const taskId = opts.id || ''
    const instance = opts.instance || ''
    // date 参数:首页 + 入口传过来的当前选中日期(今天/明天/后天/日历选的日子)。
    // 仅新增模式生效;编辑模式从 task 自身读 startDate。
    const seedDate = opts.date || ''
    const today = store.todayStr()

    // Ensure options are built before we setData (onLoad may fire before onShow)
    const modeOptions = buildModeOptions()
    const recurrenceTypeOptions = buildRecurrenceTypeOptions()
    const weekdayOptions = buildWeekdayOptions()

    if (taskId) {
      const state = store.getStateWithComputed()
      const task = state.tasks.find((t) => t.id === taskId)
      if (!task) {
        wx.showToast({ title: i18n.t('tedit_toast_not_found'), icon: 'none' })
        setTimeout(() => wx.navigateBack(), 600)
        return
      }
      const subj = task.subject || '语文'
      const subjIdx = Math.max(0, SUBJECT_OPTIONS.indexOf(subj))
      const orgOptions = buildOrgPickerOptions(task.organization)
      const org = task.organization && orgOptions.indexOf(task.organization) >= 0
        ? task.organization
        : (orgOptions[0] || '校内')
      const orgIdx = Math.max(0, orgOptions.indexOf(org))
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
          organizationOptions: orgOptions,
          // 关键:detach 后是独立 one-shot,所以 mode 锁定 one-shot;
          // 用户改回 recurring 也允许,但会创建一个新 recurring(语义上是"把这次实例
          // 变成另一个 recurring 起点",不常用但合法)。
          formMode: 'one-shot',
          formStartDate: instance,
          formEndDate: instance,
          formRecurrenceType: 'daily',
          formRecurrenceTypeIndex: 0,
          formWeekdays: [],
          modeOptions,
          recurrenceTypeOptions,
          weekdayOptions
        }, () => this.recalcEstimate())
        wx.setNavigationBarTitle({ title: i18n.t('tedit_navtitle_instance', { date: instance }) })
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
        // 一次性作业完成后(status==='done')可手动修正实际用时
        isDoneEdit: task.status === 'done',
        formActualMinutes: task.actualMinutes ? String(task.actualMinutes) : '',
        formContent: task.content || '',
        formMinutes: task.estimatedMinutes ? String(task.estimatedMinutes) : '',
        formSubject: SUBJECT_OPTIONS[subjIdx],
        formSubjectIndex: subjIdx,
        formOrganization: org,
        formOrganizationIndex: orgIdx,
        organizationOptions: orgOptions,
        formMode: mode,
        formStartDate: task.startDate || today,
        formEndDate: task.endDate === null ? '' : (task.endDate || today),
        formRecurrenceType: recurrenceType,
        formRecurrenceTypeIndex: recurrenceType === 'weekly' ? 1 : 0,
        formWeekdays: weekdays,
        modeOptions,
        recurrenceTypeOptions,
        weekdayOptions
      }, () => this.recalcEstimate())
      wx.setNavigationBarTitle({ title: i18n.t('tedit_navtitle_edit') })
      return
    }

    // New mode — 开始日期默认跟随首页选中(seedDate),没有则 today;
    // 重复作业默认结束日期留空 = 长期。
    this._userSelectedSubject = false
    const newOrgOptions = buildOrgPickerOptions('')
    this.setData({
      isEdit: false,
      taskId: '',
      formStartDate: seedDate || today,
      formEndDate: '',
      organizationOptions: newOrgOptions,
      formOrganization: newOrgOptions[0] || '校内',
      formOrganizationIndex: 0,
      modeOptions,
      recurrenceTypeOptions,
      weekdayOptions
    })
    wx.setNavigationBarTitle({ title: i18n.t('tedit_navtitle_new') })
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
      this.setData({ inferredSubject: '', showInferHint: false, tedit_infer_hint_rendered: '' })
      return
    }
    const result = store.inferSubjectByName(content)
    if (!result) {
      this.setData({ inferredSubject: '', showInferHint: false, tedit_infer_hint_rendered: '' })
      return
    }
    const idx = SUBJECT_OPTIONS.indexOf(result.subject)
    if (idx < 0) {
      this.setData({ inferredSubject: '', showInferHint: false, tedit_infer_hint_rendered: '' })
      return
    }
    this.setData({
      formSubject: result.subject,
      formSubjectIndex: idx,
      inferredSubject: result.subject,
      showInferHint: true,
      tedit_infer_hint_rendered: i18n.t('tedit_infer_hint', { subject: result.subject })
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
        formEstHint: canAutoFill
          ? i18n.t('tedit_est_autofilled', { n: est })
          : i18n.t('tedit_est_hint', { n: est })
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

  handleActualMinutesInput(e) {
    this.setData({ formActualMinutes: e.detail.value })
  },

  handleSubjectChange(e) {
    const idx = Number(e.detail.value)
    this._userSelectedSubject = true
    this.setData({
      formSubjectIndex: idx,
      formSubject: SUBJECT_OPTIONS[idx],
      showInferHint: false,
      tedit_infer_hint_rendered: ''
    }, () => this.recalcEstimate())
  },

  handleOrganizationChange(e) {
    const idx = Number(e.detail.value)
    const opts = this.data.organizationOptions || []
    if (idx < 0 || idx >= opts.length) return
    this.setData({
      formOrganizationIndex: idx,
      formOrganization: opts[idx]
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
    const recurrenceTypeOptions = this.data.recurrenceTypeOptions
    this.setData({
      formRecurrenceTypeIndex: idx,
      formRecurrenceType: recurrenceTypeOptions[idx].key
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
      wx.showToast({ title: i18n.t('tedit_toast_no_content'), icon: 'none' })
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
        wx.showToast({ title: i18n.t('tedit_toast_detach_fail'), icon: 'none' })
        return
      }
      // 2) 把表单字段(可能改了日期/内容/分钟)写到新 task
      store.updateTask(newId, payload)
      wx.showToast({ title: i18n.t('tedit_toast_detached'), icon: 'success' })
    } else if (d.isEdit) {
      store.updateTask(d.taskId, payload)
      // 已完成作业:把手动修正的实际用时写回(为空则不动)
      if (d.isDoneEdit && d.formActualMinutes !== '' && Number(d.formActualMinutes) > 0) {
        store.setActualMinutes(d.taskId, '', d.formActualMinutes)
      }
      wx.showToast({ title: i18n.t('tedit_toast_saved'), icon: 'success' })
    } else {
      store.addTask(payload)
      wx.showToast({ title: i18n.t('tedit_toast_added'), icon: 'success' })
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
        title: i18n.t('tedit_del_once_title'),
        content: i18n.t('tedit_del_once_content'),
        confirmColor: i18n.t('tedit_del_confirm_color'),
        success: (res) => {
          if (res.confirm) {
            store.excludeOccurrence(taskId, date)
            wx.showToast({ title: i18n.t('tedit_toast_deleted_once'), icon: 'success' })
            setTimeout(() => wx.navigateBack(), 200)
          }
        }
      })
      return
    }
    if (!this.data.taskId) return
    wx.showModal({
      title: i18n.t('tedit_del_title'),
      content: i18n.t('tedit_del_content'),
      confirmColor: i18n.t('tedit_del_confirm_color'),
      success: (res) => {
        if (res.confirm) {
          store.deleteTask(this.data.taskId)
          wx.showToast({ title: i18n.t('tedit_toast_deleted'), icon: 'success' })
          setTimeout(() => wx.navigateBack(), 200)
        }
      }
    })
  },

  onUnload() {
    if (this._inferTimer) { clearTimeout(this._inferTimer); this._inferTimer = null }
  }
})
