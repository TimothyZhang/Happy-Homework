const store = require('../../utils/store')
const i18n = require('../../utils/i18n')

const subjectOptions = ['未识别', '语文', '数学', '英语', '科学', '道法', '美术', '音乐', '体育', '其他']

// 用户拍照识别完后,把(原图 + 用户最终确认的作业列表)沉淀成 OCR 样本,
// 供 scripts/eval-homework-ocr.js 离线评估 prompt。
// 样本 JSON 路径跟原图保持同名 stem,只是换前缀和扩展名,方便后续配对下载。
const SAMPLE_CLOUD_PATH_PREFIX = 'homework-register-samples'

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
  return SOURCE_LABELS[source] || source || i18n.t('ocrres_source_unknown')
}

Page({
  data: {
    imagePath: '',
    rawText: '',
    drafts: [],
    subjectOptions,
    organizationOptions: [],
    organization: '',
    organizationIndex: 0,
    importedCount: 0,
    source: '',
    providerWarning: '',
    sourceTagLabel: '',
    draftsCountLabel: '',
    t: {}
  },

  // 非响应式字段:仅用于上传样本时引用,不需要进 setData
  _imageFileID: '',
  _ocrDraftsSnapshot: [],
  _sampleUploaded: false,

  onShow() {
    this.setData({ t: i18n.dict() })
    wx.setNavigationBarTitle({ title: i18n.t('ocrres_navtitle') })

    const job = store.getCurrentOcrJob()
    if (!job) {
      wx.showToast({ title: i18n.t('ocrres_toast_no_job'), icon: 'none' })
      setTimeout(() => {
        wx.navigateBack({ delta: 1 })
      }, 500)
      return
    }

    const today = store.todayStr()
    const orgList = store.getOrganizations()
    const organization = orgList[0] || store.DEFAULT_ORGANIZATION
    const organizationIndex = Math.max(0, orgList.indexOf(organization))

    this._imageFileID = job.imageFileID || ''
    this._ocrDraftsSnapshot = (job.drafts || []).map((d) => ({
      subject: d.subject || '',
      content: d.content || '',
      confidence: d.confidence || '',
      rawText: d.rawText || ''
    }))
    this._sampleUploaded = false

    const drafts = (job.drafts || []).map((draft) => ({
      ...draft,
      dueDate: draft.dueDate || today,
      // WXML {{}} 不支持 subjectOptions.indexOf(...) 方法调用(静默求值失败 → picker
      // 永远停在第 0 项)。在 JS 里预算好 subjectIndex,WXML 直接读字段。
      // 识别出的 subject 不在选项里(含空串)→ -1,WXML 兜底回 0(未识别)。
      subjectIndex: subjectOptions.indexOf(draft.subject),
      confidenceClass: getConfidenceClass(draft.confidence)
    }))

    this.setData({
      imagePath: job.imagePath,
      rawText: job.rawText,
      source: job.source || '',
      sourceLabel: getSourceLabel(job.source),
      sourceTagLabel: i18n.t('ocrres_source_label', { label: getSourceLabel(job.source) }),
      providerWarning: job.providerWarning || '',
      organizationOptions: orgList,
      organization,
      organizationIndex,
      drafts,
      draftsCountLabel: i18n.t('ocrres_drafts_count', { n: drafts.length })
    })

    if (job.source === 'builtin-ocr-tesseract') {
      wx.showToast({
        title: i18n.t('ocrres_toast_builtin_warn'),
        icon: 'none',
        duration: 2200
      })
    }
  },

  handleSubjectChange(event) {
    const { index } = event.currentTarget.dataset
    const optIndex = Number(event.detail.value)
    const value = subjectOptions[optIndex]
    const nextPath = value === '未识别' ? '' : value
    // subject 改了,subjectIndex 跟着改(picker 的 detail.value 就是选中下标),
    // 否则下次渲染 picker 又回到旧 index。
    this.setData({
      [`drafts[${index}].subject`]: nextPath,
      [`drafts[${index}].subjectIndex`]: optIndex
    })
  },

  handleContentInput(event) {
    const { index } = event.currentTarget.dataset
    this.setData({ [`drafts[${index}].content`]: event.detail.value })
  },

  handleDueDateChange(event) {
    const { index } = event.currentTarget.dataset
    this.setData({ [`drafts[${index}].dueDate`]: event.detail.value })
  },

  handleOrganizationChange(event) {
    const idx = Number(event.detail.value)
    const organization = this.data.organizationOptions[idx]
    if (!organization) return
    this.setData({ organizationIndex: idx, organization })
  },

  handleDeleteDraft(event) {
    const { index } = event.currentTarget.dataset
    const drafts = this.data.drafts.slice()
    drafts.splice(index, 1)
    this.setData({ drafts, draftsCountLabel: i18n.t('ocrres_drafts_count', { n: drafts.length }) })
  },

  handleAddDraft() {
    const drafts = this.data.drafts.concat({
      id: `draft-${Date.now()}`,
      subject: '',
      subjectIndex: 0,
      content: '',
      rawText: '',
      dueDate: store.todayStr(),
      confidence: '低',
      confidenceClass: 'low',
      needsConfirm: true
    })
    this.setData({ drafts, draftsCountLabel: i18n.t('ocrres_drafts_count', { n: drafts.length }) })
  },

  handleImportTasks() {
    const validDrafts = this.data.drafts.filter((item) => item.content && item.content.trim())

    if (!validDrafts.length) {
      wx.showToast({ title: i18n.t('ocrres_toast_empty'), icon: 'none' })
      return
    }

    const today = store.todayStr()
    const organization = this.data.organization || store.DEFAULT_ORGANIZATION
    validDrafts.forEach((item) => {
      const due = item.dueDate || today
      store.addTask({
        subject: item.subject || '其他',
        organization,
        content: item.content.trim(),
        estimatedMinutes: 20,
        mode: 'one-shot',
        startDate: due,
        endDate: due
      })
    })

    this.setData({ importedCount: validDrafts.length })

    // fire-and-forget:把这次识别留底当作 OCR 样本。失败也不打断用户。
    this.persistOcrSample(validDrafts)

    wx.showModal({
      title: i18n.t('ocrres_import_title'),
      content: i18n.t('ocrres_import_content', { n: validDrafts.length }),
      confirmText: i18n.t('ocrres_import_ok'),
      showCancel: false,
      success: () => {
        wx.switchTab({ url: '/pages/home/index' })
      }
    })
  },

  // 把"原始图片 + 用户最终确认的作业列表"上传成 OCR 样本。开发者用
  // scripts/pull-ocr-samples.js 把云存储里这些样本拉回本地 samples/,
  // 然后 scripts/eval-homework-ocr.js 就能跑离线评估。
  //
  // 跳过条件:mock 数据没真 fileID、wx.cloud 不可用、同一次识别已经上传过。
  persistOcrSample(finalDrafts) {
    if (this._sampleUploaded) return
    if (typeof wx === 'undefined' || !wx.cloud) return
    const fileID = this._imageFileID
    if (!fileID) return  // mock / 演示数据没真 fileID

    // 用图片 fileID 的 stem 当样本名,方便一对一配对
    const stem = (fileID.split('/').pop() || '').replace(/\.[^.]+$/, '')
    if (!stem) return

    const sample = {
      groundTruth: finalDrafts.map((d) => ({
        subject: d.subject || '',
        content: (d.content || '').trim()
      })).filter((d) => d.content),
      imageFileID: fileID,
      ocrSource: this.data.source || '',
      ocrRawText: this.data.rawText || '',
      ocrDrafts: this._ocrDraftsSnapshot || [],
      capturedAt: store.todayStr(),
      createdAt: new Date().toISOString()
    }

    this._sampleUploaded = true

    const cloudPath = `${SAMPLE_CLOUD_PATH_PREFIX}/${stem}.json`
    const fsm = wx.getFileSystemManager()
    const tmpPath = `${wx.env.USER_DATA_PATH}/ocr-sample-${stem}.json`

    try {
      fsm.writeFileSync(tmpPath, JSON.stringify(sample, null, 2), 'utf8')
    } catch (error) {
      console.warn('persistOcrSample: write tmp file failed', error)
      this._sampleUploaded = false
      return
    }

    wx.cloud.uploadFile({
      cloudPath,
      filePath: tmpPath,
      success: (res) => {
        console.info('OCR sample uploaded', cloudPath, res && res.fileID)
      },
      fail: (error) => {
        console.warn('persistOcrSample: upload failed', error)
        this._sampleUploaded = false
      },
      complete: () => {
        try { fsm.unlinkSync(tmpPath) } catch (_) { /* ignore */ }
      }
    })
  }
})
