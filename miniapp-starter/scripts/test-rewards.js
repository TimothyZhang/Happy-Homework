'use strict'

// 奖励 / 金币流水回归测试。客户端 = truth 架构。覆盖:
//   - finishTask 单题奖、daily-perfect base、early-bird、weekly streak
//   - addTask / importSharedNotebook 触发的 perfectDay 回收(reconcilePerfectDays)
//   - revertTask 同时退单题奖 + 回收当日完美奖
//   - DAILY_COMPLETION_CAP 与回收循环交互
//   - 宠物 buyItem / 换皮 走 applyCoinDelta;levelUpPet 走 XP(不动金币)
//   - share / admin claim 走本地 applyCoinDelta 入账(coinLogs 记录)
//
// 何时跑:任何 store.js / cloud-sync.js 改动之后都要跑一遍。Tim 不测试,
// 这步是 claude 的责任:
//
//   node miniapp-starter/scripts/test-rewards.js
//
// 跑不通 → 改完再跑。失败要在汇报里如实写,不要"应该 OK"糊弄。
//
// 实现细节:stub 了 wx 的 storage 和 cloud 占位,store.js 在 Node 端能跑通
// 整个 updateState 路径。不连真实云数据库,测的是客户端逻辑 + coinLogs 流水。

global.wx = {
  _store: {},
  getStorageSync(k) { return this._store[k] || null },
  setStorageSync(k, v) { this._store[k] = v },
  removeStorageSync(k) { delete this._store[k] },
  getSystemInfoSync: () => ({}),
  cloud: { init: () => {}, callFunction: () => Promise.resolve({ result: {} }), database: () => null }
}

// Pin "now" to 22:00 so reward assertions don't drift with wall-clock time.
// 22:00 is past 21:00 → earlyBirdBonus = 0, simplifying expected math. Tests
// that need a specific tier (e.g. ≥+20 early-bird) call setNowHour() explicitly.
const _realDateNow = Date.now
function setNowHour(h, m) {
  const d = new Date()
  d.setHours(h, m || 0, 0, 0)
  const fixed = d.getTime()
  Date.now = () => fixed
}
setNowHour(22, 0)

const path = require('path')
const s = require(path.join(__dirname, '..', 'utils', 'store.js'))

let failed = 0
let passed = 0
function assert(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   -', name) }
  else { failed++; console.log('  FAIL -', name, detail ? `(${detail})` : '') }
}

function seed(stateOverride) {
  wx._store = {}
  s.applyHydratedState({
    coins: 0,
    streakDays: 0,
    perfectDays: [],
    bonusByDay: {},
    completionsByDay: {},
    coinLogs: [],
    tasks: [],
    notebooks: [],
    pet: null,
    lastReward: null,
    profile: null,
    ...stateOverride
  })
}

function st() { return s.getStateWithComputed() }
// 客户端 = truth 后,events 直接落 coinLogs,没有"pending 队列"概念。
function coinLogsLast(n) {
  const q = (st().coinLogs || []).slice(-n)
  return q.map((e) => ({ kind: e.kind, delta: e.delta, reason: e.meta && e.meta.reason }))
}

const today = s.todayStr()
const yesterday = s.addDays(today, -1)
const tomorrow = s.addDays(today, 1)

// ===== Scenario 1: legitimate happy path =====
console.log('\n[1] Happy path: 1-shot notebook with 3 tasks, all done in order')
const nb1 = { id: 'nb1', name: today, mode: 'one-shot', startDate: today, endDate: today, recurrence: null, createdAt: 1, order: 0 }
seed({ notebooks: [nb1], coins: 100 })
s.addTask({ notebookId: 'nb1', subject: '语', content: 'a', estimatedMinutes: 5 })
s.addTask({ notebookId: 'nb1', subject: '数', content: 'b', estimatedMinutes: 5 })
s.addTask({ notebookId: 'nb1', subject: '英', content: 'c', estimatedMinutes: 5 })
let tasks = st().tasks
s.finishTask(tasks[0].id, today)
s.finishTask(tasks[1].id, today)
const before3 = st().coins
s.finishTask(tasks[2].id, today)
const after3 = st().coins
assert('all done → perfectDays has today', st().perfectDays.length === 1 && st().perfectDays[0] === today)
assert('streakDays = 1', st().streakDays === 1)
assert('final reward includes daily bonus', after3 - before3 >= 10 + 30) // task + base ≥ 30
assert('all events are task_reward', coinLogsLast(3).every((e) => e.kind === 'task_reward'))

// ===== Scenario 2: exploit attempt — add 1 task, complete, add more =====
console.log('\n[2] Exploit attempt: 1 task → complete (perfect+early bird) → add 2 more')
// Pin to 18:00 for this scenario so early-bird tier kicks in (+50). Switch
// back to 22:00 at the end so subsequent scenarios run at the default tier.
setNowHour(18, 0)
seed({ notebooks: [nb1], coins: 100 })
s.addTask({ notebookId: 'nb1', subject: '语', content: 'x', estimatedMinutes: 5 })
let t = st().tasks[0]
s.finishTask(t.id, today)
const exploitFirstCoins = st().coins
const firstBonus = st().bonusByDay[today].dailyBonus
assert('first finish gets perfect + early bird', firstBonus >= 10 + 20 && st().perfectDays[0] === today, `dailyBonus=${firstBonus}`)

s.addTask({ notebookId: 'nb1', subject: '数', content: 'y', estimatedMinutes: 5 })
assert('addTask revokes perfectDays', st().perfectDays.length === 0)
assert('addTask drops streakDays back to 0', st().streakDays === 0)
assert('addTask clears bonusByDay[today]', !st().bonusByDay[today])
assert('coins clawed back via task_refund', st().coins === exploitFirstCoins - firstBonus)
assert('coinLogs tail = clawback', coinLogsLast(1)[0].kind === 'task_refund' && coinLogsLast(1)[0].reason === 'perfect_day_clawback')

// Add a third task; should NOT add a second refund event (already not-perfect).
const refundCountBefore = st().coinLogs.filter((e) => e.kind === 'task_refund').length
s.addTask({ notebookId: 'nb1', subject: '英', content: 'z', estimatedMinutes: 5 })
const refundCountAfter = st().coinLogs.filter((e) => e.kind === 'task_refund').length
assert('second addTask is no-op for revoke (not currently perfect)', refundCountAfter === refundCountBefore)

