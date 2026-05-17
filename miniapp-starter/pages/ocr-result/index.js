const store = require('../../utils/store')

const subjectOptions = ['未识别', '语文', '数学', '英语', '科学', '道法', '美术', '音乐', '体育', '其他']

function getConfidenceClass(confidence) {
  if (confidence === '高') return 'high'
  if (confidence === '中') return 'medium'
  return 'low'
}

const SOURCE_LABELS = {
  'openai-vision-ocr': 'OpenAI Vision',
  'tencent-cloud-general-handwriting-ocr': '腾讯云手写 OCR',
  'tencent-cloud-general-accurate-ocr': '腾讯云精准印刷 OCR',
  'tencent-cloud-general-basic-ocr': '腾讯云通用 OCR',
  'wechat-openapi-printed-text-ocr': '微信 OpenAPI 印刷 OCR',
  'builtin-ocr-tesseract': '云函数内置 Tesseract',
  'mock-event': '演示数据(mock)'
}

function getSourceLabel(source) {
  return SOURCE_LABELS[source] || source || '未知通道'
}

Page({
  data: {
    imagePath: '',
    rawText: '',
    drafts: [],
    subjectOptions,
    importedCount: 0,
    source: '',
    providerWarning: ''
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
      source: job.source || '',
      sourceLabel: getSourceLabel(job.source),
      providerWarning: job.providerWarning || '',
      drafts: (job.drafts || []).map((draft) => ({
        ...draft,
        confidenceClass: getConfidenceClass(draft.confidence)
      }))
    })

    if (job.source === 'builtin-ocr-tesseract') {
      wx.showToast({
        title: '当前走内置 OCR，请重点确认识别结果',
        icon: 'none',
        duration: 2200
      })
    }
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
      confidenceClass: 'low',
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

    const today = store.todayStr()
    validDrafts.forEach((item) => {
      // 拍照识别出的草稿统一作为一次性任务、落到今天。
      store.addTask({
        subject: item.subject || '其他',
        organization: store.DEFAULT_ORGANIZATION,
        content: item.content.trim(),
        estimatedMinutes: 20,
        mode: 'one-shot',
        startDate: today,
        endDate: today
      })
    })

    this.setData({ importedCount: validDrafts.length })
    wx.showModal({
      title: '导入成功',
      content: `已往今天添加 ${validDrafts.length} 条作业。`,
      showCancel: false,
      success: () => {
        wx.switchTab({ url: '/pages/home/index' })
      }
    })
  }
})
