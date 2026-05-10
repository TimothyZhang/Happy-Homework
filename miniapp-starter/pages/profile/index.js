const cloudSync = require('../../utils/cloud-sync')
const store = require('../../utils/store')

const AVATAR_CLOUD_PATH_PREFIX = 'avatars'

Page({
  data: {
    profile: { nickname: '', avatar: '' },
    uploadingAvatar: false,
    canUseCloud: typeof wx.cloud !== 'undefined',
    syncStatus: { status: 'unknown', readOnly: false, lastSyncDisplay: '从未', lastError: null, inflight: false },
    syncing: false
  },

  onShow() {
    const tb = typeof this.getTabBar === 'function' && this.getTabBar()
    if (tb) tb.setData({ selected: 4 })
    this.setData({ profile: store.getProfile() })
    this.refreshSyncStatus()
    cloudSync.hydrateIfStale().then(() => {
      this.setData({ profile: store.getProfile() })
      this.refreshSyncStatus()
    }).catch(() => {})
  },

  refreshSyncStatus() {
    this.setData({ syncStatus: cloudSync.getSyncStatus() })
  },

  // === Nickname === //

  // type="nickname" emits a final input event when the user picks the WeChat
  // nickname; commit on blur so we don't push to cloud on every keystroke.
  handleNicknameInput(e) {
    this.setData({ 'profile.nickname': e.detail.value })
  },

  handleNicknameBlur(e) {
    const value = (e.detail.value || '').trim()
    if (value === (this.data.profile.nickname || '').trim() &&
        value === ((store.getProfile().nickname) || '').trim()) {
      return
    }
    store.updateProfileNickname(value)
    this.setData({ profile: store.getProfile() })
  },

  // === Avatar === //

  handleEditAvatar() {
    if (this.data.uploadingAvatar) return
    wx.showActionSheet({
      itemList: ['拍照', '从相册选'],
      success: (res) => {
        const sourceType = res.tapIndex === 0 ? 'camera' : 'album'
        this.pickAndUploadAvatar(sourceType)
      },
      fail: () => {}
    })
  },

  async pickAndUploadAvatar(sourceType) {
    if (!this.data.canUseCloud) {
      wx.showToast({ title: '云存储未启用，无法上传头像', icon: 'none', duration: 2400 })
      return
    }
    let tempPath = ''
    try {
      const res = await wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: [sourceType],
        sizeType: ['compressed']
      })
      const file = res && res.tempFiles && res.tempFiles[0]
      if (!file || !file.tempFilePath) return
      tempPath = file.tempFilePath
    } catch (e) {
      // user canceled, or camera/album denied — chooseMedia rejects on cancel
      return
    }

    this.setData({ uploadingAvatar: true })
    wx.showLoading({ title: '上传中…', mask: true })
    try {
      let toUpload = tempPath
      try {
        const c = await wx.compressImage({ src: tempPath, quality: 70 })
        toUpload = (c && c.tempFilePath) || tempPath
      } catch (e) {
        console.warn('compressImage failed, fallback to original', e)
      }

      const ext = ((toUpload.match(/\.([a-zA-Z0-9]+)(?:\?|$)/) || [, 'jpg'])[1] || 'jpg').toLowerCase()
      const cloudPath = `${AVATAR_CLOUD_PATH_PREFIX}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
      const uploadRes = await wx.cloud.uploadFile({ cloudPath, filePath: toUpload })
      if (!uploadRes || !uploadRes.fileID) {
        throw new Error('NO_FILE_ID')
      }
      store.updateProfileAvatar(uploadRes.fileID)
      this.setData({ profile: store.getProfile() })
      wx.hideLoading()
      wx.showToast({ title: '头像已更新', icon: 'success' })
    } catch (e) {
      wx.hideLoading()
      console.error('avatar upload failed', e)
      wx.showToast({
        title: this.getAvatarFailureMessage(e),
        icon: 'none',
        duration: 2400
      })
    } finally {
      this.setData({ uploadingAvatar: false })
    }
  },

  getAvatarFailureMessage(error) {
    const code = String((error && error.errCode) || (error && error.code) || '')
    const msg = String((error && error.errMsg) || (error && error.message) || '')
    if (msg.includes('storage_size_limit')) return '云存储空间不足，无法上传头像'
    if (msg.includes('exceed_max') || msg.includes('size limit')) return '图片过大，换一张再试'
    if (msg.includes('network') || msg.includes('timeout')) return '网络不稳定，稍后再试'
    if (code === 'NO_FILE_ID') return '上传完成但没拿到 fileID，稍后再试'
    return '头像上传失败，请重试'
  },

  // === Sync === //

  async handleForceSync() {
    if (this.data.syncing) return
    this.setData({ syncing: true })
    try {
      await cloudSync.forceSync()
      const status = cloudSync.getSyncStatus()
      this.setData({ syncStatus: status, profile: store.getProfile() })
      if (status.lastError) {
        wx.showToast({ title: '同步失败：' + status.lastError, icon: 'none', duration: 2400 })
      } else {
        wx.showToast({ title: '已同步', icon: 'success' })
      }
    } catch (e) {
      wx.showToast({ title: '同步出错', icon: 'none' })
    } finally {
      this.setData({ syncing: false })
    }
  },

  handleReclaim() {
    if (this.data.syncing) return
    wx.showModal({
      title: '切回此设备',
      content: '会以云端最新数据覆盖本机当前 state，并踢下线另一台设备。继续？',
      // confirmText/cancelText must be ≤4 chars on some basic library versions
      // — longer values silently fail to render the modal.
      confirmText: '切回',
      cancelText: '取消',
      success: async (r) => {
        if (!r.confirm) return
        this.setData({ syncing: true })
        try {
          const ok = await cloudSync.reclaim()
          this.refreshSyncStatus()
          this.setData({ profile: store.getProfile() })
          wx.showToast({
            title: ok ? '已切回此设备' : '切回失败',
            icon: ok ? 'success' : 'none'
          })
        } catch (e) {
          wx.showToast({ title: '切回出错', icon: 'none' })
        } finally {
          this.setData({ syncing: false })
        }
      }
    })
  }
})
