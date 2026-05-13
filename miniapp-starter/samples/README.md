# homeworkOCR 测试样本库

放手写作业登记本照片 + 对应的 ground truth,用来离线评估 OCR prompt 的召回/准确度。

## 目录约定

```
samples/
  README.md                       # 本文档
  .gitignore                      # 默认忽略 .jpg/.png(避免把真实手写图入仓);
                                  #   想入仓的样本单独 `git add -f`
  <sample-id>.json                # ground truth + 元数据
  <sample-id>.jpg                 # 对应图片(同名,扩展名 jpg/png/webp 都行)
```

## Sample JSON schema

```json
{
  "id": "homework-2026-04-20",
  "image": "homework-2026-04-20.jpg",
  "capturedAt": "2026-04-20",
  "notes": "三年级手写作业登记本,字迹中等",
  "groundTruth": [
    { "subject": "语文", "content": "17课生字" },
    { "subject": "语文", "content": "17课抄书本" },
    { "subject": "数学", "content": "口算" },
    { "subject": "数学", "content": "练习六(1)改错明天交" },
    { "subject": "数学", "content": "四单元举一反三(周三交)" },
    { "subject": "英语", "content": "L15、L16课目标" },
    { "subject": "英语", "content": "明天听L15~L16" },
    { "subject": "英语", "content": "改卷子" }
  ]
}
```

字段:
- `id`(可选):缺省用文件名(去掉 .json)
- `image`(必填):图片路径,相对于本 JSON 文件;允许绝对路径
- `capturedAt`(可选):YYYY-MM-DD,纯标注用
- `notes`(可选):备注(字迹清晰度、特殊场景等)
- `groundTruth`(必填):期望的作业列表,每条 `{subject, content}`
  - `subject`:`语文|数学|英语|科学|道法|美术|音乐|体育|劳动|其他` 或空字符串
  - `content`:作业完整内容(含截止日如"周三交"、范围如"练习六(1)"等)

## 添加新样本

1. 把图片放在 `samples/` 下,命名 `<sample-id>.jpg`(`.gitignore` 默认忽略)
2. 新建同名 `<sample-id>.json`,填好 ground truth
3. 跑 `node scripts/eval-homework-ocr.js` 验证

## 离线评估

```bash
# 跑所有样本
AZURE_OPENAI_API_KEY=...  AZURE_OPENAI_ENDPOINT=...  AZURE_OPENAI_DEPLOYMENT=gpt-5.5 \
  node miniapp-starter/scripts/eval-homework-ocr.js

# 跑指定样本
node miniapp-starter/scripts/eval-homework-ocr.js samples/homework-2026-04-20.json

# 调档 reasoning effort
OCR_REASONING_EFFORT=none  node miniapp-starter/scripts/eval-homework-ocr.js
```

## 评估算法

- **匹配**:每对 (expected, draft) 算字符级 Dice 系数 `2|A∩B|/(|A|+|B|)`,要求 subject 一致(或都空)
- **配对**:贪心 1-to-1(按分数降序),阈值 0.5
- **召回 (recall)**:matched / |ground truth|
- **精确度 (precision)**:matched / |drafts|
- **strict avg score**:命中 pair 的平均 Dice 系数(衡量"匹配上的有多接近")