// Complete the remaining 2 → re-award daily bonus with new (3-task) base.
const t2 = st().tasks.find((x) => x.subject === '数')
const t3 = st().tasks.find((x) => x.subject === '英')
s.finishTask(t2.id, today)
const midCoins = st().coins
assert('first re-finish doesn\'t award daily bonus yet (1 of 2 remaining done)', st().perfectDays.length === 0)
s.finishTask(t3.id, today)
assert('after final re-finish, perfectDays restored', st().perfectDays[0] === today)
assert('streakDays back to 1', st().streakDays === 1)
const reCreditedBonus = st().bonusByDay[today].dailyBonus
assert('re-credited base = sum of 3 rewardPaid + early-bird ≥ original', reCreditedBonus >= firstBonus, `re=${reCreditedBonus} orig=${firstBonus}`)
assert('no double-credit: bonus log has only one entry per day', Object.keys(st().bonusByDay).length === 1)
// Restore default 22:00 (no early-bird) for downstream scenarios.
setNowHour(22, 0)

// ===== Scenario 3: future-day task should NOT revoke today =====
console.log('\n[3] Add task scheduled for tomorrow → today\'s perfect day intact')
seed({
  notebooks: [],
  coins: 200,
  perfectDays: [today],
  bonusByDay: { [today]: { dailyBonus: 60, weeklyBonus: 0, prevStreakDays: 0 } },
  streakDays: 1,
  tasks: [{
    id: 'tk_done', subject: '语', organization: '其他', content: 'old', estimatedMinutes: 5,
    mode: 'one-shot', startDate: today, endDate: today, recurrence: null,
    order: 0, createdAt: 1, status: 'done', accumulatedMs: 60000, completedAt: 2,
    actualMinutes: 1, currentSegmentStartedAt: null, rewardPaid: 10, rewardKind: 'today'
  }]
})
const baselineCoins = st().coins
s.addTask({ subject: '数', content: 'future', estimatedMinutes: 5, mode: 'one-shot', startDate: tomorrow, endDate: tomorrow })
assert('today\'s perfect day untouched', st().perfectDays[0] === today)
assert('coins not clawed back', st().coins === baselineCoins)
assert('streakDays stays 1', st().streakDays === 1)

// ===== Scenario 4: revertTask still works through ledger =====
console.log('\n[4] Revert a finished task → refund + revoke if it broke perfect')
seed({ notebooks: [nb1], coins: 100 })
s.addTask({ notebookId: 'nb1', subject: '语', content: 'only', estimatedMinutes: 5 })
const onlyId = st().tasks[0].id
s.finishTask(onlyId, today)
const afterFinish = st().coins
const dailyBonusAfter = st().bonusByDay[today].dailyBonus
s.revertTask(onlyId, today)
assert('revert wiped perfectDays', st().perfectDays.length === 0)
assert('revert clawed back per-task + bonus (net 0)', st().coins === afterFinish - 10 - dailyBonusAfter)
// Two refund events: one for per-task, one for perfect-day clawback.
const refundEvents = st().coinLogs.filter((e) => e.kind === 'task_refund').slice(-2)
assert('revert emitted task_refund (task_revert + perfect_day_clawback)',
  refundEvents.length === 2 &&
  refundEvents.some((e) => e.meta && e.meta.reason === 'task_revert') &&
  refundEvents.some((e) => e.meta && e.meta.reason === 'perfect_day_clawback'))

// ===== Scenario 4b: revertTask on an older perfect day → streakDays recomputed =====
// 之前的 bug:revokePerfectDay 直接 state.streakDays = log.prevStreakDays,
// 在用户回退一个非"最近"的 perfect 日时会把 streak 错写成那天被记入前的值。
// 修复后:从剩下的 perfectDays 重新算 trailing consecutive run。
console.log('\n[4b] Revert older perfect day → streakDays recomputed from remaining perfectDays')
const d1 = s.addDays(today, -3)
const d2 = s.addDays(today, -2)
const d3 = s.addDays(today, -1)
// 模拟一个 4 天 streak(d1→d2→d3→today),挑 d1(最早)那天 revert。
// 直接 seed perfectDays + bonusByDay + 一个 done 的 task 在 d1。
seed({
  notebooks: [nb1],
  coins: 1000,
  perfectDays: [d1, d2, d3, today],
  streakDays: 4,
  bonusByDay: {
    [d1]: { dailyBonus: 10, weeklyBonus: 0, prevStreakDays: 0 },
    [d2]: { dailyBonus: 10, weeklyBonus: 0, prevStreakDays: 1 },
    [d3]: { dailyBonus: 10, weeklyBonus: 0, prevStreakDays: 2 },
    [today]: { dailyBonus: 10, weeklyBonus: 0, prevStreakDays: 3 }
  },
  tasks: [{
    id: 'tk_d1', notebookId: 'nb1', subject: '语', content: 'old', estimatedMinutes: 5,
    order: 0, createdAt: 1, status: 'done', accumulatedMs: 60000,
    completedAt: new Date(d1 + 'T20:00:00').getTime(),
    actualMinutes: 1, currentSegmentStartedAt: null, rewardPaid: 10, rewardKind: 'today'
  }]
})
s.revertTask('tk_d1', d1)
// d1 被踢出 perfectDays;剩下 [d2, d3, today],3 个连续 → streakDays = 3
assert('older revert: perfectDays no longer contains d1', !st().perfectDays.includes(d1))
assert('older revert: streakDays recomputed to 3 (d2+d3+today)',
  st().streakDays === 3, `streakDays=${st().streakDays}`)

// ===== Scenario 4c: revert a middle perfect day → streak breaks =====
// 4 天 streak,revert 中间的 d2 → 剩 [d1, d3, today] → 因为 d2 缺失,
// d3+today 连续但 d1 断开 → trailing run = 2(d3+today)
console.log('\n[4c] Revert middle perfect day → streak breaks at gap')
seed({
  notebooks: [nb1],
  coins: 1000,
  perfectDays: [d1, d2, d3, today],
  streakDays: 4,
  bonusByDay: {
    [d1]: { dailyBonus: 10, weeklyBonus: 0, prevStreakDays: 0 },
    [d2]: { dailyBonus: 10, weeklyBonus: 0, prevStreakDays: 1 },
    [d3]: { dailyBonus: 10, weeklyBonus: 0, prevStreakDays: 2 },
    [today]: { dailyBonus: 10, weeklyBonus: 0, prevStreakDays: 3 }
  },
  tasks: [{
    id: 'tk_d2', notebookId: 'nb1', subject: '语', content: 'mid', estimatedMinutes: 5,
    order: 0, createdAt: 1, status: 'done', accumulatedMs: 60000,
    completedAt: new Date(d2 + 'T20:00:00').getTime(),
    actualMinutes: 1, currentSegmentStartedAt: null, rewardPaid: 10, rewardKind: 'today'
  }]
})
s.revertTask('tk_d2', d2)
assert('mid revert: perfectDays no longer contains d2', !st().perfectDays.includes(d2))
assert('mid revert: streakDays = 2 (d3+today, gap at d2)',
  st().streakDays === 2, `streakDays=${st().streakDays}`)

