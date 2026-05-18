const cloudSync = require('../../utils/cloud-sync')
const store = require('../../utils/store')
const perf = require('../../utils/perf')
const buildInfo = require('../../utils/build-info')

const AVATAR_CLOUD_PATH_PREFIX = 'avatars'

Page({
  data: {
    profile: { nickname: '', avatar: '' },
    uploadingAvatar: false,
    canUseCloud: typeof wx.cloud !== 'undefined',
    syncStatus: { status: 'unknown', readOnly: false, lastSyncDisplay: '从未', lastError: null, inflight: false },
    syncing: false,
    // admin 入口可见性。whoami 返回 isAdmin=true 才渲染管理后台卡片。
    isAdmin: false,
    adminCheckDone: false,
    // 用户自定义的组织标签列表(在 task-edit 下拉里出现)。
    organizations: [],
    orgMaxLen: store.ORGANIZATION_MAX_LEN,
    orgMaxCount: store.ORGANIZATION_MAX_COUNT,
    newOrgInput: '',
    // 版本号 + commit id。build-info 由 scripts/write-build-info.js 在
    // upload 前生成 —— 本地开发(没跑过 script)显示 dev/unknown。
    buildVersion: buildInfo.version || 'dev',
    buildCommitId: buildInfo.commitId || 'unknown'
  },

  onShow() {
    const stamp = perf.markPageShow('profile')
    const tb = typeof this.getTabBar === 'function' && this.getTabBar()
    if (tb) tb.setData({ selected: 3 })
    this.setData({
      profile: store.getProfile(),
      organizations: store.getOrganizations(),
      syncStatus: cloudSync.getSyncStatus()
    }, () => perf.markPaint(stamp))
    cloudSync.hydrateIfStale().then(() => {
      this.setData({
        profile: store.getProfile(),
        organizations: store.getOrganizations()
      })
      this.refreshSyncStatus()
    }).catch(() => {})
    // admin 身份每次 onShow 都检查一次:权限变化能及时反映。
    this.checkAdmin()
  },

  async checkAdmin() {
    if (!this.data.canUseCloud) {
      this.setData({ isAdmin: false, adminCheckDone: true })
      return
    }
    try {
      const res = await wx.cloud.callFunction({
        name: 'adminPanel',
        data: { action: 'whoami' }
      })
      const r = (res && res.result) || {}
      this.setData({
        isAdmin: !!r.isAdmin,
        adminCheckDone: true
      })
    } catch (e) {
      // 云函数没部署 / 不存在 — 静默隐藏入口,不打扰普通用户。
      console.warn('[profile] adminPanel whoami failed', e)
      this.setData({ isAdmin: false, adminCheckDone: true })
    }
  },

  handleOpenAdmin() {
    wx.navigateTo({ url: '/pages/admin/index' })
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
      // confirmText/cancelText must be ≤4 chars — longer values silently fail
      // to render the modal on some basic library versions, leaving the user
      // staring at an unresponsive button.
      confirmText: '用此设备',
      cancelText: '取消',
      success: async (r) => {
        if (!r.confirm) return
        this.setData({ syncing: true })
        try {
          const ok = await cloudSync.reclaim()
          this.refreshSyncStatus()
          this.setData({ profile: store.getProfile() })
          if (ok) {
            wx.showToast({ title: '已切回此设备', icon: 'success', duration: 2000 })
          } else {
            // Surface lastError so silent failures (network blip, schema rejection)
            // give the user a hint rather than a bare "切回失败".
            const status = cloudSync.getSyncStatus()
            wx.showToast({
              title: '切回失败' + (status.lastError ? '：' + status.lastError : ''),
              icon: 'none',
              duration: 2400
            })
          }
        } catch (e) {
          console.warn('[profile] reclaim threw', e)
          wx.showToast({
            title: '切回出错：' + ((e && e.errMsg) || e || '未知错误'),
            icon: 'none',
            duration: 2400
          })
        } finally {
          this.setData({ syncing: false })
        }
      },
      fail: (err) => {
        console.warn('[profile] reclaim modal failed', err)
        wx.showToast({
          title: '弹窗打开失败：' + ((err && err.errMsg) || '未知错误'),
          icon: 'none',
          duration: 2400
        })
      }
    })
  },

  // === Organization tag management === //

  handleOrgInput(e) {
    this.setData({ newOrgInput: e.detail.value })
  },

  handleAddOrg() {
    const name = (this.data.newOrgInput || '').trim()
    if (!name) {
      wx.showToast({ title: '请输入标签名', icon: 'none' })
      return
    }
    const res = store.addOrganization(name)
    if (!res.ok) {
      wx.showToast({ title: this.orgErrorMessage(res.reason), icon: 'none' })
      return
    }
    this.setData({
      organizations: store.getOrganizations(),
      newOrgInput: ''
    })
    wx.showToast({ title: '已添加', icon: 'success' })
  },

  handleRemoveOrg(e) {
    const name = e.currentTarget.dataset.name
    if (!name) return
    wx.showModal({
      title: `删除「${name}」？`,
      content: '已用该标签的作业仍保留显示，仅在下次选择时不再出现。',
      confirmColor: '#e54545',
      confirmText: '删除',
      cancelText: '取消',
      success: (r) => {
        if (!r.confirm) return
        const res = store.removeOrganization(name)
        if (!res.ok) {
          wx.showToast({ title: this.orgErrorMessage(res.reason), icon: 'none' })
          return
        }
        this.setData({ organizations: store.getOrganizations() })
        wx.showToast({ title: '已删除', icon: 'success' })
      }
    })
  },

  handleRenameOrg(e) {
    const name = e.currentTarget.dataset.name
    if (!name) return
    wx.showModal({
      title: `重命名「${name}」`,
      editable: true,
      placeholderText: '新标签名',
      content: name,
      confirmText: '保存',
      cancelText: '取消',
      success: (r) => {
        if (!r.confirm) return
        const next = (r.content || '').trim()
        if (!next) {
          wx.showToast({ title: '请输入新标签名', icon: 'none' })
          return
        }
        if (next === name) return
        const res = store.renameOrganization(name, next)
        if (!res.ok) {
          wx.showToast({ title: this.orgErrorMessage(res.reason), icon: 'none' })
          return
        }
        this.setData({ organizations: store.getOrganizations() })
        wx.showToast({ title: '已重命名', icon: 'success' })
      }
    })
  },

  handleResetOrgs() {
    wx.showModal({
      title: '恢复默认标签？',
      content: '会重置为「校内 / 校外 / 其他」。已存在的作业标签不变。',
      confirmText: '恢复',
      cancelText: '取消',
      success: (r) => {
        if (!r.confirm) return
        store.resetOrganizations()
        this.setData({ organizations: store.getOrganizations() })
        wx.showToast({ title: '已恢复默认', icon: 'success' })
      }
    })
  },

  orgErrorMessage(reason) {
    switch (reason) {
      case 'empty':     return '请输入标签名'
      case 'too_long':  return `标签最长 ${store.ORGANIZATION_MAX_LEN} 字`
      case 'duplicate': return '该标签已存在'
      case 'too_many':  return `最多 ${store.ORGANIZATION_MAX_COUNT} 个标签`
      case 'last_one':  return '至少保留一个标签'
      case 'unknown':   return '标签不存在'
      case 'noop':      return ''
      default:          return '操作失败'
    }
  }
})
