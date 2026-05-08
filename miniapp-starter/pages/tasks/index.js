const store = require('../../utils/store')

const DEFAULT_FORM = {
  subject: '语文',
  content: '',
  estimatedMinutes: ''
}

Page({
  data: {
    tasks: [],
    doneCount: 0,
    editingId: null,
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
      this.refreshState()
      wx.showToast({ title: '已更新作业', icon: 'success' })
      return
    }

    store.addTask(payload)
    this.refreshState()
    wx.showToast({ title: '已新增作业', icon: 'success' })
  },

  handleEditTask(event) {
    const { id } = event.currentTarget.dataset
    store.setEditTaskId(id)
    this.refreshState()
    wx.pageScrollTo({ scrollTop: 0, duration: 200 })
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
          }
          this.refreshState()
          wx.showToast({ title: '已删除', icon: 'success' })
        }
      }
    })
  },

  handleCancelEdit() {
    store.clearEditTaskId()
    this.refreshState()
  },

  handleMockPhoto() {
    wx.navigateTo({
      url: '/pages/ocr-import/index'
    })
  }
})
