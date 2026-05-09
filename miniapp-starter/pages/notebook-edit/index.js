const store = require('../../utils/store')

const SUBJECT_OPTIONS = ['语文', '数学', '英语', '科学', '道法', '美术', '其他']
const MODE_OPTIONS = [
  { key: 'one-shot', label: '一次性' },
  { key: 'recurring', label: '重复' }
]
const RECUR_TYPE_OPTIONS = [
  { key: 'daily', label: '每日' },
  { key: 'weekly', label: '每周' }
]
const WEEKDAYS = [
  { value: 1, label: '一' },
  { value: 2, label: '二' },
  { value: 3, label: '三' },
  { value: 4, label: '四' },
  { value: 5, label: '五' },
  { value: 6, label: '六' },
  { value: 7, label: '日' }
]

Page({
  data: {
    isEdit: false,
    notebookId: null,
    name: '',
    subject: '语文',
    subjectIndex: 0,
    subjectOptions: SUBJECT_OPTIONS,
    mode: 'one-shot',
    modeOptions: MODE_OPTIONS,
    startDate: '',
    endDate: '',
    recurType: 'daily',
    recurTypeOptions: RECUR_TYPE_OPTIONS,
    recurWeekdays: [],
    weekdays: WEEKDAYS,
    openEnded: false
  },

  onLoad(options) {
    const today = store.todayStr()
    if (options && options.id) {
      const nb = store.getNotebookById(options.id)
      if (nb) {
        const subjIdx = Math.max(0, SUBJECT_OPTIONS.indexOf(nb.subject))
        this.setData({
          isEdit: true,
          notebookId: nb.id,
          name: nb.name,
          subject: SUBJECT_OPTIONS[subjIdx],
          subjectIndex: subjIdx,
          mode: nb.mode || 'one-shot',
          startDate: nb.startDate || today,
          endDate: nb.endDate || (nb.mode === 'recurring' ? '' : today),
          recurType: nb.recurrence ? nb.recurrence.type : 'daily',
          recurWeekdays: nb.recurrence ? (nb.recurrence.weekdays || []) : [],
          openEnded: nb.mode === 'recurring' && !nb.endDate
        })
        wx.setNavigationBarTitle({ title: '编辑作业本' })
        return
      }
    }
    this.setData({
      startDate: today,
      endDate: today
    })
    wx.setNavigationBarTitle({ title: '新建作业本' })
  },

  handleNameInput(e) {
    this.setData({ name: e.detail.value })
  },

  handleSubjectChange(e) {
    const idx = Number(e.detail.value)
    this.setData({ subjectIndex: idx, subject: SUBJECT_OPTIONS[idx] })
  },

  handleModeChange(e) {
    const mode = e.currentTarget.dataset.mode
    const today = store.todayStr()
    if (mode === 'recurring') {
      this.setData({
        mode,
        endDate: this.data.openEnded ? '' : (this.data.endDate || ''),
        openEnded: this.data.openEnded
      })
    } else {
      this.setData({
        mode,
        endDate: this.data.endDate || this.data.startDate || today,
        openEnded: false
      })
    }
  },

  handleStartDateChange(e) {
    const startDate = e.detail.value
    let endDate = this.data.endDate
    if (this.data.mode === 'one-shot' && endDate && endDate < startDate) {
      endDate = startDate
    }
    this.setData({ startDate, endDate })
  },

  handleEndDateChange(e) {
    this.setData({ endDate: e.detail.value })
  },

  handleRecurTypeChange(e) {
    const recurType = e.currentTarget.dataset.type
    this.setData({ recurType })
  },

  handleToggleWeekday(e) {
    const value = Number(e.currentTarget.dataset.value)
    const wds = [...this.data.recurWeekdays]
    const idx = wds.indexOf(value)
    if (idx >= 0) wds.splice(idx, 1)
    else wds.push(value)
    this.setData({ recurWeekdays: wds })
  },

  handleToggleOpenEnded(e) {
    const openEnded = e.detail.value
    this.setData({
      openEnded,
      endDate: openEnded ? '' : (this.data.endDate || this.data.startDate)
    })
  },

  handleSave() {
    const { name, subject, mode, startDate, endDate, recurType, recurWeekdays, openEnded } = this.data
    if (!name || !name.trim()) {
      wx.showToast({ title: '请填作业本名称', icon: 'none' })
      return
    }
    if (!startDate) {
      wx.showToast({ title: '请选开始日期', icon: 'none' })
      return
    }
    if (mode === 'one-shot') {
      if (!endDate) {
        wx.showToast({ title: '请选结束日期', icon: 'none' })
        return
      }
      if (endDate < startDate) {
        wx.showToast({ title: '结束日期不能早于开始', icon: 'none' })
        return
      }
    } else {
      if (recurType === 'weekly' && recurWeekdays.length === 0) {
        wx.showToast({ title: '请选每周哪几天', icon: 'none' })
        return
      }
    }

    const payload = {
      name: name.trim(),
      subject,
      mode,
      startDate,
      endDate: mode === 'one-shot' ? endDate : (openEnded ? null : (endDate || null)),
      recurrence: mode === 'recurring'
        ? { type: recurType, weekdays: recurType === 'weekly' ? recurWeekdays.slice().sort() : [] }
        : null
    }

    if (this.data.isEdit) {
      store.updateNotebook(this.data.notebookId, payload)
      wx.showToast({ title: '已保存', icon: 'success' })
    } else {
      store.addNotebook(payload)
      wx.showToast({ title: '已新建', icon: 'success' })
    }
    setTimeout(() => wx.navigateBack(), 350)
  },

  handleDelete() {
    if (!this.data.isEdit) return
    wx.showModal({
      title: '删除作业本？',
      content: '本里所有作业也会一起删除。',
      confirmColor: '#e54545',
      success: (res) => {
        if (res.confirm) {
          store.deleteNotebook(this.data.notebookId)
          wx.showToast({ title: '已删除', icon: 'success' })
          setTimeout(() => wx.navigateBack(), 350)
        }
      }
    })
  }
})
