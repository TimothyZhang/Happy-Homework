const store = require('../../utils/store')

const MODE_OPTIONS = [
  { key: 'one-shot', label: '一次性' },
  { key: 'recurring', label: '重复' }
]
const RECUR_TYPE_OPTIONS = [
  { key: 'daily', label: '每日' },
  { key: 'weekly', label: '每周' }
]
const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']

function buildWeekdays(activeValues) {
  const set = new Set(activeValues || [])
  return WEEKDAY_LABELS.map((label, i) => ({
    value: i + 1,
    label,
    active: set.has(i + 1)
  }))
}

Page({
  data: {
    isEdit: false,
    notebookId: null,
    name: '',
    mode: 'one-shot',
    modeOptions: MODE_OPTIONS,
    startDate: '',
    endDate: '',
    recurType: 'daily',
    recurTypeOptions: RECUR_TYPE_OPTIONS,
    recurWeekdays: [],
    weekdays: buildWeekdays([]),
    openEnded: false
  },

  onLoad(options) {
    const today = store.todayStr()
    if (options && options.id) {
      const nb = store.getNotebookById(options.id)
      if (nb) {
        this.setData({
          isEdit: true,
          notebookId: nb.id,
          name: nb.name,
          mode: nb.mode || 'one-shot',
          startDate: nb.startDate || today,
          endDate: nb.endDate || (nb.mode === 'recurring' ? '' : today),
          recurType: nb.recurrence ? nb.recurrence.type : 'daily',
          recurWeekdays: nb.recurrence ? (nb.recurrence.weekdays || []) : [],
          weekdays: buildWeekdays(nb.recurrence ? nb.recurrence.weekdays : []),
          openEnded: nb.mode === 'recurring' && !nb.endDate
        })
        wx.setNavigationBarTitle({ title: '编辑作业本' })
        return
      }
    }
    this.setData({
      name: today,
      startDate: today,
      endDate: today
    })
    wx.setNavigationBarTitle({ title: '新建作业本' })
  },

  handleNameInput(e) {
    this.setData({ name: e.detail.value })
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
    this.setData({
      recurWeekdays: wds,
      weekdays: buildWeekdays(wds)
    })
  },

  handleToggleOpenEnded(e) {
    const openEnded = e.detail.value
    this.setData({
      openEnded,
      endDate: openEnded ? '' : (this.data.endDate || this.data.startDate)
    })
  },

  handleSave() {
    const { name, mode, startDate, endDate, recurType, recurWeekdays, openEnded } = this.data
    if (!name || !name.trim()) {
      wx.showToast({ title: '请填作业本名称', icon: 'none' })
      return
    }
    // Same trimmed name as another notebook → block save. excludeId protects
    // editing a notebook into "itself".
    const excludeId = this.data.isEdit ? this.data.notebookId : null
    if (store.findNotebookByName(name, excludeId)) {
      wx.showToast({ title: '已存在同名作业本', icon: 'none' })
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
    setTimeout(() => wx.navigateBack(), 200)
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
          setTimeout(() => wx.navigateBack(), 200)
        }
      }
    })
  }
})
