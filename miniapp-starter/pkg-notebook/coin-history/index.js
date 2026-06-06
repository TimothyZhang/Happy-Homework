const store = require('../../utils/store')
const i18n = require('../../utils/i18n')

// kind → 显示文案 + emoji。覆盖 applyCoinDelta 写入的所有 kind。
// admin_adjust 是新架构的入账 kind;legacy 老 admin 流水(没 kind,带
// reason='admin-adjust:xxx')在 describeLog 里另走兼容分支。
function KIND_LABELS() {
  return {
    task_reward: { label: i18n.t('coin_kind_task_reward'), emoji: '📚' },
    task_refund: { label: i18n.t('coin_kind_task_refund'), emoji: '↩️' },
    pet_purchase: { label: i18n.t('coin_kind_pet_purchase'), emoji: '🛒' },
    pet_skin_switch: { label: i18n.t('coin_kind_pet_skin_switch'), emoji: '🔄' },
    share_reward: { label: i18n.t('coin_kind_share_reward'), emoji: '🎁' },
    admin_adjust: { label: i18n.t('coin_kind_admin_adjust'), emoji: '🛠️' },
    perfect_day_clawback_skipped: { label: i18n.t('coin_kind_audit_skip'), emoji: '⚠️' }
  }
}

function REFUND_REASONS() {
  return {
    perfect_day_clawback: i18n.t('coin_refund_perfect_day'),
    task_revert: i18n.t('coin_refund_task_revert')
  }
}

function REWARD_KIND_LABELS() {
  return {
    today: i18n.t('coin_reward_today'),
    overdue: i18n.t('coin_reward_overdue'),
    future: i18n.t('coin_reward_future')
  }
}

function SPECIES_LABELS() {
  return {
    cat: i18n.t('coin_species_cat'),
    dog: i18n.t('coin_species_dog'),
    chicken: i18n.t('coin_species_chicken'),
    parrot: i18n.t('coin_species_parrot'),
    pig: i18n.t('coin_species_pig'),
    cow: i18n.t('coin_species_cow'),
    rabbit: i18n.t('coin_species_rabbit'),
    sheep: i18n.t('coin_species_sheep'),
    alpaca: i18n.t('coin_species_alpaca')
  }
}

function pad2(n) { return `${n}`.padStart(2, '0') }

