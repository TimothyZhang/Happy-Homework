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
    providerWarning: '',
    // 若 OCR job 上挂了 notebookId,导入时落到这本里,完成后退回该作业本详情;
    // 没挂 notebookId 时走旧的"进入当日 one-shot 作业本 + 跳 tasks tab"的路径。
    notebookId: ''
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
      notebookId: job.notebookId || '',
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

    const { notebookId } = this.data
    validDrafts.forEach((item) => {
      const payload = {
        subject: item.subject || '其他',
        content: item.content.trim(),
        estimatedMinutes: 20
      }
      // 从作业本详情页发起的 OCR 把 drafts 落到这本里;否则让 store.addTask
      // 走 legacy 分支,自动建/复用当日 one-shot 作业本。
      if (notebookId) payload.notebookId = notebookId
      store.addTask(payload)
    })

    this.setData({ importedCount: validDrafts.length })
    const isNotebookImport = !!notebookId
    wx.showModal({
      title: '导入成功',
      content: isNotebookImport
        ? `已往当前作业本添加 ${validDrafts.length} 条作业。`
        : `已导入 ${validDrafts.length} 条作业，下一步可以去“作业”页继续编辑时间和优先级。`,
      showCancel: false,
      success: () => {
        if (isNotebookImport) {
          // 弹两页(ocr-result + ocr-import)回到作业本详情;失败时退回 tasks 兜底。
          wx.navigateBack({
            delta: 2,
            fail: () => wx.switchTab({ url: '/pages/tasks/index' })
          })
        } else {
          wx.switchTab({ url: '/pages/tasks/index' })
        }
      }
    })
  }
})
