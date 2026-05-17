# 云开发数据结构草案

> **⚠️ 状态：未实现的设计草案**
>
> 本文档描述的是规范化多表方案，作为未来真要做长期分析 / 多孩子家庭体系时的参考。
>
> v1 实际走的是**单文档模型**：一个集合 `user_state`，每用户一条文档，整个 state 打包存（详见 `CLOUD-SETUP.md` 末尾的「跨设备数据同步」章节）。
>
> 下面的多表方案在以下任意场景下才会启用：
> - 需要做跨用户长期分析（`coinLogs / homeworkTasks` 累积量）
> - 需要多孩子 / 多家长账号体系
> - 需要分享 / 排行 / 社交关系链

这是当前小程序从「本地原型版」迁移到「云开发版」的数据草案。

## 1. users
- _id
- role: parent | child
- nickname
- avatar
- createdAt

## 2. families
- _id
- parentUserId
- familyName
- createdAt

## 3. children
- _id
- familyId
- name
- grade
- schoolName
- createdAt

## 4. homeworkTasks
- _id
- childId
- subject
- content
- sourceType: manual | ocr
- estimatedMinutes
- priority
- status: todo | doing | done
- planStart
- planEnd
- actualStart
- actualEnd
- createdAt
- updatedAt

## 5. coinLogs
- _id
- childId
- taskId
- sourceType: task_finish | on_time | all_done | streak | shop_consume
- coins
- createdAt

## 6. pets
- _id
- childId
- petType
- petName
- level
- happiness
- fullness
- cleanliness
- health
- bornAt
- lastDecayAt
- lastLeveledAt
- updatedAt

> 历史草案里有 `growth` / `nextLevelGrowth` 字段(配 XP 自动升级)。V1 实际改回"消耗金币手动升级",这两个字段已废弃,迁移多表时不用建。

## 7. shopOrders
- _id
- childId
- itemId
- itemName
- price
- createdAt

## 迁移顺序建议
1. 先上 homeworkTasks / pets / coinLogs
2. 再做 family / children
3. 最后再接 OCR 文件和分享关系链

## 当前判断
v1 选择了更简单的单文档方案（`user_state`），原因：
- MVP 阶段验证产品价值优先，多表化在这阶段不解决关键问题
- `_openid = 主键` 一行代码上云，写就是 replace
- 多设备并发由「单设备登录」机制规避，不需要表级合并
- 真要做长期分析或多家庭体系时再拆表（届时单文档里的 `state.tasks` / `state.coinLogs` 等数组就是迁移源）

仍然继续用微信云开发（不自建后端），原因不变：
- 数据关系不复杂
- 小程序端接入成本低
- 后续如果真要做强社交，再考虑迁移或拆服务
