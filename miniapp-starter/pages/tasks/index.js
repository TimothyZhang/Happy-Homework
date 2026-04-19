const store = require('../../utils/store')

Page({
  data: {
    tasks: [],
    doneCount: 0,
    subjectOptions: ['语文', '数学', '英语', '科学', '道法', '其他'],
    priorityOptions: ['高', '中', '低'],
    form: {
      subject: '语文',
      content: '',
      estimatedMinutes: '',
      planStart: '19:00',
      planEnd: '19:20',
      priority: '中'
    }
  },

  onShow() {
    this.refreshState()
  },

  refreshState() {
    const state = store.getStateWithComputed()
    this.setData({
      tasks: state.tasks,
      doneCount: state.tasks.filter((task) => task.status === 'done').length
    })
  },

  handleSubjectChange(event) {
    const subject = this.data.subjectOptions[event.detail.value]
    this.setData({ 'form.subject': subject })
  },

  handlePriorityChange(event) {
    const priority = this.data.priorityOptions[event.detail.value]
    this.setData({ 'form.priority': priority })
  },

  handleContentInput(event) {
    this.setData({ 'form.content': event.detail.value })
  },

  handleMinutesInput(event) {
    this.setData({ 'form.estimatedMinutes': event.detail.value })
  },

  handlePlanStartInput(event) {
    this.setData({ 'form.planStart': event.detail.value })
  },

  handlePlanEndInput(event) {
    this.setData({ 'form.planEnd': event.detail.value })
  },

  handleSaveTask() {
    const { form } = this.data
    if (!form.content || !form.estimatedMinutes) {
      wx.showToast({ title: '请先补全内容和时长', icon: 'none' })
      return
    }

    store.addTask({
      subject: form.subject,
      content: form.content,
      estimatedMinutes: Number(form.estimatedMinutes),
      planStart: form.planStart,
      planEnd: form.planEnd,
      priority: form.priority
    })

    this.setData({
      form: {
        subject: '语文',
        content: '',
        estimatedMinutes: '',
        planStart: '19:00',
        planEnd: '19:20',
        priority: '中'
      }
    })

    this.refreshState()
    wx.showToast({ title: '已新增作业', icon: 'success' })
  },

  handleMockPhoto() {
    wx.showModal({
      title: '拍照识别',
      content: '下一步我会把 OCR 接进这里。现在先把作业闭环做完整。',
      showCancel: false
    })
  }
})