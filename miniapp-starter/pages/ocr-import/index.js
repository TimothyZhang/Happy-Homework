const store = require('../../utils/store')

const CLOUD_PATH_PREFIX = 'homework-register'

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

  return `真实 OCR 还没完全跑通。\n${message || '请查看开发者工具控制台日志。'}${requestId}`
}

Page({
  data: {
    imagePath: '',
    isRecognizing: false,
    canUseCloud: typeof wx.cloud !== 'undefined',
    useMockData: false,
    tips: [
      '尽量正面拍整页，避免裁掉边缘',
      '光线充足，减少阴影和反光',
      '一页只拍当天登记本内容，便于拆分多条作业'
    ]
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

  handleUseMockImage() {
    this.setData({ imagePath: '', useMockData: true })
    wx.showToast({ title: '已载入演示数据', icon: 'none' })
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
    if (!this.data.imagePath && !this.data.useMockData) {
      wx.showToast({ title: '先选择一张登记本照片', icon: 'none' })
      return
    }

    this.setData({ isRecognizing: true })

    if (this.data.useMockData || !this.data.canUseCloud) {
      this.runMockRecognition()
      return
    }

    try {
      const uploadFilePath = await this.prepareImageForUpload(this.data.imagePath)
      const uploadRes = await wx.cloud.uploadFile({
        cloudPath: `${CLOUD_PATH_PREFIX}/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`,
        filePath: uploadFilePath
      })

      const callRes = await wx.cloud.callFunction({
        name: 'homeworkOCR',
        timeout: 60000,
        data: {
          imageFileID: uploadRes.fileID,
          imagePath: this.data.imagePath
        }
      })

      const result = (callRes && callRes.result) || {}
      if (!result.ok) {
        throw createCloudFunctionError(result)
      }

      store.setCurrentOcrJob({
        imagePath: this.data.imagePath,
        rawText: result.rawText || '',
        drafts: result.drafts || [],
        source: result.source || 'cloud-function',
        imageFileID: uploadRes.fileID,
        providerWarning: result.providerWarning || ''
      })

      this.setData({ isRecognizing: false })
      wx.navigateTo({
        url: '/pages/ocr-result/index'
      })
    } catch (error) {
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
