// 登录日志(客户端侧)。
// 每次冷启动调一次 adminPanel.logLogin,把「设备 + 版本(体验/正式/开发)+ cloud-sync
// 设备会话 id」记到云端。设置页看自己的,admin 看任意用户的。
// 纯 best-effort:没云能力 / 调用失败都静默,绝不阻塞启动。
const buildInfo = require('./build-info')
const cloudSync = require('./cloud-sync')

let _loggedThisLaunch = false

function safeSysInfo() {
  try { return wx.getSystemInfoSync() || {} } catch (e) { return {} }
}

// develop(开发版)/ trial(体验版)/ release(正式版)—— 多版本并存正是丢数据根因,
// 把它记下来最有诊断价值。
function getEnvVersion() {
  try {
    const acc = wx.getAccountInfoSync && wx.getAccountInfoSync()
    return (acc && acc.miniProgram && acc.miniProgram.envVersion) || ''
  } catch (e) { return '' }
}

function recordLogin(scene) {
  if (_loggedThisLaunch) return
  if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.callFunction) return
  _loggedThisLaunch = true
  const sys = safeSysInfo()
  let sessionId = ''
  try { sessionId = (cloudSync.getDeviceSessionId && cloudSync.getDeviceSessionId()) || '' } catch (e) {}
  const device = {
    brand: sys.brand || '',
    model: sys.model || '',
    system: sys.system || '',
    platform: sys.platform || '',
    sdkVersion: sys.SDKVersion || '',
    sessionId,
    clientAt: Date.now(),
    scene: Number(scene) || 0
  }
  const version = {
    envVersion: getEnvVersion(),
    buildVersion: (buildInfo && buildInfo.version) || ''
  }
  wx.cloud.callFunction({ name: 'adminPanel', data: { action: 'logLogin', device, version } })
    .catch((e) => console.warn('[login-log] record failed', e && e.errMsg))
}

module.exports = { recordLogin }
