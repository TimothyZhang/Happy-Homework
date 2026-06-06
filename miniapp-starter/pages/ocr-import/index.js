const store = require('../../utils/store')
const i18n = require('../../utils/i18n')

const CLOUD_PATH_PREFIX = 'homework-register'

// 单次上传 5MB 上限。压缩后通常 < 1MB,留 5x 余量给原图或异常情况。
// 太大的图会让云函数下载 / base64 / OpenAI 上传都变慢甚至超时,也容易
// 拉高云存储费用。
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

// 同一个 app 实例(从启动到杀进程)内允许的 OCR 次数上限。即使云函数
// 已经按 openid 限流,客户端这里早点拦,省一次往返 + 上传带宽 + 给
// 用户更明确的提示。30 次对正常用户绰绰有余 —— 一周打卡撑死也就十几次。
const OCR_SESSION_LIMIT = 30
let ocrCallsThisSession = 0

// 客户端预建 job doc 的集合 —— 见 handleStartRecognize 里网关超时兜底的注释。
const OCR_JOB_COLLECTION = 'ocr_jobs'
// 网关 ~60s 放弃后改 DB 轮询的节奏:每 3s 一次,最多 ~66s,足够覆盖到云函数
// 自身 120s timeout(轮询从网关放弃的那一刻起算)。
const OCR_POLL_INTERVAL_MS = 3000
const OCR_POLL_MAX_TRIES = 22

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// 判断 callFunction 失败是不是"微信网关 60s 同步超时"这一类。命中时云函数其实
// 还在后台跑,改走 job doc 轮询;其它错误(网络 / 函数不存在 / 鉴权)直接抛,
// 走原有失败弹窗。
function isGatewayTimeout(error) {
  const msg = `${(error && error.errMsg) || ''} ${(error && error.message) || ''}`.toLowerCase()
  if (!msg.trim()) return false
  return (
    msg.includes('esockettimedout') ||
    msg.includes('-501002') ||
    msg.includes('resource server timeout') ||
    msg.includes('etimedout') ||
    (msg.includes('callfunction:fail') && msg.includes('timeout'))
  )
}

const mockRawText = `语文：抄写第3课生字两遍
数学：练习册第12页第1-5题
英语：背诵单词1-20
带彩纸一张，周三手工课用`

const mockDrafts = [
  {
    id: 'draft-1',
    subject: '语文',
    content: '抄写第3课生字两遍',
    rawText: '语文：抄写第3课生字两遍',
    confidence: '高',
    needsConfirm: false
  },
  {
    id: 'draft-2',
    subject: '数学',
    content: '练习册第12页第1-5题',
    rawText: '数学：练习册第12页第1-5题',
    confidence: '高',
    needsConfirm: false
  },
  {
    id: 'draft-3',
    subject: '英语',
    content: '背诵单词1-20',
    rawText: '英语：背诵单词1-20',
    confidence: '中',
    needsConfirm: true
  },
  {
    id: 'draft-4',
    subject: '',
    content: '带彩纸一张，周三手工课用',
    rawText: '带彩纸一张，周三手工课用',
    confidence: '低',
    needsConfirm: true
  }
]

function createCloudFunctionError(result) {
  const error = new Error(result.error || 'cloud function returned failure')
  error.code = result.errorCode || 'CLOUD_FUNCTION_FAILED'
  error.requestId = result.requestId || ''
  error.canFallback = Boolean(result.canFallback)
  return error
}

