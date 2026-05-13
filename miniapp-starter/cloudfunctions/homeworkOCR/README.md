# homeworkOCR 云函数

这是“作业登记本 OCR”能力的云函数入口。

## 当前状态
- **真实闭环已通**，已部署到云开发环境 `cloud1-d8gkzu6ls85efd509`
- 多 provider 兜底：OpenAI Vision → 腾讯云 OCR（GeneralHandwriting → Accurate → Basic）→ 微信 OpenAPI → Tesseract.js
- 主链路：`imageFileID → 取临时 URL/下载 → OCR provider 兜底 → rawText → parseHomeworkRegister → drafts`
- 部署 + 环境变量配置详见仓库根 `CLOUD-SETUP.md`

## 当前采用方案
### 多 provider 兜底
设计成"前一个失败/返回空才试下一个"，所以 provider 顺序就是优先级。当前顺序是 **OpenAI Vision → 腾讯云**（手写体优先）**→ 微信 OpenAPI → Tesseract.js**。可通过 `OCR_PROVIDER` 环境变量强制只走某一条（`openai` / `tencent` / `wechat`）。

> 业务密钥不放小程序前端，全部走环境变量在云函数里读。

## 这个函数建议的输入
```json
{
  "imageFileID": "cloud://..."
}
```

## 需要的环境变量

### 模型与 reasoning effort

默认在代码里写死(`cloudfunctions/homeworkOCR/index.js` 顶部 `DEFAULT_OPENAI_MODEL` / `DEFAULT_REASONING_EFFORT`):

- `DEFAULT_OPENAI_MODEL = 'gpt-5.5'` —— Azure 用对应同名 deployment
- `DEFAULT_REASONING_EFFORT = 'none'` —— 实测 ~12s,跑得进 60s 云函数 timeout 上限;召回与 'low'(17s) 同样是 75%,只有个别细节略差(如"听写"识别成"抄写"会偶发)

换模型时两个常量要同步评估,不同模型支持的 effort 值不一致:
- gpt-5 / o-series:`'minimal' | 'low' | 'medium' | 'high'`
- gpt-5.5+:`'none' | 'low' | 'medium' | 'high' | 'xhigh'`(不再支持 'minimal')

为什么不用召回更稳的 'low'? 见 [CLOUD-SETUP.md 坑 8](../../CLOUD-SETUP.md):腾讯云函数免费档 timeout 上限 60s,冷启动 + 图下载 + gpt-5.5 + 'low' 推理常超时;'none' 给云端跑留出充足余量。本地脚本调试可以用 `OPENAI_REASONING_EFFORT=low` 拿到更稳的效果。

### OpenAI（官方 api.openai.com）
- `OPENAI_API_KEY`
- 可选：`OPENAI_OCR_MODEL` —— 覆盖默认模型
- 可选：`OPENAI_REASONING_EFFORT` —— 覆盖默认 reasoning effort
- 可选：`OPENAI_BASE_URL`，默认 `https://api.openai.com/v1`
- 可选：`OPENAI_OCR_TIMEOUT_MS`，默认 `45000`

### Azure OpenAI

本项目用的 `pbs-0.openai.azure.com` 资源约定 **deployment 名 == 模型名**(`gpt-5.5` / `gpt-5` / `gpt-4o` 等),所以**只配两个 env 就够**:

- `AZURE_OPENAI_API_KEY` —— Azure 资源的 key
- `AZURE_OPENAI_ENDPOINT` —— `https://<resource>.openai.azure.com`,**不带** `/openai`

可选(几乎用不到):
- `AZURE_OPENAI_DEPLOYMENT` —— Azure 门户里 Deployments 列出来的 name。**仅当 deployment 名和模型名不同时**才需要;否则代码自动用 `OPENAI_OCR_MODEL || DEFAULT_OPENAI_MODEL` 当 deployment 名。
- `AZURE_OPENAI_API_VERSION`,默认 `2025-04-01-preview`(Responses API 需要 ≥ 2025-03 系列)

### 调用方式
默认走 **Responses API**（`/openai/responses`），匹配 GPT-5 / GPT-5.5 / o-series 等推理模型；遇到 Azure 部署只支持 Chat Completions 时会自动 404 回退到 `/openai/deployments/{deployment}/chat/completions`。
- 可选：`OPENAI_USE_CHAT_COMPLETIONS=true` 强制只走 Chat Completions（GPT-4o/4-turbo 等老部署可用）
- 可选：`OPENAI_OCR_MAX_TOKENS` / `OPENAI_OCR_REASONING_MAX_TOKENS` —— 非推理 / 推理模型的输出 token 上限

## 建议返回
```json
{
  "ok": true,
  "rawText": "...",
  "drafts": [
    {
      "subject": "语文",
      "content": "抄写第3课生字两遍"
    }
  ]
}
```

## 本地脚本调试 prompt

不想每次改 prompt 都重部署整个云函数,有两个本地脚本走同一份 prompt(`scripts/lib/homework-ocr.js`):

- [`scripts/test-homework-ocr.js`](../../scripts/test-homework-ocr.js) —— 单图 ad-hoc
- [`scripts/eval-homework-ocr.js`](../../scripts/eval-homework-ocr.js) —— 批量评估 `samples/` 下所有样本,输出召回/精确度

前置:`~/.zshrc` 里有 `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT`(本机已配,见 [samples/README.md](../../samples/README.md))。

```bash
# 跑单张图(自带 ground truth 时会打分)
node miniapp-starter/scripts/test-homework-ocr.js samples/homework-2026-04-20.json

# 批量评估
node miniapp-starter/scripts/eval-homework-ocr.js

# 复现云函数(60s timeout)下的行为
OCR_REASONING_EFFORT=none  node miniapp-starter/scripts/eval-homework-ocr.js
```

prompt 调通后,改 `cloudfunctions/homeworkOCR/index.js` 里的同款字符串(`scripts/lib/homework-ocr.js` 顶部的 `USER_PROMPT` 也要同步),再重新部署。

跑 `node miniapp-starter/scripts/check-prompt-sync.js` 验证两边一致(0 = OK,非 0 = drift)。
