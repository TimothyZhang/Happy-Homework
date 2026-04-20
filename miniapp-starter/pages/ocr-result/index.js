const store = require('../../utils/store')

const subjectOptions = ['未识别', '语文', '数学', '英语', '科学', '道法', '美术', '音乐', '体育', '其他']

Page({
  data: {
    imagePath: '',
    rawText: '',
    drafts: [],
    subjectOptions,
    importedCount: 0
  },

  onShow() {
    const job = store.getCurrentOcrJob()
    if (!job) {
      wx.showToast({ title: '还没有识别结果', icon: 'none' })
      setTimeout(() => {
        wx.navigateBack({ delta: 1 })
      }, 500)
      return
    }

    this.setData({
      imagePath: job.imagePath,
      rawText: job.rawText,
      drafts: (job.drafts || []).map((draft) => ({ ...draft }))
    })
  },

  handleSubjectChange(event) {
    const { index } = event.currentTarget.dataset
    const value = subjectOptions[event.detail.value]
    const nextPath = value === '未识别' ? '' : value
    this.setData({ [`drafts[${index}].subject`]: nextPath })
  },

  handleContentInput(event) {
    const { index } = event.currentTarget.dataset
    this.setData({ [`drafts[${index}].content`]: event.detail.value })
  },

  handleDeleteDraft(event) {
    const { index } = event.currentTarget.dataset
    const drafts = this.data.drafts.slice()
    drafts.splice(index, 1)
    this.setData({ drafts })
  },

  handleAddDraft() {
    const drafts = this.data.drafts.concat({
      id: `draft-${Date.now()}`,
      subject: '',
      content: '',
      rawText: '',
      confidence: '低',
      needsConfirm: true
    })
    this.setData({ drafts })
  },

  handleImportTasks() {
    const validDrafts = this.data.drafts.filter((item) => item.content && item.content.trim())

    if (!validDrafts.length) {
      wx.showToast({ title: '至少保留一条作业', icon: 'none' })
      return
    }

    validDrafts.forEach((item, index) => {
      store.addTask({
        subject: item.subject || '其他',
        content: item.content.trim(),
        estimatedMinutes: 20,
        planStart: index === 0 ? '19:00' : '19:30',
        planEnd: index === 0 ? '19:20' : '19:50',
        priority: index === 0 ? '高' : '中',
        sourceType: 'ocr'
      })
    })

    this.setData({ importedCount: validDrafts.length })
    wx.showModal({
      title: '导入成功',
      content: `已导入 ${validDrafts.length} 条作业，下一步可以去“作业”页继续编辑时间和优先级。`,
      showCancel: false,
      success: () => {
        wx.switchTab({ url: '/pages/tasks/index' })
      }
    })
  }
})