function getRecognizeFailureMessage(error) {
  const code = String((error && error.code) || '')
  const message = String((error && error.message) || '')
  const requestId = error && error.requestId ? `\nrequestId: ${error.requestId}` : ''
  const raw = `${code} ${message}`.toLowerCase()

  if (code === 'MISSING_IMAGE_FILE_ID') {
    return i18n.t('ocrimp_err_missing_fileid')
  }

  if (code === 'OCR_SDK_MISSING') {
    return i18n.t('ocrimp_err_ocr_sdk_missing')
  }

  if (code === 'TESSERACT_SDK_MISSING') {
    return i18n.t('ocrimp_err_tesseract_sdk_missing')
  }

  if (code === 'TESSERACT_LANGDATA_MISSING') {
    return i18n.t('ocrimp_err_tesseract_langdata_missing')
  }

  if (code === 'OCR_CREDENTIALS_MISSING') {
    return i18n.t('ocrimp_err_credentials_missing')
  }

  if (code === 'OPENAI_API_KEY_MISSING') {
    return i18n.t('ocrimp_err_openai_key_missing')
  }

  if (code === 'OPENAI_AUTH_FAILED') {
    return i18n.t('ocrimp_err_openai_auth', { reqid: requestId })
  }

  if (code === 'OPENAI_RATE_LIMITED') {
    return i18n.t('ocrimp_err_openai_rate')
  }

  if (code === 'OPENAI_NETWORK_FAILED') {
    return i18n.t('ocrimp_err_openai_network')
  }

  if (code === 'OPENAI_OCR_TIMEOUT') {
    return i18n.t('ocrimp_err_openai_timeout')
  }

  if (code === 'OCR_POLL_TIMEOUT') {
    return i18n.t('ocrimp_err_poll_timeout')
  }

  if (code === 'OPENAI_OCR_FAILED') {
    return i18n.t('ocrimp_err_openai_ocr_failed', { msg: message || i18n.t('ocrimp_err_btn_ok'), reqid: requestId })
  }

  if (code === 'OCR_PERMISSION_DENIED') {
    return i18n.t('ocrimp_err_ocr_permission', { reqid: requestId })
  }

  if (
    code === '-504003' ||
    raw.includes('functions_time_limit_exceeded') ||
    raw.includes('timed out after')
  ) {
    return i18n.t('ocrimp_err_scf_timeout')
  }

  if (code === 'BUILTIN_OCR_FAILED') {
    return i18n.t('ocrimp_err_builtin_failed', { msg: message || i18n.t('ocrimp_err_btn_ok'), reqid: requestId })
  }

  if (code === 'DOWNLOAD_FILE_FAILED') {
    return i18n.t('ocrimp_err_download_failed')
  }

  if (code === 'OCR_EMPTY_RESULT') {
    return i18n.t('ocrimp_err_empty_result')
  }

  if (raw.includes('functionname') || raw.includes('not found') || raw.includes('函数') && raw.includes('不存在')) {
    return i18n.t('ocrimp_err_no_function')
  }

  if (raw.includes('environment') || raw.includes('env')) {
    return i18n.t('ocrimp_err_no_env')
  }

  const codeLine = code ? `[${code}]\n` : ''
  return i18n.t('ocrimp_err_generic', { code: codeLine, msg: message || '', reqid: requestId })
}