// ===== Scenario 5: DAILY_COMPLETION_CAP holds with reconcile loop =====
console.log('\n[5] 20-task cap + perfect-day revoke + complete still pays bonus exactly once')
seed({ notebooks: [nb1], coins: 0 })
for (let i = 0; i < 5; i++) {
  s.addTask({ notebookId: 'nb1', subject: '语', content: 'x' + i, estimatedMinutes: 1 })
}
const fiveIds = st().tasks.map((t) => t.id)
for (const id of fiveIds) s.finishTask(id, today)
const firstPass = st().coins
assert('5 tasks done → perfectDays has today', st().perfectDays.length === 1)
// Add a 6th task → revoke, complete → re-award with 6-task base.
s.addTask({ notebookId: 'nb1', subject: '语', content: 'x5', estimatedMinutes: 1 })
const sixth = st().tasks.find((t) => t.content === 'x5')
s.finishTask(sixth.id, today)
const sixCoins = st().coins
assert('6th cycle restores perfectDays', st().perfectDays[0] === today)
assert('coins increased', sixCoins > firstPass)

// ===== Scenario 5b: 25 tasks in one day — toast 显示和 coins 增加必须对齐 =====
// 回归用户反馈:">20 项全完成时 perfect 提示弹了但金币没加"。代码上 toast
// 和 coin 用同一个 lastReward.dailyBonus,理应不可能脱钩 —— 这里把这条约束
// 写成断言锁死,后续若有人改坏 cap/perfect 联动可以立刻被发现。
console.log('\n[5b] 25-task day → toast bonusCoins == 实际 coin delta(>20 时不脱钩)')
seed({ notebooks: [nb1], coins: 0 })
for (let i = 0; i < 25; i++) {
  s.addTask({ notebookId: 'nb1', subject: '语', content: 'big' + i, estimatedMinutes: 1 })
}
const bigIds = st().tasks.map((t) => t.id)
// 完成前 20 项 —— 各 +10,第 21~24 项 capped 不加,第 25 项触发 perfect-day。
for (let i = 0; i < 24; i++) s.finishTask(bigIds[i], today)
const coinsBeforeLast = st().coins
s.finishTask(bigIds[24], today)
const coinsAfterLast  = st().coins
const lr = st().lastReward
const toastBonus = (lr.dailyBonus || 0) + (lr.weeklyBonus || 0)
const actualDelta = coinsAfterLast - coinsBeforeLast
assert('25th finish: bonusCoins(toast) > 0',           toastBonus > 0,             `bonus=${toastBonus}`)
assert('25th finish: actualDelta == toast bonus',      actualDelta === toastBonus, `Δ=${actualDelta} toast=${toastBonus}`)
assert('25th finish: dailyBonus = 20×10 = 200',        lr.dailyBonus === 200,      `dailyBonus=${lr.dailyBonus}`)
assert('25th finish: taskReward = 0 (capped)',         lr.taskReward === 0,        `taskReward=${lr.taskReward}`)
assert('25th finish: todayCleared = true',             lr.todayCleared === true)
assert('25-task day final coins = 20×10 + 200 = 400',  st().coins === 400,         `coins=${st().coins}`)

// ===== Scenario 5c: coinLogs append-only audit + revoke guard against over-clawback =====
// 张天晴一案的根本修复 —— bonusByDay 有数据但没 ledgerEventId(老路径
// 残留 / flush 丢失)时,revokePerfectDay 必须只清记录、不发 task_refund,
// 否则会从根本没收过的钱里扣回,造成 server.coins 偏低。
console.log('\n[5c] revokePerfectDay 不 over-clawback;coinLogs 完整审计每条交易')
seed({ notebooks: [nb1], coins: 0, coinLogs: [] })
s.addTask({ notebookId: 'nb1', subject: '语', content: 'a', estimatedMinutes: 1 })
const aId = st().tasks[0].id
s.finishTask(aId, today)
// 正常路径:bonusByDay[today] 应该有 ledgerEventId
const normalLog = st().bonusByDay[today]
assert('正常 finish → bonusByDay 带 ledgerEventId',
  !!normalLog && typeof normalLog.ledgerEventId === 'string',
  `bonusByDay=${JSON.stringify(normalLog)}`)
// coinLogs 应该有这条记录
const lastLog = st().coinLogs[st().coinLogs.length - 1]
assert('finish 走完 → coinLogs 末尾是 task_reward', lastLog.kind === 'task_reward', `kind=${lastLog && lastLog.kind}`)
assert('coinLogs 记录 eventId / before / after',
  typeof lastLog.eventId === 'string' && typeof lastLog.balanceBefore === 'number' && typeof lastLog.balanceAfter === 'number')

// 模拟老路径残留 / flush 丢失:手动给一个虚假 bonusByDay 条目(没有 ledgerEventId),
// 然后 revoke,断言 coins 不被多扣。
seed({ notebooks: [nb1], coins: 50, coinLogs: [] })
s.addTask({ notebookId: 'nb1', subject: '语', content: 'b', estimatedMinutes: 1 })
const bId = st().tasks[0].id
// 手动伪造一个老路径残留的 perfectDays + bonusByDay 条目(没 ledgerEventId)
const stale = s.addDays(today, -1)
// 把伪造的天直接打进 state(模拟 cloud-sync 拉下来的老数据)
const updateState = require('path').join(__dirname, '..', 'utils', 'store.js')
// 通过 hydrate 注入伪造 state(模拟从云端 pull 到老路径残留)
s.applyHydratedState({
  notebooks: [nb1], coins: 50, coinLogs: [],
  tasks: st().tasks,
  perfectDays: [stale],
  bonusByDay: { [stale]: { dailyBonus: 65, weeklyBonus: 0, prevStreakDays: 0 } },
  // ↑ 注意:没有 ledgerEventId
  completionsByDay: {}, streakDays: 1, lastReward: null, pet: null
})
const coinsBeforeRevoke = st().coins
// 触发 revoke:直接 finish + revert 当天 task 也能触发,但 stale 不是 today
// 所以最简单是让 addTask 触发 reconcilePerfectDays(扫 stale 发现不再 allDone)
// — 添加一个 due=stale 的 one-shot task 让 stale 视图变 pending
const oldNb = { id: 'nbStale', name: stale, mode: 'one-shot', startDate: stale, endDate: stale, recurrence: null, createdAt: 1, order: 1 }
// 注意:applyHydratedState 之后 notebooks 已经设了,要 add 一个 stale notebook
s.applyHydratedState({
  notebooks: [nb1, oldNb], coins: 50, coinLogs: [],
  tasks: [], perfectDays: [stale],
  bonusByDay: { [stale]: { dailyBonus: 65, weeklyBonus: 0, prevStreakDays: 0 } },
  completionsByDay: {}, streakDays: 1, lastReward: null, pet: null
})
const beforeStaleRevoke = st().coins
// 加一个 stale 的 task,让 reconcile 扫到 stale 不再 allDone → 触发 revoke
s.addTask({ notebookId: 'nbStale', subject: '语', content: 'stale-task', estimatedMinutes: 1, dueDate: stale })
const afterStaleRevoke = st().coins
assert('over-clawback 守卫:无 ledgerEventId 的 bonusByDay revoke 不动 coins',
  afterStaleRevoke === beforeStaleRevoke,
  `before=${beforeStaleRevoke} after=${afterStaleRevoke}`)
