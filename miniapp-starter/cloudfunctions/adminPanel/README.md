# adminPanel 云函数

管理后台后端 — 查所有用户、调金币、留审计。

## 部署 / 配置

1. **上传部署**:微信开发者工具 → 右键 `cloudfunctions/adminPanel` → "上传并部署:云端安装依赖"。
2. **环境变量**:云开发面板 → 云函数 → `adminPanel` → 版本与配置 → 环境变量,新增:
   - `ADMIN_OPENIDS` = 管理员 openid,多个用逗号分隔,**未配置则没有任何管理员**(所有 admin 操作返回 `not_admin`)。
3. **集合**:首次执行 `adjustCoins` / `claimAdminCoins` / `listAdjustments` 时会自动 `createCollection`,无需手工建表。两个集合:
   - `coin_adjustments` — 不可变审计,所有 admin 调整都会写一条
   - `admin_coin_inbox` — 待领取队列,目标用户 claim 后会被删
   - 建议在云开发面板 → 数据库 → 两个集合 → 权限设置 → 切到 **「仅创建者可读写」**(实际操作全走云函数 admin SDK,不依赖 ACL,但默认收紧最稳妥)

## 怎么拿自己的 openid 加白

最简单的两种方式:

- 已经登录过的用户:云开发控制台 → 数据库 → `user_state` 集合 → 翻一下 `_openid` 字段
- 没登过的:在小程序里随便点一个会调云函数的入口(比如登录、首页),云函数日志里就能看见 `OPENID`

确认 openid 后,把它写进 `ADMIN_OPENIDS` 即可。

## Actions

| action | 参数 | 权限 | 说明 |
|---|---|---|---|
| `whoami` | — | 所有人 | 返回 `{ ok, openid, isAdmin }`,前端据此渲染入口 |
| `claimAdminCoins` | — | **所有人** | 拉自己 inbox 的 pending 调整 + 删除 + 标审计 claimed |
| `listUsers` | `limit?`, `skip?` | admin | 按 `updatedAt desc` 分页拉 user_state 摘要 |
| `getUser` | `openid` | admin | 返回完整 state |
| `adjustCoins` | `openid`, `delta`, `reason` | admin | **不**改 user_state,写审计 + 入 inbox |
| `listAdjustments` | `targetOpenid?`, `limit?`, `skip?` | admin | 查审计记录(含 claimed 状态) |

### adjustCoins / 信箱模式

为什么要走 inbox 而不是直接改 `user_state.state.coins`?

客户端 cloud-sync 是「整个 state 全量 push、200ms 防抖」。如果在线时 admin 直接改了 cloud 的 coins,目标设备 push 一次就会用本地旧 coins 覆盖。`shareReward` 也踩过同样的坑,解决办法是中间加一个 inbox 集合:

```
admin 提交 → coin_adjustments(永久审计) + admin_coin_inbox(_openid=目标)
                                                ↓ 用户下次进 home 页
                       claimAdminCoins → 客户端 store.applyAdminCoinClaim
                                                ↓
                                  本地 coins += delta(clamp ≥0)
                                  coinLogs.push(`admin-adjust:reason`)
                                                ↓
                                  cloud-sync 走自己的 push 写回 user_state
```

- 目标用户在不在线无所谓;离线时调整在 inbox 里待领,下次启动 app 自动到账
- 无竞争 —— 不修改 user_state,不会被覆盖
- clamp 到 ≥0 由客户端按 createdAt 顺序逐条处理(多条 -delta 累计到 0 后剩余的 effectively 丢弃,但审计记录保留)
- 客户端 throttle 30s,正常 30s 内调整不会被重复拉;首次启动立即拉

### adjustCoins 参数细节

- `delta` 必须是非零整数,绝对值 ≤ 1,000,000
- `reason` 必填,长度 ≤ 200,会写入审计 + inbox + 用户的 `state.coinLogs`(prefix `admin-adjust:`)
- 提交后云函数立即返回 `{ ok: true, delta, auditId, pendingOnly: true }`,**不**返回 balanceBefore/After(因为云端可能滞后于客户端真实 coins,不能保证准确)

### 审计 schema(coin_adjustments)

```
{
  _id, targetOpenid, adminOpenid, delta, reason,
  createdAt,
  claimed: false → true (当客户端 claimAdminCoins 时回填)
  claimedAt: 0   → timestamp
  appliedDelta: 0 → 实际生效 delta(目前直接记 delta;客户端 clamp 不上报)
}
```

如果之后需要更精确的 appliedDelta(知道客户端 clamp 后到底加了多少),可以让客户端 claim 时回调一个 `reportClaimResult` action,或让云函数读完 inbox 再写一个独立的 `inbox_claimed` 事件集合。当前没做。