Page({
  data: {
    imagePath: '',
    previewNote: '',
    isRecognizing: false,
    ocrProgress: 0,
    ocrStage: '',
    ocrHint: '',
    canUseCloud: typeof wx.cloud !== 'undefined',
    tips: [],
    t: {}
  },

  onShow() {
    this.setData({
      t: i18n.dict(),
      tips: [
        i18n.t('ocrimp_tip_0'),
        i18n.t('ocrimp_tip_1'),
        i18n.t('ocrimp_tip_2')
      ]
    })
    wx.setNavigationBarTitle({ title: i18n.t('ocrimp_navtitle') })
  },

  handleSwitchToTaskEdit() {
    wx.redirectTo({ url: '/pkg-notebook/task-edit/index' })
  },

  chooseImage(sourceType) {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: [sourceType],
      sizeType: ['compressed'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0]
        if (!file) return
        if (file.size && file.size > MAX_UPLOAD_BYTES) {
          wx.showToast({
            title: i18n.t('ocrimp_toast_too_large'),
            icon: 'none',
            duration: 2400
          })
          return
        }
        this.setData({ imagePath: file.tempFilePath, previewNote: i18n.t('ocrimp_preview_note', { path: file.tempFilePath }) })
      }
    })
  },

  handleTakePhoto() {
    this.chooseImage('camera')
  },

  handleChooseFromAlbum() {
    this.chooseImage('album')
  },

  async prepareImageForUpload(filePath) {
    if (!filePath) {
      return filePath
    }

    try {
      const res = await wx.compressImage({
        src: filePath,
        quality: 65
      })
      return (res && res.tempFilePath) || filePath
    } catch (error) {
      console.warn('compressImage failed, fallback to original image', error)
      return filePath
    }
  },

  async handleStartRecognize() {
    if (!this.data.imagePath) {
      wx.showToast({ title: i18n.t('ocrimp_toast_no_image'), icon: 'none' })
      return
    }

    // 客户端先把次数挡一下,30 次对正常用户绰绰有余。
    if (this.data.canUseCloud && ocrCallsThisSession >= OCR_SESSION_LIMIT) {
      wx.showToast({
        title: i18n.t('ocrimp_toast_too_many'),
        icon: 'none',
        duration: 2400
      })
      return
    }

    this.setData({ isRecognizing: true, ocrProgress: 0, ocrStage: i18n.t('ocrimp_stage_prepare'), ocrHint: '' })

    if (!this.data.canUseCloud) {
      this.runMockRecognition()
      return
    }

    let jobDocId = ''
    try {
      ocrCallsThisSession += 1
      this.setData({ ocrStage: i18n.t('ocrimp_stage_compress') })
      const uploadFilePath = await this.prepareImageForUpload(this.data.imagePath)
      this.setData({ ocrStage: i18n.t('ocrimp_stage_upload') })
      const uploadRes = await this.uploadWithProgress(
        `${CLOUD_PATH_PREFIX}/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`,
        uploadFilePath
      )

      // 预建一条 job doc(_openid 自动落到当前用户,creator-only ACL 下自己可读)。
      // 失败不致命:只丢掉"网关超时后轮询"这条兜底路径,同步 <60s 的识别仍正常。
      jobDocId = await this.createOcrJobDoc()

      // 进入 AI 识别阶段:后端不上报中间进度,用「已用时长」驱动进度条(见 startRecognizeProgress)。
      this.startRecognizeProgress()

      let result
      try {
        const callRes = await wx.cloud.callFunction({
          name: 'homeworkOCR',
          // 微信 callFunction 网关同步超时硬上限 60s(控制台 / 这里的 timeout 都改
          // 不动)。OCR 偶尔跑过 60s 时这次调用会以 -501002 / ESOCKETTIMEDOUT 失败,
          // 但云函数作为独立 SCF 执行仍会跑到 120s,把结果写进 job doc —— 下面
          // catch 命中网关超时就改用 DB 轮询把结果捞回来。
          timeout: 60000,
          data: {
            imageFileID: uploadRes.fileID,
            imagePath: this.data.imagePath,
            jobDocId
          }
        })
        result = (callRes && callRes.result) || {}
      } catch (callErr) {
        if (jobDocId && isGatewayTimeout(callErr)) {
          // 网关超时,云函数后台还在跑 —— 轮询 job doc 把结果捞回来
          // (pollOcrJobResult 在超时/不可用时会抛 OCR_POLL_TIMEOUT)。
          result = await this.pollOcrJobResult(jobDocId)
        } else {
          throw callErr
        }
      }

      if (!result || !result.ok) {
        throw createCloudFunctionError(result || {})
      }

      this.finishRecognizeProgress()
      store.setCurrentOcrJob({
        imagePath: this.data.imagePath,
        rawText: result.rawText || '',
        drafts: result.drafts || [],
        source: result.source || 'cloud-function',
        imageFileID: uploadRes.fileID,
        providerWarning: result.providerWarning || ''
      })

      this.cleanupOcrJobDoc(jobDocId)
      wx.navigateTo({
        url: '/pages/ocr-result/index',
        complete: () => this.resetRecognizeProgress()
      })
    } catch (error) {
      this.cleanupOcrJobDoc(jobDocId)
      console.error('OCR recognize failed', error)
      this.resetRecognizeProgress()
      wx.showModal({
        title: i18n.t('ocrimp_err_title'),
        content: getRecognizeFailureMessage(error),
        confirmText: error.canFallback ? i18n.t('ocrimp_err_btn_demo') : i18n.t('ocrimp_err_btn_ok'),
        showCancel: false,
        success: () => {
          if (error.canFallback) {
            this.runMockRecognition()
          }
        }
      })
    }
  },

  // 预建 job doc;返回 _id(失败返回 ''),用于网关超时后的轮询兜底。
  async createOcrJobDoc() {
    if (!wx.cloud || !wx.cloud.database) return ''
    try {
      const res = await wx.cloud.database().collection(OCR_JOB_COLLECTION).add({
        data: { status: 'pending', createdAt: Date.now() }
      })
      return (res && res._id) || ''
    } catch (error) {
      // 多半是集合还没建(首次部署后由云函数 createCollection 建,下次就有了)。
      console.warn('createOcrJobDoc failed, poll fallback disabled this call', error && error.errMsg)
      return ''
    }
  },

  // best-effort 删自己的 job doc,别让作业文本在云端留存。失败无所谓。
  cleanupOcrJobDoc(jobDocId) {
    if (!jobDocId || !wx.cloud || !wx.cloud.database) return
    try {
      wx.cloud.database().collection(OCR_JOB_COLLECTION).doc(jobDocId).remove().catch(() => {})
    } catch (_) {}
  },

  // 网关已在 ~60s 放弃,但云函数仍在后台跑(SCF timeout 120s)。轮询 job doc
  // 直到 status==='done',拿回云函数写入的 payload。给用户"识别中"的明确反馈。
  async pollOcrJobResult(jobDocId) {
    const d = (wx.cloud && wx.cloud.database) ? wx.cloud.database() : null
    if (!d) {
      const e = new Error(i18n.t('ocrimp_db_unavailable'))
      e.code = 'OCR_POLL_TIMEOUT'
      throw e
    }
    // 网关已 ~60s 放弃,云函数后台还在跑 —— 进度条计时器仍在推进,这里只更新文案。
    this.setData({ ocrStage: i18n.t('ocrimp_stage_poll') })
    for (let i = 0; i < OCR_POLL_MAX_TRIES; i++) {
      await wait(OCR_POLL_INTERVAL_MS)
      let doc = null
      try {
        const res = await d.collection(OCR_JOB_COLLECTION).doc(jobDocId).get()
        doc = (res && res.data) || null
      } catch (readErr) {
        // 短暂读不到(最终一致性 / 云函数还没 update)—— 继续轮询。
        continue
      }
      if (doc && doc.status === 'done') {
        return doc.payload || {}
      }
    }
    const timeoutErr = new Error('homeworkOCR backend recognition timed out')
    timeoutErr.code = 'OCR_POLL_TIMEOUT'
    throw timeoutErr
  },

  // 带真实上传进度的 uploadFile 封装。onProgressUpdate 给 0–100,映射到进度条
  // 前 18%(剩下留给「AI 识别」阶段)。
  uploadWithProgress(cloudPath, filePath) {
    return new Promise((resolve, reject) => {
      const task = wx.cloud.uploadFile({ cloudPath, filePath, success: resolve, fail: reject })
      if (task && typeof task.onProgressUpdate === 'function') {
        task.onProgressUpdate((res) => {
          const p = Math.min(18, Math.round((((res && res.progress) || 0)) * 0.18))
          this.setData({ ocrProgress: p })
        })
      }
    })
  },

  // 识别阶段后端不上报中间进度,用「已用时长」按经验值(~80s)做 ease-out 推进:
  // 前期快、越接近 95% 越慢,反映真实等待又不卡在假 100%。真正拿到结果时由
  // finishRecognizeProgress 跳到 100。
  startRecognizeProgress() {
    this.recognizeStartTs = Date.now()
    this.clearRecognizeTimer()
    this.setData({ ocrProgress: 20, ocrStage: i18n.t('ocrimp_stage_ai'), ocrHint: i18n.t('ocrimp_hint_elapsed', { s: 0 }) })
    this.recognizeTimer = setInterval(() => {
      const elapsed = Date.now() - this.recognizeStartTs
      const eased = 1 - Math.exp(-(elapsed / 80000) * 1.4)
      const p = Math.min(95, Math.round(20 + 75 * eased))
      this.setData({ ocrProgress: p, ocrHint: i18n.t('ocrimp_hint_elapsed', { s: Math.round(elapsed / 1000) }) })
    }, 500)
  },

  finishRecognizeProgress() {
    this.clearRecognizeTimer()
    this.setData({ ocrProgress: 100, ocrStage: i18n.t('ocrimp_stage_done'), ocrHint: '' })
  },

  clearRecognizeTimer() {
    if (this.recognizeTimer) {
      clearInterval(this.recognizeTimer)
      this.recognizeTimer = null
    }
  },

  // 清计时器 + 收起等待动画(失败 / 跳转完成后调用)。
  resetRecognizeProgress() {
    this.clearRecognizeTimer()
    this.setData({ isRecognizing: false, ocrProgress: 0, ocrStage: '', ocrHint: '' })
  },

  onUnload() {
    this.clearRecognizeTimer()
  },

  runMockRecognition() {
    setTimeout(() => {
      store.setCurrentOcrJob({
        imagePath: this.data.imagePath || '/mock/homework-register-demo.jpg',
        rawText: mockRawText,
        drafts: mockDrafts
      })

      wx.navigateTo({
        url: '/pages/ocr-result/index',
        complete: () => this.resetRecognizeProgress()
      })
    }, 800)
  }
})