assert('守卫触发后 bonusByDay[stale] 已清空(perfectDays 也移除)',
  !st().bonusByDay[stale] && !st().perfectDays.includes(stale))
// 应该有一条 audit-only 的 skipped 日志
const skipLog = st().coinLogs.find((l) => l.kind === 'perfect_day_clawback_skipped')
assert('coinLogs 留下 perfect_day_clawback_skipped 审计痕迹',
  !!skipLog && skipLog.delta === 0 && skipLog.meta.day === stale,
  `skipLog=${JSON.stringify(skipLog)}`)

// 反向验证:带 ledgerEventId 的正常路径,revoke 正确扣金币
seed({ notebooks: [nb1], coins: 0, coinLogs: [] })
s.addTask({ notebookId: 'nb1', subject: '语', content: 'c1', estimatedMinutes: 1 })
const cId = st().tasks[0].id
s.finishTask(cId, today)
const coinsAfterFinish = st().coins
const bonusAmount = (st().bonusByDay[today].dailyBonus || 0) + (st().bonusByDay[today].weeklyBonus || 0)
// revert task → 触发 revokePerfectDay,带 ledgerEventId 应该正常退款
s.revertTask(cId, today)
const coinsAfterRevert = st().coins
const expectedDrop = bonusAmount + 10 // dailyBonus + 单题 10
assert('正常路径 revoke:有 ledgerEventId,coins 正确扣回',
  coinsAfterFinish - coinsAfterRevert === expectedDrop,
  `finish=${coinsAfterFinish} revert=${coinsAfterRevert} expected drop=${expectedDrop}`)

// ===== Scenario 6: pet 动作:buyItem / skin switch 进 coin ledger;levelUp 走 XP 不进 ledger =====
console.log('\n[6] Pet purchases / skin switch queue coin events; level-up consumes XP only')
seed({ coins: 5000, pet: { species: 'sheep', name: '阿羊', level: 1, xp: 0, happiness: 50, fullness: 50, cleanliness: 50, health: 100, bornAt: Date.now(), lastDecayAt: Date.now() } })
const shopItems = st().shopItems
const affordable = shopItems.find((it) => it.price <= 50 && !it.happiness)
s.buyItem(affordable.id)
let last = coinLogsLast(1)[0]
assert('buyItem → pet_purchase event', last.kind === 'pet_purchase' && last.delta === -affordable.price)

// levelUpPet 现在花 XP,不花金币:扣 getXpForLevel(level) → level++,溢出 XP 留下。
// xp 不够时返 insufficient-xp,不动 state,也不发 coin event。
// cost(1) = 120,seed 220 XP → 升一级剩 100。lastDecayAt = now 防 commit 时 catch-up 把 xp 拉高。
seed({ coins: 5000, pet: { species: 'sheep', name: '阿羊', level: 1, xp: 220, happiness: 50, fullness: 50, cleanliness: 50, health: 100, bornAt: Date.now(), lastDecayAt: Date.now() } })
const coinsBefore6 = st().coins
const xpBefore = st().pet.xp
const levelBefore = st().pet.level
const logsBefore = st().coinLogs.length
const lvUp = s.levelUpPet()
assert('levelUpPet ok at Lv.1 (xp=220 ≥ 120)', lvUp && lvUp.ok && lvUp.level === levelBefore + 1)
assert('levelUpPet deducts getXpForLevel(1) = 120; 溢出 100 留下', st().pet.xp === xpBefore - 120,
  `xpBefore=${xpBefore} after=${st().pet.xp}`)
assert('levelUpPet 返回 xp = 100 (溢出)', lvUp.xp === 100)
assert('levelUpPet 不动 coins', st().coins === coinsBefore6)
assert('levelUpPet 不发 coin event', st().coinLogs.length === logsBefore)
assert('levelUpPet stamps lastLeveledAt', st().pet.lastLeveledAt != null)

// xp 不够时不动 state,返 insufficient-xp。Lv.50→51 cost = 1737,xp=500 → need=1237。
seed({ coins: 0, pet: { species: 'cat', name: 'P', level: 50, xp: 500, happiness: 50, fullness: 50, cleanliness: 50, health: 100, bornAt: Date.now(), lastDecayAt: Date.now() } })
const denyResult = s.levelUpPet()
assert('levelUpPet denies when xp < cost',
  denyResult && !denyResult.ok && denyResult.reason === 'insufficient-xp' && denyResult.need === 1237,
  `result=${JSON.stringify(denyResult)}`)
assert('denied levelUpPet does not touch xp', st().pet.xp === 500)
assert('denied levelUpPet does not touch level', st().pet.level === 50)

// switchPetSpecies: 不同物种 + 余额够 → 扣 PET_SWITCH_COST(100) 并发 pet_skin_switch 事件。
seed({ coins: 500, pet: { species: 'cat', name: 'S', level: 1, happiness: 50, fullness: 50, cleanliness: 50, health: 100, bornAt: Date.now(), lastDecayAt: Date.now() } })
const beforeSwitch = st().coins
const switchR = s.switchPetSpecies('sheep')
assert('switchPetSpecies returns ok', switchR && switchR.ok)
assert('switchPetSpecies deducts 100 locally', st().coins === beforeSwitch - 100)
const lastSwitch = coinLogsLast(1)[0]
assert('switchPetSpecies → pet_skin_switch event delta=-100',
  lastSwitch.kind === 'pet_skin_switch' && lastSwitch.delta === -100)

// ===== Scenario 6b: 完成作业不加 happiness; 道具加 happiness =====
console.log('\n[6b] Happiness comes from shop items, NOT from finishTask')
const nb6 = { id: 'nbH', name: today, mode: 'one-shot', startDate: today, endDate: today, recurrence: null, createdAt: 1, order: 0 }
seed({
  notebooks: [nb6], coins: 5000,
  pet: { species: 'cat', emoji: '🐱', name: 'Q', level: 1, happiness: 50, fullness: 50, cleanliness: 50, health: 100, bornAt: Date.now(), lastDecayAt: Date.now() }
})

// 完成单项 → happiness 不变
s.addTask({ notebookId: 'nbH', subject: '语', content: 'h1', estimatedMinutes: 5 })
s.addTask({ notebookId: 'nbH', subject: '数', content: 'h2', estimatedMinutes: 5 })
const happyTasks = st().tasks
const happyBefore = st().pet.happiness
s.finishTask(happyTasks[0].id, today)
assert('finishTask 单项不再 +happiness', st().pet.happiness === happyBefore,
  `before=${happyBefore} after=${st().pet.happiness}`)

