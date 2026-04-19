# 云开发数据结构草案

这是当前小程序从“本地原型版”迁移到“云开发版”的数据草案。

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
- growth
- nextLevelGrowth
- happiness
- fullness
- updatedAt

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
最适合先接微信云开发，不建议现在就自建后端。
原因：
- 当前阶段目标是快速验证 MVP
- 数据关系不复杂
- 小程序端接入成本低
- 后续如果真要做强社交，再考虑迁移或拆服务
