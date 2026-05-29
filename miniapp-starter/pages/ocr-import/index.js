const store = require('../../utils/store')

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
  const error = new Error(result.error || '云函数返回失败')
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
    return '图片上传后没有拿到 fileID，云函数没法继续识别。先回退到演示结果。'
  }

  if (code === 'OCR_SDK_MISSING') {
    return '云函数还没安装 OCR SDK。需要重新部署 homeworkOCR，再回到手机里测试。'
  }

  if (code === 'TESSERACT_SDK_MISSING') {
    return '云函数里的内置 OCR 依赖还没装好，需要重新部署 homeworkOCR。'
  }

  if (code === 'TESSERACT_LANGDATA_MISSING') {
    return '云函数里的中文识别语言包缺失，需要重新部署 homeworkOCR。'
  }

  if (code === 'OCR_CREDENTIALS_MISSING') {
    return '云函数已经接到真实 OCR，但当前云环境里还没配置可用凭证，所以识别失败。'
  }

  if (code === 'OPENAI_API_KEY_MISSING') {
    return 'OpenAI OCR 已接入，但云函数环境变量里还没有配置 OPENAI_API_KEY。配置后重新部署或更新函数配置即可真实识别。'
  }

  if (code === 'OPENAI_AUTH_FAILED') {
    return `OpenAI OCR 鉴权失败，检查 OPENAI_API_KEY 是否正确、是否有余额或项目权限。${requestId}`
  }

  if (code === 'OPENAI_RATE_LIMITED') {
    return 'OpenAI OCR 被限流或额度不足，稍后重试或检查 OpenAI 项目额度。'
  }

  if (code === 'OPENAI_NETWORK_FAILED') {
    return '云函数没有成功连到 OpenAI API。若云环境访问 api.openai.com 受限，需要配置 OPENAI_BASE_URL 到可访问的 OpenAI 兼容网关。'
  }

  if (code === 'OPENAI_OCR_TIMEOUT') {
    return 'OpenAI OCR 请求超时。可以换更清晰、更小的图片再试，或提高 OPENAI_OCR_TIMEOUT_MS。'
  }

  if (code === 'OCR_POLL_TIMEOUT') {
    return '这次识别用时过长（超过 2 分钟还没出结果）。可以换一张更清晰、更小的图片再试。'
  }

  if (code === 'OPENAI_OCR_FAILED') {
    return `OpenAI OCR 调用失败。\n${message || '请查看云函数日志。'}${requestId}`
  }

  if (code === 'OCR_PERMISSION_DENIED') {
    return `腾讯云 OCR 接口权限不足，真实 OCR 被拒绝。现在已停止使用内置 OCR 的错结果，需要给云函数运行角色添加 OCR 调用权限。${requestId}`
  }

  if (
    code === '-504003' ||
    raw.includes('functions_time_limit_exceeded') ||
    raw.includes('timed out after')
  ) {
    return 'homeworkOCR 这次识别超时了。现在已停止使用内置 OCR 的错结果。'
  }

  if (code === 'BUILTIN_OCR_FAILED') {
    return `内置 OCR 也没有成功跑通。\n${message || '请查看云函数日志。'}${requestId}`
  }

  if (code === 'DOWNLOAD_FILE_FAILED') {
    return '云函数没有成功读到刚上传的图片，可能是云环境权限或文件访问失败。先回退到演示结果。'
  }

  if (code === 'OCR_EMPTY_RESULT') {
    return '真实 OCR 已经调起了，但这张图片没有识别出可用文本。可以换一张更清晰、角度更正的图片再试。'
  }

  if (raw.includes('functionname') || raw.includes('not found') || raw.includes('函数') && raw.includes('不存在')) {
    return '当前云环境里还没有部署 homeworkOCR 云函数，所以手机端只能失败回退。'
  }

  if (raw.includes('environment') || raw.includes('env')) {
    return '当前小程序还没有绑定正确的云开发环境，云函数调用没有落到可用环境。'
  }

  const codeLine = code ? `[${code}]\n` : ''
  return `真实 OCR 还没完全跑通。\n${codeLine}${message || '请查看开发者工具控制台日志。'}${requestId}`
}

Page({
  data: {
    imagePath: '',
    isRecognizing: false,
    canUseCloud: typeof wx.cloud !== 'undefined',
    tips: [
      '尽量正面拍整页，避免裁掉边缘',
      '光线充足，减少阴影和反光',
      '一页只拍当天登记本内容，便于拆分多条作业'
    ]
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
            title: '图片超过 5MB,请换小一点的',
            icon: 'none',
            duration: 2400
          })
          return
        }
        this.setData({ imagePath: file.tempFilePath })
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
      wx.showToast({ title: '先选择一张登记本照片', icon: 'none' })
      return
    }

    // 客户端先把次数挡一下,30 次对正常用户绰绰有余。
    if (this.data.canUseCloud && ocrCallsThisSession >= OCR_SESSION_LIMIT) {
      wx.showToast({
        title: '本次启动已识别太多次,稍后再试',
        icon: 'none',
        duration: 2400
      })
      return
    }

    this.setData({ isRecognizing: true })

    if (!this.data.canUseCloud) {
      this.runMockRecognition()
      return
    }

    let jobDocId = ''
    try {
      ocrCallsThisSession += 1
      const uploadFilePath = await this.prepareImageForUpload(this.data.imagePath)
      const uploadRes = await wx.cloud.uploadFile({
        cloudPath: `${CLOUD_PATH_PREFIX}/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`,
        filePath: uploadFilePath
      })

      // 预建一条 job doc(_openid 自动落到当前用户,creator-only ACL 下自己可读)。
      // 失败不致命:只丢掉"网关超时后轮询"这条兜底路径,同步 <60s 的识别仍正常。
      jobDocId = await this.createOcrJobDoc()

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

      store.setCurrentOcrJob({
        imagePath: this.data.imagePath,
        rawText: result.rawText || '',
        drafts: result.drafts || [],
        source: result.source || 'cloud-function',
        imageFileID: uploadRes.fileID,
        providerWarning: result.providerWarning || ''
      })

      this.cleanupOcrJobDoc(jobDocId)
      this.setData({ isRecognizing: false })
      wx.navigateTo({
        url: '/pages/ocr-result/index'
      })
    } catch (error) {
      this.cleanupOcrJobDoc(jobDocId)
      console.error('OCR recognize failed', error)
      this.setData({ isRecognizing: false })
      wx.showModal({
        title: '识别失败',
        content: getRecognizeFailureMessage(error),
        confirmText: error.canFallback ? '看演示' : '知道了',
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
      const e = new Error('云数据库不可用，无法轮询识别结果')
      e.code = 'OCR_POLL_TIMEOUT'
      throw e
    }
    wx.showLoading({ title: '识别中，请稍候', mask: true })
    try {
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
    } finally {
      wx.hideLoading()
    }
    const timeoutErr = new Error('homeworkOCR 后台识别超时，未拿到结果')
    timeoutErr.code = 'OCR_POLL_TIMEOUT'
    throw timeoutErr
  },

  runMockRecognition() {
    setTimeout(() => {
      store.setCurrentOcrJob({
        imagePath: this.data.imagePath || '/mock/homework-register-demo.jpg',
        rawText: mockRawText,
        drafts: mockDrafts
      })

      this.setData({ isRecognizing: false })
      wx.navigateTo({
        url: '/pages/ocr-result/index'
      })
    }, 800)
  }
})