function formatTime(ts, todayStartMs, yesterdayStartMs) {
  if (!ts) return ''
  const d = new Date(ts)
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  if (dayStart === todayStartMs) return i18n.t('coin_time_today', { hm })
  if (dayStart === yesterdayStartMs) return i18n.t('coin_time_yesterday', { hm })
  const now = new Date()
  if (d.getFullYear() === now.getFullYear()) {
    return i18n.t('coin_time_this_year', { mo: d.getMonth() + 1, day: d.getDate(), hm })
  }
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${hm}`
}

function describeLog(log) {
  // admin 后台调整走老格式:reason: 'admin-adjust:xxx',没 kind/balanceAfter。
  if (log && typeof log.reason === 'string' && log.reason.indexOf('admin-adjust:') === 0) {
    const tail = log.reason.slice('admin-adjust:'.length).trim()
    return { title: i18n.t('coin_kind_admin_adjust'), sub: tail || i18n.t('coin_sub_sys_adjust'), emoji: '🛠️' }
  }
  const kind = log.kind || ''
  const meta = log.meta || {}
  const kindLabels = KIND_LABELS()
  const def = kindLabels[kind]
  const emoji = def ? def.emoji : '💰'
  const title = def ? def.label : (kind || i18n.t('coin_sub_coin_delta'))
  const rewardKindLabels = REWARD_KIND_LABELS()
  const refundReasons = REFUND_REASONS()
  const speciesLabels = SPECIES_LABELS()
  let sub = ''
  if (kind === 'task_reward') {
    const parts = []
    if (meta.rewardKind && rewardKindLabels[meta.rewardKind]) {
      parts.push(rewardKindLabels[meta.rewardKind])
    }
    const single = Number(meta.taskReward) || 0
    const bonus = (Number(meta.dailyBonus) || 0) + (Number(meta.weeklyBonus) || 0)
    if (single > 0) parts.push(i18n.t('coin_sub_single', { n: single }))
    if (bonus > 0) parts.push(i18n.t('coin_sub_perfect_day', { n: bonus }))
    sub = parts.join(' · ')
  } else if (kind === 'task_refund') {
    sub = refundReasons[meta.reason] || i18n.t('coin_sub_refund')
  } else if (kind === 'pet_purchase') {
    // 改名复用 pet_purchase kind(server 端不必新增 EVENT_RULES),meta.type='rename'。
    if (meta.type === 'rename') {
      const oldN = meta.oldName || ''
      const newN = meta.newName || ''
      return {
        title: i18n.t('coin_kind_pet_rename'),
        sub: oldN && newN ? `${oldN} → ${newN}` : (newN || i18n.t('coin_sub_rename')),
        emoji: '✏️'
      }
    }
    // 道具名按 itemId 走 i18n(跟商店一致),老 log 缺 itemId 时回退到当时存的名字。
    let itemLabel = ''
    if (meta.itemId != null) {
      const k = 'pet_item_name_' + meta.itemId
      const v = i18n.t(k)
      if (v !== k) itemLabel = v
    }
    sub = itemLabel || meta.itemName || i18n.t('coin_sub_item')
  } else if (kind === 'pet_skin_switch') {
    const to = speciesLabels[meta.toSpecies] || meta.toSpecies || ''
    sub = to ? i18n.t('coin_sub_switch_to', { to }) : i18n.t('coin_kind_pet_skin_switch')
  } else if (kind === 'share_reward') {
    const n = Number(meta.count) || 0
    sub = n > 1 ? i18n.t('coin_sub_friends_saved', { n }) : (n === 1 ? i18n.t('coin_sub_friend_saved') : i18n.t('coin_kind_share_reward'))
  } else if (kind === 'admin_adjust') {
    sub = (meta.reason || '').toString() || i18n.t('coin_sub_sys_adjust')
  } else if (kind === 'perfect_day_clawback_skipped') {
    sub = meta.day ? i18n.t('coin_sub_guard_skip_day', { day: meta.day }) : i18n.t('coin_sub_guard_skip')
  }
  return { title, sub, emoji }
}

Page({
  data: {
    coins: 0,
    logs: []
  },

  onLoad() { this.refresh() },
  onShow() {
    this.setData({ t: i18n.dict() })
    wx.setNavigationBarTitle({ title: i18n.t('coin_navtitle') })
    this.refresh()
  },

  refresh() {
    const state = store.getStateWithComputed()
    const raw = Array.isArray(state.coinLogs) ? state.coinLogs : []
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const yesterdayStart = todayStart - 24 * 60 * 60 * 1000
    const list = raw
      .slice()
      .sort((a, b) => (b.ts || b.at || 0) - (a.ts || a.at || 0))
      .map((log, idx) => {
        const ts = log.ts || log.at || 0
        const delta = Number(log.delta) || 0
        const d = describeLog(log)
        const deltaText = delta > 0 ? `+${delta}` : (delta < 0 ? `${delta}` : '0')
        const deltaClass = delta > 0 ? 'positive' : (delta < 0 ? 'negative' : 'zero')
        return {
          key: log.eventId || `${ts}-${idx}`,
          title: d.title,
          sub: d.sub,
          emoji: d.emoji,
          deltaText,
          deltaClass,
          timeText: formatTime(ts, todayStart, yesterdayStart),
          balanceAfter: typeof log.balanceAfter === 'number' ? log.balanceAfter : null,
          balanceText: typeof log.balanceAfter === 'number' ? i18n.t('coin_balance_after', { n: log.balanceAfter }) : ''
        }
      })
    this.setData({ coins: state.coins || 0, logs: list })
  }
})
