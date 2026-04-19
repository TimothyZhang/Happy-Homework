Page({
  data: {
    title: '小程序已经建好了',
    status: '可直接在微信开发者工具中打开',
    nextSteps: [
      '补充业务页面',
      '接入接口和数据',
      '做视觉和交互打磨'
    ]
  },
  handlePrimaryAction() {
    wx.showToast({
      title: '骨架运行正常',
      icon: 'success'
    })
  }
})
