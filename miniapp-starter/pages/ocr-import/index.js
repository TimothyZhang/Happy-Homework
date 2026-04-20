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
      const uploadRes = await wx.cloud.uploadFile({
        cloudPath: `${CLOUD_PATH_PREFIX}/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`,
        filePath: this.data.imagePath
      })

      const callRes = await wx.cloud.callFunction({
        name: 'homeworkOCR',
        data: {
          imageFileID: uploadRes.fileID,
          imagePath: this.data.imagePath
        }
      })

      const result = (callRes && callRes.result) || {}
      if (!result.ok) {
        throw new Error(result.error || '云函数返回失败')
      }

      store.setCurrentOcrJob({
        imagePath: this.data.imagePath,
        rawText: result.rawText || '',
        drafts: result.drafts || [],
        source: result.source || 'cloud-function',
        imageFileID: uploadRes.fileID
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
        content: '真实 OCR 还没完全跑通，先回退到演示识别结果，保证你能继续看流程。',
        confirmText: '继续',
        showCancel: false,
        success: () => {
          this.runMockRecognition()
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
