function switchTab(url) {
  wx.switchTab({
    url,
    fail() {
      wx.navigateTo({ url })
    }
  })
}

module.exports = {
  switchTab
}