// 完成所有作业 → 也不再把 happiness 拉到 100
s.finishTask(happyTasks[1].id, today)
assert('all-done 不再把 happiness 拉到 100', st().pet.happiness === happyBefore,
  `actual=${st().pet.happiness}`)
assert('lastReward 不再带 happiness 字段',
  st().lastReward.taskHappiness === undefined && st().lastReward.allDoneHappiness === undefined)

// 道具加 happiness:🎾 玩具球 happiness:30
const toy = shopItems.find((it) => it.happiness === 30)
seed({
  coins: 5000,
  pet: { species: 'cat', name: 'Q2', level: 1, happiness: 40, fullness: 50, cleanliness: 50, health: 100, bornAt: Date.now(), lastDecayAt: Date.now() }
})
s.buyItem(toy.id)
assert('buyItem 玩具球(happiness:30) → happiness +30', st().pet.happiness === 70,
  `actual=${st().pet.happiness}`)

// happiness 上限 100
seed({
  coins: 5000,
  pet: { species: 'cat', name: 'Q3', level: 1, happiness: 90, fullness: 50, cleanliness: 50, health: 100, bornAt: Date.now(), lastDecayAt: Date.now() }
})
s.buyItem(toy.id)
assert('buyItem happiness 道具 clamp 至 100', st().pet.happiness === 100)

// revertTask 不动 happiness
seed({
  notebooks: [nb6], coins: 5000,
  pet: { species: 'cat', name: 'Q4', level: 1, happiness: 60, fullness: 50, cleanliness: 50, health: 100, bornAt: Date.now(), lastDecayAt: Date.now() }
})
s.addTask({ notebookId: 'nbH', subject: '语', content: 'r1', estimatedMinutes: 5 })
const rTask = st().tasks[0]
s.finishTask(rTask.id, today)
const beforeRevertHappy = st().pet.happiness
s.revertTask(rTask.id, today)
assert('revertTask 不动 happiness', st().pet.happiness === beforeRevertHappy)

// ===== Scenario 7: share / admin claim 走本地 applyCoinDelta 入账 =====
console.log('\n[7] applyShareRewardClaim / applyAdminCoinClaim 直接入账 + 写 coinLogs')
seed({ coins: 50 })
const shareR = s.applyShareRewardClaim({ total: 9, count: 3, notebooks: ['nb1', 'nb2'] })
assert('share claim: coins +9', st().coins === 59)
assert('share claim: coinLogs 末尾 kind=share_reward delta=+9', coinLogsLast(1)[0].kind === 'share_reward' && coinLogsLast(1)[0].delta === 9)
assert('share claim summary 包含 total/count', shareR && shareR.total === 9 && shareR.count === 3)

const adminR = s.applyAdminCoinClaim({
  items: [
    { delta: 50, reason: '生日奖励', adminOpenid: 'admin1', auditId: 'a1', createdAt: 1 },
    { delta: -20, reason: '违规扣分', adminOpenid: 'admin1', auditId: 'a2', createdAt: 2 }
  ]
})
assert('admin claim: coins +50-20=+30', st().coins === 59 + 30)
const adminLogs = st().coinLogs.slice(-2)
assert('admin claim: coinLogs append 两条 admin_adjust',
  adminLogs.every((l) => l.kind === 'admin_adjust') &&
  adminLogs[0].delta === 50 && adminLogs[1].delta === -20)
assert('admin claim: meta.reason 保留', adminLogs[0].meta.reason === '生日奖励' && adminLogs[1].meta.reason === '违规扣分')
assert('admin claim summary: addedTotal/deductedTotal', adminR && adminR.addedTotal === 50 && adminR.deductedTotal === -20)

// ===== Scenario 7b: hydrate 直接用远端 state(没有 pending 加回的逻辑了) =====
console.log('\n[7b] hydrate 用远端 state 覆盖本地(client = truth 后没有 pending re-apply)')
seed({ coins: 100 })
s.applyHydratedState({ coins: 42, perfectDays: [], bonusByDay: {}, completionsByDay: {}, coinLogs: [], tasks: [], notebooks: [], pet: null }, Date.now())
assert('hydrate snaps local coins to remote 42', st().coins === 42, `coins=${st().coins}`)

// ===== Scenario 8: detachOccurrence — recurring 实例 detach 成独立 one-shot =====
console.log('\n[8] detachOccurrence: recurring 实例拆成独立 task,原任务 excludedDates 加这天')
seed({
  notebooks: [],
  coins: 0,
  tasks: [{
    id: 'tk_rec', subject: '数学', organization: '校内', content: '每日口算',
    estimatedMinutes: 10, mode: 'recurring', startDate: today, endDate: null,
    recurrence: { type: 'daily', weekdays: [] },
    excludedDates: [],
    order: 0, createdAt: 1, occurrences: {}
  }]
})
// case 1: 在干净状态(occurrence 没数据)detach 今天
let newId = s.detachOccurrence('tk_rec', today)
assert('detach 返回新 task id', !!newId)
let allTasks = st().tasks
let originalRec = allTasks.find((t) => t.id === 'tk_rec')
let detachedTask = allTasks.find((t) => t.id === newId)
assert('原 recurring task 的 excludedDates 包含 today', originalRec.excludedDates.indexOf(today) >= 0)
assert('新 task 是 one-shot', detachedTask.mode === 'one-shot')
assert('新 task startDate = today', detachedTask.startDate === today)
assert('新 task endDate = today', detachedTask.endDate === today)
assert('新 task 继承 content', detachedTask.content === '每日口算')
assert('新 task 继承 subject', detachedTask.subject === '数学')
assert('新 task 继承 organization', detachedTask.organization === '校内')
assert('新 task detachedFrom 标记', detachedTask.detachedFrom === 'tk_rec')
assert('新 task 默认 status=todo', (detachedTask.status || 'todo') === 'todo')

// case 2: tasksForDate(today) 看不到原 recurring,只看到新 detached
const todayItems = s.tasksForDate(st(), today)
const todayTaskIds = todayItems.map((it) => it.task.id)
assert('tasksForDate today 不含原 tk_rec', todayTaskIds.indexOf('tk_rec') < 0)
assert('tasksForDate today 含新 detached task', todayTaskIds.indexOf(newId) >= 0)

