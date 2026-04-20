const store = require('../../utils/store')

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
    this.setData({ imagePath: '/assets/mock-homework-register.jpg' })
    wx.showToast({ title: '已载入演示数据', icon: 'none' })
  },

  handleStartRecognize() {
    if (!this.data.imagePath) {
      wx.showToast({ title: '先选择一张登记本照片', icon: 'none' })
      return
    }

    this.setData({ isRecognizing: true })

    if (!this.data.canUseCloud) {
      this.runMockRecognition()
      return
    }

    // 下一步：这里接 wx.cloud.uploadFile + wx.cloud.callFunction
    // 现在先保留到 mock fallback，确保流程继续可用。
    this.runMockRecognition()
  },

  runMockRecognition() {
    
    setTimeout(() => {
      store.setCurrentOcrJob({
        imagePath: this.data.imagePath,
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
