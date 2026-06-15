const CLOUD_ENV_ID = 'cloud1-d8gkzu6ls85efd509'
const cloudSync = require('./utils/cloud-sync')
const store = require('./utils/store')
const loginLog = require('./utils/login-log')

App({
  // Cross-page signals. `petAnimQueue` is set by the home page when a task
  // finishes and consumed by the pet page on its next onShow (see
  // V1-PET-ANIMATION-SPEC §4). Plain object — keep small.
  globalData: { petAnimQueue: null },

  onLaunch(options) {
    const t0 = Date.now()
    // Warm the state cache before any page renders. loadState() does a
    // blocking wx.getStorageSync + JSON.parse + migrateState; pushing it into
    // app launch shifts that cost off the first tab's onShow critical path,
    // so the first page render no longer waits on storage I/O.
    store.getUpdatedAt()
    console.log(`[perf] onLaunch state warm: ${Date.now() - t0}ms`)

    if (typeof wx.cloud !== 'undefined') {
      wx.cloud.init({
        env: CLOUD_ENV_ID,
        traceUser: true
      })
      // Async hydrate from cloud. Errors are swallowed inside cloud-sync; this
      // never blocks UI. The first tab's onShow will repaint if the pulled
      // state differs from local.
      cloudSync.hydrate().catch((e) => console.warn('[app] hydrate failed', e))
      // 记一条登录日志(冷启动一次,best-effort,不阻塞)。放微任务里推迟到
      // cloud.init 之后执行,避免和首屏渲染抢主线程。
      Promise.resolve().then(() => loginLog.recordLogin(options && options.scene))
    }
  }
})