// case 3: 已经 doing 的 occurrence detach — 进度/accumulatedMs 转移
seed({
  notebooks: [],
  coins: 0,
  tasks: [{
    id: 'tk_rec2', subject: '语文', organization: '校外', content: '听写',
    estimatedMinutes: 15, mode: 'recurring', startDate: yesterday, endDate: null,
    recurrence: { type: 'daily', weekdays: [] },
    excludedDates: [],
    order: 0, createdAt: 1,
    occurrences: {
      [today]: {
        status: 'doing',
        startedAt: 1234567890,
        currentSegmentStartedAt: 1234567899,
        accumulatedMs: 60000,
        completedAt: null,
        actualMinutes: null
      }
    }
  }]
})
const doingDetachId = s.detachOccurrence('tk_rec2', today)
const doingDetached = st().tasks.find((t) => t.id === doingDetachId)
assert('doing detach: 新 task 继续 doing', doingDetached.status === 'doing')
assert('doing detach: accumulatedMs 完整搬', doingDetached.accumulatedMs === 60000)
assert('doing detach: currentSegmentStartedAt 保留', doingDetached.currentSegmentStartedAt === 1234567899)
const origRec2 = st().tasks.find((t) => t.id === 'tk_rec2')
assert('原 task occurrences[today] 已清', !origRec2.occurrences[today])

// case 4: 已 done 的 occurrence detach — reward 不重复发
seed({
  notebooks: [],
  coins: 100,
  perfectDays: [],
  bonusByDay: {},
  tasks: [{
    id: 'tk_rec3', subject: '英语', organization: '校内', content: '背单词',
    estimatedMinutes: 10, mode: 'recurring', startDate: yesterday, endDate: null,
    recurrence: { type: 'daily', weekdays: [] },
    excludedDates: [],
    order: 0, createdAt: 1,
    occurrences: {
      [today]: {
        status: 'done',
        startedAt: 1, currentSegmentStartedAt: null,
        accumulatedMs: 120000, completedAt: Date.now(), actualMinutes: 2,
        rewardPaid: 10, rewardKind: 'today', happinessPaid: 5
      }
    }
  }]
})
const coinsBeforeDetach = st().coins
const doneDetachId = s.detachOccurrence('tk_rec3', today)
const doneDetached = st().tasks.find((t) => t.id === doneDetachId)
assert('done detach: 新 task 仍是 done', doneDetached.status === 'done')
assert('done detach: rewardPaid 保留', doneDetached.rewardPaid === 10)
assert('done detach: coins 不变(reward 不重发)', st().coins === coinsBeforeDetach)

// case 5: excludeOccurrence 只标记不新建
seed({
  notebooks: [],
  coins: 0,
  tasks: [{
    id: 'tk_rec4', subject: '语', organization: '其他', content: '抄写',
    estimatedMinutes: 5, mode: 'recurring', startDate: today, endDate: null,
    recurrence: { type: 'daily', weekdays: [] },
    excludedDates: [],
    order: 0, createdAt: 1,
    occurrences: { [today]: { status: 'todo' } }
  }]
})
const taskCountBefore = st().tasks.length
const okExclude = s.excludeOccurrence('tk_rec4', today)
assert('excludeOccurrence 返回 true', okExclude === true)
assert('excludeOccurrence 不新建 task', st().tasks.length === taskCountBefore)
const excludedRec = st().tasks.find((t) => t.id === 'tk_rec4')
assert('excludeOccurrence 加 excludedDates', excludedRec.excludedDates.indexOf(today) >= 0)
assert('excludeOccurrence 清掉 occurrences[date]', !excludedRec.occurrences[today])
// tasksForDate 看不到这个 task 在 today
const itemsAfterExclude = s.tasksForDate(st(), today)
assert('exclude 后 today 看不到这个 task',
  itemsAfterExclude.every((it) => it.task.id !== 'tk_rec4'))

// case 6: detach 非 recurring task → 返回 null
seed({
  notebooks: [],
  tasks: [{
    id: 'tk_one', subject: '语', organization: '其他', content: 'oneshot',
    mode: 'one-shot', startDate: today, endDate: today, recurrence: null,
    excludedDates: [], order: 0, createdAt: 1, status: 'todo'
  }]
})
const nullDetach = s.detachOccurrence('tk_one', today)
assert('detach 一次性 task 返回 null', nullDetach === null)

// case 7: detach 已 done 的 perfect-day 占位实例 → perfectDays 仍包含今天
// (新 task 继承 done 状态, tasksForDate(today) 仍 all-done, 不需要 reconcile)
// startDate 锚 today 不留 backlog 干扰;这是一个"今天才开始的 daily recurring"。
seed({
  notebooks: [],
  coins: 100,
  perfectDays: [today],
  bonusByDay: { [today]: { dailyBonus: 10, weeklyBonus: 0, prevStreakDays: 0 } },
  streakDays: 1,
  tasks: [{
    id: 'tk_perfect_rec',
    subject: '数学', organization: '校内', content: '每日 perfect 占位',
    mode: 'recurring', startDate: today, endDate: null,
    recurrence: { type: 'daily', weekdays: [] },
    excludedDates: [],
    order: 0, createdAt: 1,
    occurrences: {
      [today]: {
        status: 'done',
        startedAt: 1, currentSegmentStartedAt: null,
        accumulatedMs: 60000, completedAt: Date.now(), actualMinutes: 1,
        rewardPaid: 10, rewardKind: 'today', happinessPaid: 5
      }
    }
  }]
})
const coinsBeforePerfectDetach = st().coins
const perfectDetachId = s.detachOccurrence('tk_perfect_rec', today)
assert('detach perfect-day 占位:返回新 task id', !!perfectDetachId)
assert('detach perfect-day 占位:perfectDays 仍包含 today',
  st().perfectDays.indexOf(today) >= 0)
assert('detach perfect-day 占位:streakDays 不变', st().streakDays === 1)
assert('detach perfect-day 占位:bonusByDay 不变', !!st().bonusByDay[today])
assert('detach perfect-day 占位:coins 不变', st().coins === coinsBeforePerfectDetach)
// tasksForDate(today) 现在应该看到的是新的 detached one-shot, 而不是原 recurring
const itemsAfterPerfectDetach = s.tasksForDate(st(), today)
const todayTaskIds2 = itemsAfterPerfectDetach.map((it) => it.task.id)
assert('detach perfect-day 占位:today 只看到新 task,看不到原 recurring',
  todayTaskIds2.indexOf(perfectDetachId) >= 0 &&
  todayTaskIds2.indexOf('tk_perfect_rec') < 0)
assert('detach perfect-day 占位:今天的 task 仍是 done (perfect 状态完整)',
  itemsAfterPerfectDetach.every((it) => it.occurrence.status === 'done'))

