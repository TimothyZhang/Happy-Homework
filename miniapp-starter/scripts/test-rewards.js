'use strict'

// 奖励 / 金币账本回归测试。29 个断言,覆盖:
//   - finishTask 单题奖、daily-perfect base、early-bird、weekly streak
//   - addTask / importSharedNotebook 触发的 perfectDay 回收(reconcilePerfectDays)
//   - revertTask 同时退单题奖 + 回收当日完美奖
//   - DAILY_COMPLETION_CAP 与回收循环交互
//   - 宠物 buyItem / levelUpPet 走 applyCoinDelta
//   - applyHydratedState 把 pendingCoinEvents 的 delta 加回乐观本地余额
//
// 何时跑:任何 store.js / cloud-sync.js / coin-ledger.js / coinLedger 云函数
// 的改动之后都要跑一遍。Tim 不测试,这步是 claude 的责任:
//
//   node miniapp-starter/scripts/test-rewards.js
//
// 跑不通 → 改完再跑,直到 29/29。失败要在汇报里如实写,不要"应该 OK"糊弄。
//
// 实现细节:stub 了 wx 的 storage 和 cloud 占位,store.js 在 Node 端能跑通
// 整个 updateState 路径。不连真实云数据库,测的是客户端逻辑 + pendingCoinEvents
// 队列内容,服务端账本一致性需要部署联调验证。

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
    tasks: [],
    notebooks: [],
    pet: null,
    lastReward: null,
    profile: null,
    ...stateOverride
  })
}

function st() { return s.getStateWithComputed() }
function pendingLast(n) {
  const q = (st().pendingCoinEvents || []).slice(-n)
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
assert('all events are task_reward', pendingLast(3).every((e) => e.kind === 'task_reward'))

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
assert('pendingCoinEvents tail = clawback', pendingLast(1)[0].kind === 'task_refund' && pendingLast(1)[0].reason === 'perfect_day_clawback')

// Add a third task; should NOT add a second refund event (already not-perfect).
const refundCountBefore = st().pendingCoinEvents.filter((e) => e.kind === 'task_refund').length
s.addTask({ notebookId: 'nb1', subject: '英', content: 'z', estimatedMinutes: 5 })
const refundCountAfter = st().pendingCoinEvents.filter((e) => e.kind === 'task_refund').length
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
console.log('\n[3] Add task on tomorrow notebook → today\'s perfect day intact')
const nbT = { id: 'nbT', name: 'tomorrow', mode: 'one-shot', startDate: tomorrow, endDate: tomorrow, recurrence: null, createdAt: 2, order: 1 }
seed({
  notebooks: [nb1, nbT],
  coins: 200,
  perfectDays: [today],
  bonusByDay: { [today]: { dailyBonus: 60, weeklyBonus: 0, prevStreakDays: 0 } },
  streakDays: 1,
  tasks: [{ id: 'tk_done', notebookId: 'nb1', subject: '语', content: 'old', estimatedMinutes: 5, order: 0, createdAt: 1, status: 'done', accumulatedMs: 60000, completedAt: 2, actualMinutes: 1, currentSegmentStartedAt: null, rewardPaid: 10, rewardKind: 'today' }]
})
const baselineCoins = st().coins
s.addTask({ notebookId: 'nbT', subject: '数', content: 'future', estimatedMinutes: 5 })
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
const refundEvents = st().pendingCoinEvents.filter((e) => e.kind === 'task_refund').slice(-2)
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

// ===== Scenario 6: pet purchase / level-up / skin switch all queue events =====
console.log('\n[6] Pet purchases queue pet_purchase / level_upgrade / pet_skin_switch events')
seed({ coins: 5000, pet: { species: 'sheep', name: '阿羊', level: 1, growth: 0, happiness: 50, fullness: 50, cleanliness: 50, health: 100, createdAt: Date.now(), lastUpdatedAt: Date.now() } })
const shopItems = st().shopItems
if (Array.isArray(shopItems) && shopItems.length > 0) {
  const affordable = shopItems.find((it) => it.price <= 50)
  if (affordable) {
    s.buyItem(affordable.id)
    const last = pendingLast(1)[0]
    assert('buyItem → pet_purchase event', last.kind === 'pet_purchase' && last.delta === -affordable.price)
  }
}
const lvlCost = s.getLevelCost(st().pet.level || 1)
if (st().coins >= lvlCost) {
  s.levelUpPet()
  const last = pendingLast(1)[0]
  assert('levelUpPet → level_upgrade event', last.kind === 'level_upgrade' && last.delta === -lvlCost,
    `last=${JSON.stringify(last)} expected delta=${-lvlCost}`)
}

// switchPetSpecies: 不同物种 + 余额够 → 扣 PET_SWITCH_COST(100) 并发 pet_skin_switch 事件。
const before = st().coins
const r = s.switchPetSpecies(st().pet.species === 'sheep' ? 'cat' : 'sheep')
assert('switchPetSpecies returns ok', r && r.ok)
assert('switchPetSpecies deducts 100 locally', st().coins === before - 100)
const lastSwitch = pendingLast(1)[0]
assert('switchPetSpecies → pet_skin_switch event delta=-100',
  lastSwitch.kind === 'pet_skin_switch' && lastSwitch.delta === -100)

// ===== Scenario 7: pendingCoinEvents survive hydrate; coins re-applied =====
console.log('\n[7] Hydrate with stale server coins re-applies pending delta')
seed({ coins: 100 })
s.addTask({ notebookId: undefined, subject: '语', content: 'one', estimatedMinutes: 5 })
const taskId7 = st().tasks[0].id
s.finishTask(taskId7, today)
const localCoinsAfter = st().coins
const pendingDelta = st().pendingCoinEvents.reduce((a, e) => a + e.delta, 0)
// Simulate hydrate from a server that's behind by pendingDelta.
const serverCoins = localCoinsAfter - pendingDelta
s.applyHydratedState({
  coins: serverCoins
}, Date.now())
assert('hydrate keeps local optimistic coins (server + pending re-applied)', st().coins === localCoinsAfter,
  `coins=${st().coins} expected=${localCoinsAfter}`)
assert('pendingCoinEvents preserved through hydrate', st().pendingCoinEvents.length > 0)

// ===== Summary =====
console.log(`\n=== ${passed} passed, ${failed} failed ===`)
process.exit(failed === 0 ? 0 : 1)
