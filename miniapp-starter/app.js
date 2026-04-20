App({
  onLaunch() {
    console.log('作业小管家 launched')

    if (typeof wx.cloud !== 'undefined') {
      wx.cloud.init({
        traceUser: true
      })
    }
  }
})