// ===== Scenario 9: v2→v3 migration flag (lazy backup trigger) =====
console.log('\n[9] consumeV2V3MigrationFlag 在 v2→v3 migrate 时设 true, 重复消费返回 false')
// 模拟"刚升级"场景: storage 里写了 v2 schema 数据 → 触发 v3 client migrate。
// wx mock 直接存 object(loadState 期待 raw 是对象,不是 JSON 字符串)。
wx._store = {}
wx._store['homework-pet-v1'] = {
  schemaVersion: 2, coins: 0, streakDays: 0, perfectDays: [], bonusByDay: {},
  completionsByDay: {}, pendingShareCoins: 0, editTaskId: null, editNotebookId: null,
  ocrCurrentJob: null, ocrJobs: [], pet: {}, shopItems: [],
  notebooks: [{
    id: 'nb_v2', name: 'v2 本', mode: 'one-shot',
    startDate: today, endDate: today, recurrence: null, createdAt: 1, order: 0
  }],
  tasks: [{
    id: 'tk_v2', notebookId: 'nb_v2', subject: '语', content: 'v2 task',
    estimatedMinutes: 5, order: 0, createdAt: 1, status: 'todo'
  }],
  profile: { nickname: '' }
}
// 重新 require 触发 fresh loadState → migrate v2→v3
delete require.cache[require.resolve(require('path').join(__dirname, '..', 'utils', 'store.js'))]
const sFresh = require(require('path').join(__dirname, '..', 'utils', 'store.js'))
sFresh.getStateWithComputed()  // 触发 loadState

assert('v2→v3 migrate 后 consumeV2V3MigrationFlag 返回 true',
  sFresh.consumeV2V3MigrationFlag() === true)
assert('重复消费 flag 返回 false', sFresh.consumeV2V3MigrationFlag() === false)
// 第二次 loadState 不会重跑 migrate(已经是 v3),flag 不再触发
sFresh.getStateWithComputed()
assert('v3 状态再次读取不再设 flag', sFresh.consumeV2V3MigrationFlag() === false)

// ===== Scenario 10: hydrate 拿到无 schemaVersion + v2 notebooks 的 remote 数据 =====
// 真实场景(1.0.0.26051701 bug):云端 user_state 没 schemaVersion 字段
// (SYNC_FIELDS 历史漏了 schemaVersion),但 notebooks/tasks 是 v2 schema。
// 修复前 migrate 把它当 v1 处理,所有 task 塞 nb_mig_today,endDate=today
// → 首页"已完成"列表炸开。修复后走 v2→v3 平移,endDate 跟随原 notebook。
console.log('\n[10] hydrate v2 schema 但 schemaVersion 字段缺失 → 应正确走 v2→v3 平移')
wx._store = {}
wx._store['homework-pet-v1'] = {
  // 故意不写 schemaVersion 字段(模拟 SYNC_FIELDS 漏 sync)
  coins: 0, streakDays: 0, perfectDays: [], bonusByDay: {},
  completionsByDay: {}, pendingShareCoins: 0, editTaskId: null, editNotebookId: null,
  ocrCurrentJob: null, ocrJobs: [], pet: {}, shopItems: [],
  notebooks: [{
    id: 'nb_v2_history', name: '历史本', mode: 'one-shot',
    startDate: '2026-05-12', endDate: '2026-05-12', recurrence: null,
    createdAt: 1, order: 0
  }],
  tasks: [{
    id: 'tk_v2_done', notebookId: 'nb_v2_history',
    subject: '语', content: '历史完成', estimatedMinutes: 5,
    order: 0, createdAt: 1,
    status: 'done',
    completedAt: new Date('2026-05-12T20:00:00').getTime(),
    accumulatedMs: 60000, actualMinutes: 1
  }],
  profile: { nickname: '' }
}
delete require.cache[require.resolve(require('path').join(__dirname, '..', 'utils', 'store.js'))]
const sV2Hydrate = require(require('path').join(__dirname, '..', 'utils', 'store.js'))
const stateAfterV2 = sV2Hydrate.getStateWithComputed()
const tkV2 = stateAfterV2.tasks.find((t) => t.id === 'tk_v2_done')
assert('v2 hydrate: task 保留原 id (没被 v1 fallback 重写成 tk_mig_*)', !!tkV2)
assert('v2 hydrate: task.endDate 跟随原 notebook (历史 5/12,不是 today)',
  tkV2 && tkV2.endDate === '2026-05-12', `endDate=${tkV2 && tkV2.endDate}`)
assert('v2 hydrate: task.mode 平移为 one-shot', tkV2 && tkV2.mode === 'one-shot')
const todayItemsV2 = sV2Hydrate.tasksForDate(stateAfterV2, today)
const onTodayView = todayItemsV2.find((it) => it.task.id === 'tk_v2_done')
assert('v2 hydrate: 历史 done task 不在 today 视图', !onTodayView)
assert('v2 hydrate: notebooks 已被清空(走完 v2→v3 平移)',
  stateAfterV2.notebooks.length === 0)

// ===== Scenario N: tasksForDate 视图分类:漏做(红) vs 补做(黄) =====
// 触发场景:Arthur 5/16 没做完"目标24课",5/17 才补做。期望:
//   - 5/16 视图:该 occurrence 在"已完成"区(status=done),但 isOverdue=true 红底
//   - 5/17 视图:该 occurrence 在"已完成"区,isMakeup=true(黄底)
//   - 同一 occurrence 不应同时在两天"已完成"里出现重复
console.log('\n[N] tasksForDate: 漏做归红 / 补做归黄(一次性 + recurring)')

// --- 一次性任务:dueDate=yesterday,completedAt=today ---
seed({
  notebooks: [],
  tasks: [{
    id: 'tk_makeup_oneshot',
    subject: '目标24课', organization: '其他', content: '一次性补做',
    estimatedMinutes: 10,
    mode: 'one-shot', startDate: yesterday, endDate: yesterday, recurrence: null,
    order: 0, createdAt: 1,
    status: 'done',
    completedAt: Date.now(),  // pinned to today 22:00 by setNowHour(22)
    accumulatedMs: 60000, actualMinutes: 1,
    rewardPaid: 5, rewardKind: 'overdue'
  }]
})

const yItems = s.tasksForDate(st(), yesterday)
const yRow = yItems.find((it) => it.task.id === 'tk_makeup_oneshot')
assert('one-shot 5.16 视图含该任务', !!yRow)
assert('one-shot 5.16 视图:isOverdue=true(红)', yRow && yRow.isOverdue === true)
assert('one-shot 5.16 视图:occurrence.status 保持 done(进已完成区)',
  yRow && yRow.occurrence.status === 'done')
assert('one-shot 5.16 视图:不带 isMakeup', yRow && !yRow.isMakeup)

const tItems = s.tasksForDate(st(), today)
const tRow = tItems.find((it) => it.task.id === 'tk_makeup_oneshot')
assert('one-shot 5.17 视图含该任务', !!tRow)
assert('one-shot 5.17 视图:isMakeup=true(黄)', tRow && tRow.isMakeup === true)
assert('one-shot 5.17 视图:isOverdue=false', tRow && tRow.isOverdue === false)
assert('one-shot 5.17 视图:status 保持 done(进已完成区)',
  tRow && tRow.occurrence.status === 'done')
assert('one-shot 5.17 视图:occurrenceDate 仍是任务归属日 5.16',
  tRow && tRow.occurrenceDate === yesterday)

