// 文字转语音(TTS)+ 本地缓存。
// 用微信官方「同声传译」插件(WechatSI)合成,把合成出来的音频复制到
// USER_DATA_PATH 持久缓存:重听 / 再次遇到同一个词,直接播缓存,不重复合成。
// 插件没在后台开通时,getPlugin 返回 null,ttsAvailable() = false,调用方降级。

let _plugin = null
let _pluginTried = false
function getPlugin() {
  if (_pluginTried) return _plugin
  _pluginTried = true
  try { _plugin = requirePlugin('WechatSI') } catch (e) { _plugin = null }
  return _plugin
}

const CACHE_KEY = 'tts_cache_v1'
const CACHE_DIR = (wx.env && wx.env.USER_DATA_PATH ? wx.env.USER_DATA_PATH : '') + '/tts'
const fsm = wx.getFileSystemManager ? wx.getFileSystemManager() : null

let _index = null     // 持久索引 { key: filePath }
const _mem = {}       // 本次会话内存缓存 key -> filePath
let _audio = null
let _dirReady = false

function loadIndex() {
  if (_index) return _index
  try { _index = wx.getStorageSync(CACHE_KEY) || {} } catch (e) { _index = {} }
  if (!_index || typeof _index !== 'object') _index = {}
  return _index
}
function saveIndex() { try { wx.setStorageSync(CACHE_KEY, _index) } catch (e) {} }
function ensureDir() {
  if (_dirReady || !fsm) return
  try { fsm.accessSync(CACHE_DIR) } catch (e) { try { fsm.mkdirSync(CACHE_DIR, true) } catch (e2) {} }
  _dirReady = true
}
function fileExists(p) { if (!fsm || !p) return false; try { fsm.accessSync(p); return true } catch (e) { return false } }
function safeKey(lang, text) {
  return lang + '_' + String(text).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48)
}

function getAudio() {
  if (!_audio) {
    _audio = wx.createInnerAudioContext()
    _audio.obeyMuteSwitch = false   // 静音键下也能出声(背单词需要听见)
  }
  return _audio
}
function playFile(path) {
  const a = getAudio()
  try { a.stop() } catch (e) {}
  a.src = path
  a.play()
}

// 合成 / 取缓存 / 播放。text 文本,lang 'en_US' | 'zh_CN'。cb(ok, reason)。
function speak(text, lang, cb) {
  const t = (text || '').trim()
  if (!t) { if (cb) cb(false, 'empty'); return }
  lang = lang || 'en_US'
  const key = safeKey(lang, t)

  if (_mem[key] && fileExists(_mem[key])) { playFile(_mem[key]); if (cb) cb(true); return }
  const idx = loadIndex()
  if (idx[key] && fileExists(idx[key])) { _mem[key] = idx[key]; playFile(idx[key]); if (cb) cb(true); return }

  const plugin = getPlugin()
  if (!plugin || !plugin.textToSpeech) { if (cb) cb(false, 'no-plugin'); return }
  plugin.textToSpeech({
    lang: lang, tts: true, content: t,
    success: (res) => {
      const src = res && res.filename
      if (!src) { if (cb) cb(false, 'no-file'); return }
      if (!fsm) { _mem[key] = src; playFile(src); if (cb) cb(true); return }
      ensureDir()
      const dest = CACHE_DIR + '/' + key + '.mp3'
      fsm.copyFile({
        srcPath: src, destPath: dest,
        success: () => { idx[key] = dest; saveIndex(); _mem[key] = dest; playFile(dest); if (cb) cb(true) },
        fail: () => { _mem[key] = src; playFile(src); if (cb) cb(true) }   // 复制失败也先播临时文件
      })
    },
    fail: () => { if (cb) cb(false, 'tts-fail') }
  })
}

function ttsAvailable() { const p = getPlugin(); return !!(p && p.textToSpeech) }

function stop() { if (_audio) { try { _audio.stop() } catch (e) {} } }

module.exports = { speak, ttsAvailable, stop }
