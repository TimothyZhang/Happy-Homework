const CLOUD_ENV_ID = 'cloud1-d8gkzu6ls85efd509'
const cloudSync = require('./utils/cloud-sync')

App({
  // Cross-page signals. `petAnimQueue` is set by the home page when a task
  // finishes and consumed by the pet page on its next onShow (see
  // V1-PET-ANIMATION-SPEC §4). Plain object — keep small.
  globalData: { petAnimQueue: null },

  onLaunch() {
    if (typeof wx.cloud !== 'undefined') {
      wx.cloud.init({
        env: CLOUD_ENV_ID,
        traceUser: true
      })
      // Async hydrate from cloud. Errors are swallowed inside cloud-sync; this
      // never blocks UI. The first tab's onShow will repaint if the pulled
      // state differs from local.
      cloudSync.hydrate().catch((e) => console.warn('[app] hydrate failed', e))
    }
  }
})
