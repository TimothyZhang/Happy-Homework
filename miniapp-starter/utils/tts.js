// 文字转语音(TTS)+ 本地缓存。
// 调云函数 homeworkOCR(action:'tts')用 Azure OpenAI 合成,拿回 base64 mp3,
// 写到 USER_DATA_PATH 持久缓存:重听 / 再遇同一个词,直接播缓存,不重复合成。

const CACHE_KEY = 'tts_cache_v1'
const CACHE_DIR = (wx.env && wx.env.USER_DATA_PATH ? wx.env.USER_DATA_PATH : '') + '/tts'
const fsm = wx.getFileSystemManager ? wx.getFileSystemManager() : null

let _index = null      // 持久索引 { key: filePath }
const _mem = {}        // 本次会话内存缓存 key -> filePath
const _inflight = {}   // 同词并发去重 key -> true
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
function safeKey(text) {
  return 'en_' + String(text).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48)
}

function getAudio() {
  if (!_audio) {
    _audio = wx.createInnerAudioContext()
    _audio.obeyMuteSwitch = false   // 静音键下也出声(背单词需要听见)
  }
  return _audio
}
function playFile(path) {
  const a = getAudio()
  try { a.stop() } catch (e) {}
  a.src = path
  a.play()
}

// 合成 / 取缓存 / 播放。cb(ok, reason)。
function speak(text, lang, cb) {
  const t = (text || '').trim()
  if (!t) { if (cb) cb(false, 'empty'); return }
  const key = safeKey(t)

  if (_mem[key] && fileExists(_mem[key])) { playFile(_mem[key]); if (cb) cb(true); return }
  const idx = loadIndex()
  if (idx[key] && fileExists(idx[key])) { _mem[key] = idx[key]; playFile(idx[key]); if (cb) cb(true); return }

  if (!wx.cloud || !wx.cloud.callFunction) { if (cb) cb(false, 'no-cloud'); return }
  if (_inflight[key]) { if (cb) cb(false, 'inflight'); return }
  _inflight[key] = true
  wx.cloud.callFunction({
    name: 'homeworkOCR',
    data: { action: 'tts', text: t },
    success: (res) => {
      delete _inflight[key]
      const r = (res && res.result) || {}
      if (!r.ok || !r.audioBase64) { if (cb) cb(false, r.errorCode || 'tts-fail'); return }
      if (!fsm) { if (cb) cb(false, 'no-fs'); return }
      ensureDir()
      const dest = CACHE_DIR + '/' + key + '.mp3'
      fsm.writeFile({
        filePath: dest, data: r.audioBase64, encoding: 'base64',
        success: () => { idx[key] = dest; saveIndex(); _mem[key] = dest; playFile(dest); if (cb) cb(true) },
        fail: () => { if (cb) cb(false, 'write-fail') }
      })
    },
    fail: (e) => { delete _inflight[key]; if (cb) cb(false, (e && e.errMsg) || 'call-fail') }
  })
}

// 云可用就认为"可用"(真正能不能发声,首次 speak 失败时调用方再降级)。
function ttsAvailable() { return !!(wx.cloud && wx.cloud.callFunction) }

function stop() { if (_audio) { try { _audio.stop() } catch (e) {} } }

module.exports = { speak, ttsAvailable, stop }
