const CLOUD_ENV_ID = 'cloud1-d8gkzu6ls85efd509'

App({
  onLaunch() {
    console.log('作业小管家 launched')

    if (typeof wx.cloud !== 'undefined') {
      wx.cloud.init({
        env: CLOUD_ENV_ID,
        traceUser: true
      })
    }
  }
})
