const store = require('../../utils/store')

// kind → 显示文案 + emoji。覆盖 applyCoinDelta 写入的所有 kind;
// applyAdminCoinClaim 走 admin-adjust:* 路径,在 describeLog 里特判。
const KIND_LABELS = {
  task_reward: { label: '完成作业', emoji: '📚' },
  task_refund: { label: '撤销退款', emoji: '↩️' },
  pet_purchase: { label: '宠物商店', emoji: '🛒' },
  pet_skin_switch: { label: '更换宠物', emoji: '🔄' },
  perfect_day_clawback_skipped: { label: '审计跳过', emoji: '⚠️' }
}

const REFUND_REASONS = {
  perfect_day_clawback: '撤销完美日奖励',
  task_revert: '撤销已完成作业'
}

const REWARD_KIND_LABELS = {
  today: '当天完成',
  overdue: '补做过期',
  future: '提前完成'
}

const SPECIES_LABELS = {
  cat: '猫', dog: '狗', chicken: '鸡', parrot: '鹦鹉',
  pig: '猪', cow: '牛', rabbit: '兔子', sheep: '羊', alpaca: '羊驼'
}

function pad2(n) { return `${n}`.padStart(2, '0') }

function formatTime(ts, todayStartMs, yesterdayStartMs) {
  if (!ts) return ''
  const d = new Date(ts)
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  if (dayStart === todayStartMs) return `今天 ${hm}`
  if (dayStart === yesterdayStartMs) return `昨天 ${hm}`
  const now = new Date()
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
  }
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${hm}`
}

function describeLog(log) {
  // admin 后台调整走老格式:reason: 'admin-adjust:xxx',没 kind/balanceAfter。
  if (log && typeof log.reason === 'string' && log.reason.indexOf('admin-adjust:') === 0) {
    const tail = log.reason.slice('admin-adjust:'.length).trim()
    return { title: '管理员调整', sub: tail || '系统调整', emoji: '🛠️' }
  }
  const kind = log.kind || ''
  const meta = log.meta || {}
  const def = KIND_LABELS[kind]
  const emoji = def ? def.emoji : '💰'
  const title = def ? def.label : (kind || '金币变动')
  let sub = ''
  if (kind === 'task_reward') {
    const parts = []
    if (meta.rewardKind && REWARD_KIND_LABELS[meta.rewardKind]) {
      parts.push(REWARD_KIND_LABELS[meta.rewardKind])
    }
    const single = Number(meta.taskReward) || 0
    const bonus = (Number(meta.dailyBonus) || 0) + (Number(meta.weeklyBonus) || 0)
    if (single > 0) parts.push(`单题 +${single}`)
    if (bonus > 0) parts.push(`完美日 +${bonus}`)
    sub = parts.join(' · ')
  } else if (kind === 'task_refund') {
    sub = REFUND_REASONS[meta.reason] || '退款'
  } else if (kind === 'pet_purchase') {
    sub = meta.itemName || '道具'
  } else if (kind === 'pet_skin_switch') {
    const to = SPECIES_LABELS[meta.toSpecies] || meta.toSpecies || ''
    sub = to ? `换成${to}` : '更换宠物'
  } else if (kind === 'perfect_day_clawback_skipped') {
    sub = meta.day ? `${meta.day} 守卫跳过` : '守卫跳过'
  }
  return { title, sub, emoji }
}

Page({
  data: {
    coins: 0,
    logs: []
  },

  onLoad() { this.refresh() },
  onShow() { this.refresh() },

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
          balanceAfter: typeof log.balanceAfter === 'number' ? log.balanceAfter : null
        }
      })
    this.setData({ coins: state.coins || 0, logs: list })
  }
})
