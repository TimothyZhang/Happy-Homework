# Learnings

Corrections, insights, and knowledge gaps captured during development.

**Categories**: correction | insight | knowledge_gap | best_practice

---
## [LRN-20260420-001] correction

**Logged**: 2026-04-20T11:26:00Z
**Priority**: high
**Status**: pending
**Area**: docs

### Summary
用户明确要求减少无谓确认，除非卡权限或外部资源，否则应直接替用户拍板并推进。

### Details
在小程序 OCR 方案推进中，虽然用户已经多次表达希望我自己决定，我仍然对一些可自行决策的技术路径做了额外征询。用户随后明确指出“不要什么都问我，你自己决定。除非没有权限。”

### Suggested Action
后续遇到技术选型、实现顺序、页面结构、云函数组织方式等可内部决策事项，直接决定并执行。只有在缺少账号、密钥、付费授权、发布权限或外部系统访问权限时再询问。

### Metadata
- Source: user_feedback
- Related Files: SOUL.md, AGENTS.md
- Tags: autonomy, decision-making, user-preference

---
