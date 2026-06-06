// Pet-bubble tip helpers for pages/home. Pulled into its own module so the
// pure formatters can be exercised by scripts/values-check.js without having
// to mock the Page() shell.

const store = require('./store')
const i18n = require('./i18n')

// Internal helper: "1 小时 20 分" / "30 分" / "1 小时" / "不到 1 分"(随语言).
function formatSpentTime(totalMinutes) {
  if (!totalMinutes || totalMinutes < 1) return i18n.t('ht_spent_lt1')
  if (totalMinutes < 60) return i18n.t('ht_spent_min', { n: totalMinutes })
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  if (m === 0) return i18n.t('ht_spent_hr', { h })
  return i18n.t('ht_spent_hrmin', { h, m })
}

// Used by the home page to format "still N tasks left" / "all done!" copy.
function formatDuration(minutes) {
  if (!minutes || minutes < 0) return '—'
  if (minutes < 60) return i18n.t('ht_dur_min', { n: minutes })
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (m === 0) return i18n.t('ht_dur_hr', { h })
  return i18n.t('ht_dur_hrmin', { h, m })
}

function buildPetMessage(ctx) {
  const { isToday, totalCount, pendingCount, remainingMinutes, coinsToday, totalDoneMinutes } = ctx
  const timeStr = remainingMinutes > 0 ? formatDuration(remainingMinutes) : ''

  if (isToday) {
    if (totalCount === 0) return i18n.t('ht_today_none')
    if (pendingCount === 0) {
      // All-done celebration — fold time + coins into the one line so the
      // bubble doesn't need a separate stats tip.
      if (totalDoneMinutes >= 1 && coinsToday > 0) {
        return i18n.t('ht_alldone_time_coin', { time: formatSpentTime(totalDoneMinutes), coins: coinsToday })
      }
      if (coinsToday > 0) {
        return i18n.t('ht_alldone_coin', { coins: coinsToday })
      }
      return i18n.t('ht_alldone')
    }
    if (pendingCount === 1) {
      return timeStr
        ? i18n.t('ht_last_one_time', { time: timeStr })
        : i18n.t('ht_last_one')
    }
    if (timeStr) {
      return i18n.t('ht_pending_time', { n: pendingCount, time: timeStr })
    }
    return i18n.t('ht_pending', { n: pendingCount })
  }

  if (totalCount === 0) return i18n.t('ht_other_none')
  if (pendingCount === 0) return i18n.t('ht_other_alldone', { n: totalCount })
  return i18n.t('ht_other_pending', { n: pendingCount })
}

// Rotating pet-bubble tip list. First entry is always the contextual progress
// message (`buildPetMessage`). All-done 分支不再 push 第二条 stats tip —— 时长
// + 金币的信息已经被 buildPetMessage 合进 celebration 那一行。Pending 分支照旧
// 追加 early-bird projection + 开心度提示。
function buildPetTips(ctx) {
  const tips = [buildPetMessage(ctx)]
  if (!ctx.isToday || ctx.pendingCount === 0) return tips
  const b = store.earlyBirdBonus()
  if (b >= 50 && ctx.projected19 > 0) tips.push(i18n.t('ht_tip_19', { n: ctx.projected19 }))
  if (b >= 30 && ctx.projected20 > 0) tips.push(i18n.t('ht_tip_20', { n: ctx.projected20 }))
  if (b >= 20 && ctx.projected21 > 0) tips.push(i18n.t('ht_tip_21', { n: ctx.projected21 }))
  tips.push(i18n.t('ht_tip_happiness'))
  return tips
}

module.exports = {
  formatSpentTime,
  formatDuration,
  buildPetMessage,
  buildPetTips
}