// 同 task 在两个视图各出现 1 次,不重复
const yCount = yItems.filter((it) => it.task.id === 'tk_makeup_oneshot').length
const tCount = tItems.filter((it) => it.task.id === 'tk_makeup_oneshot').length
assert('one-shot 5.16 视图无重复', yCount === 1)
assert('one-shot 5.17 视图无重复', tCount === 1)

// --- Recurring 任务:5.16 occurrence 在 5.17 才完成 ---
seed({
  notebooks: [],
  tasks: [{
    id: 'tk_makeup_recurring',
    subject: '目标24课', organization: '其他', content: 'recurring 补做',
    estimatedMinutes: 10,
    mode: 'recurring', startDate: yesterday, endDate: null,
    recurrence: { type: 'daily' },
    order: 0, createdAt: 1,
    occurrences: {
      [yesterday]: {
        status: 'done',
        completedAt: Date.now(),  // 今天才完成
        accumulatedMs: 60000, actualMinutes: 1,
        rewardPaid: 5, rewardKind: 'overdue'
      }
    }
  }]
})

const yItemsR = s.tasksForDate(st(), yesterday)
const yRowR = yItemsR.find((it) => it.task.id === 'tk_makeup_recurring')
assert('recurring 5.16 视图含该任务', !!yRowR)
assert('recurring 5.16 视图:isOverdue=true(红)', yRowR && yRowR.isOverdue === true)
assert('recurring 5.16 视图:occurrence.status 保持 done(进已完成区)',
  yRowR && yRowR.occurrence.status === 'done')

const tItemsR = s.tasksForDate(st(), today)
const tRowR = tItemsR.find((it) => it.task.id === 'tk_makeup_recurring' && it.occurrenceDate === yesterday)
assert('recurring 5.17 视图含 5.16 occurrence', !!tRowR)
assert('recurring 5.17 视图:isMakeup=true(黄)', tRowR && tRowR.isMakeup === true)
assert('recurring 5.17 视图:isOverdue=false', tRowR && tRowR.isOverdue === false)
assert('recurring 5.17 视图:status=done(进已完成区)',
  tRowR && tRowR.occurrence.status === 'done')

// --- 反例:当天完成的任务不该被标 makeup ---
seed({
  notebooks: [],
  tasks: [{
    id: 'tk_on_time',
    subject: '语', organization: '其他', content: '当天完成',
    estimatedMinutes: 5,
    mode: 'one-shot', startDate: today, endDate: today, recurrence: null,
    order: 0, createdAt: 1,
    status: 'done', completedAt: Date.now(),
    accumulatedMs: 60000, actualMinutes: 1
  }]
})
const tOK = s.tasksForDate(st(), today).find((it) => it.task.id === 'tk_on_time')
assert('当天完成:isMakeup=false', tOK && tOK.isMakeup === false)
assert('当天完成:isOverdue=false', tOK && tOK.isOverdue === false)

// --- 提前完成(目标24课1 / Arthur 场景):
// 一次性 task,跨两天作业本(startDate=5.16, endDate=5.17),5.16 当天就完成。
// 期望:仅 5.16 显示(白底,正常已完成),5.17 不再重复显示。
const yest = yesterday  // 5.16
const tdy = today       // 5.17
seed({
  notebooks: [],
  tasks: [{
    id: 'tk_early_finish',
    subject: '目标24课1', organization: '校外', content: '跨两天作业本提前完成',
    estimatedMinutes: 10,
    mode: 'one-shot', startDate: yest, endDate: tdy, recurrence: null,
    order: 0, createdAt: 1,
    status: 'done',
    // 完成于"昨天"22:00 — 用 setNowHour(22) 固定的 today 22:00 减 1 天
    completedAt: Date.now() - 24 * 3600 * 1000,
    accumulatedMs: 60000, actualMinutes: 1,
    rewardPaid: 15, rewardKind: 'future'
  }]
})

const yEarly = s.tasksForDate(st(), yest).filter((it) => it.task.id === 'tk_early_finish')
const tEarly = s.tasksForDate(st(), tdy).filter((it) => it.task.id === 'tk_early_finish')
assert('提前完成:5.16(完成日)不再重复显示', yEarly.length === 0)
assert('提前完成:5.17(dueDate)显示 1 次', tEarly.length === 1)
assert('提前完成:5.17 视图 isMakeup=false(不算补做)',
  tEarly[0] && tEarly[0].isMakeup === false)
assert('提前完成:5.17 视图 isOverdue=false', tEarly[0] && tEarly[0].isOverdue === false)
assert('提前完成:5.17 视图 status=done(进已完成区)',
  tEarly[0] && tEarly[0].occurrence.status === 'done')

// ===== Scenario L: formatRecurrenceLabel(一次性 / daily / weekly 多种) =====
console.log('\n[L] formatRecurrenceLabel: 中文周期标签')

assert('一次性 task → 空字符串',
  s.formatRecurrenceLabel({ mode: 'one-shot' }) === '')
assert('null task → 空字符串',
  s.formatRecurrenceLabel(null) === '')
assert('recurring + daily → 每天',
  s.formatRecurrenceLabel({ mode: 'recurring', recurrence: { type: 'daily' } }) === '每天')
assert('recurring + weekly + [1] → 每周一',
  s.formatRecurrenceLabel({ mode: 'recurring',
    recurrence: { type: 'weekly', weekdays: [1] } }) === '每周一')
assert('recurring + weekly + [2,3,4] → 每周二三四',
  s.formatRecurrenceLabel({ mode: 'recurring',
    recurrence: { type: 'weekly', weekdays: [2, 3, 4] } }) === '每周二三四')
assert('recurring + weekly + [4,2,3] (乱序) → 每周二三四',
  s.formatRecurrenceLabel({ mode: 'recurring',
    recurrence: { type: 'weekly', weekdays: [4, 2, 3] } }) === '每周二三四')
assert('recurring + weekly + 7 全选 → 每天',
  s.formatRecurrenceLabel({ mode: 'recurring',
    recurrence: { type: 'weekly', weekdays: [1, 2, 3, 4, 5, 6, 7] } }) === '每天')
assert('recurring + weekly + [7] → 每周日',
  s.formatRecurrenceLabel({ mode: 'recurring',
    recurrence: { type: 'weekly', weekdays: [7] } }) === '每周日')
assert('recurring + weekly + 空 weekdays → 每周?',
  s.formatRecurrenceLabel({ mode: 'recurring',
    recurrence: { type: 'weekly', weekdays: [] } }) === '每周?')
assert('recurring + 无 recurrence 字段 → 每天(默认)',
  s.formatRecurrenceLabel({ mode: 'recurring' }) === '每天')

// ===== Summary =====
console.log(`\n=== ${passed} passed, ${failed} failed ===`)
process.exit(failed === 0 ? 0 : 1)
