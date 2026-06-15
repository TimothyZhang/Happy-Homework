// 本机「设备 + 版本」信息,缓存一次(启动后不变)。
// 同步时把它随 state 一起写到云端 doc.writer,这样另一台设备拉数据时能看出
// 「云端这份是谁、什么版本、什么时候写的」;本机侧也用它显示「本地数据的版本」。
const buildInfo = require('./build-info')

let _cache = null

function get() {
  if (_cache) return _cache
  let envVersion = ''
  let model = ''
  let platform = ''
  let brand = ''
  try {
    const a = wx.getAccountInfoSync && wx.getAccountInfoSync()
    envVersion = (a && a.miniProgram && a.miniProgram.envVersion) || ''   // develop/trial/release
  } catch (e) {}
  try {
    const s = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {}
    model = s.model || ''
    platform = s.platform || ''
    brand = s.brand || ''
  } catch (e) {}
  _cache = {
    envVersion,
    buildVersion: (buildInfo && buildInfo.version) || '',
    model,
    brand,
    platform
  }
  return _cache
}

module.exports = { get }
