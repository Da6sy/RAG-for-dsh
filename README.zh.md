# RAG-for-dsh

[English](README.md) | **中文**

给 **dsh** 的知识库与检索插件：把项目里学到的东西——约定、踩过的坑、来之不易的结论——变成**可检索、可引用、
可治理**的知识，会话过程中自动检索，回合收尾时再核对一遍。

## 它做什么

- **检索**：走倒排索引的 BM25F（3.6k 条目下单查询约 67ms）、可选的向量通道、RRF 融合、确定性特征精排。
  没有可用嵌入端点时降级为纯词法，并在结果里写明原因——绝不用词法命中冒充语义命中。
- **四个模型侧工具**：`kb_search` 检索、`kb_detail` 下钻原文、`kb_propose` 提出新知识（只能提，批准始终由人做）、
  `kb_cite` 声明这一轮真正依据了哪几条。
- **自动检索与核对**：第一步之前按预算注入相关知识；回合结束时若验证失败，证据门禁用失败签名回捞先例。
- **治理**：五态生命周期（候选 / 可信 / 过期 / 遗弃 / 被替代）、审批队列、信号账本、原文不可变快照与漂移检测、
  人工划除与拆分。治理发生在条目上，原文始终是不可变证据。
- **界面**：dsh 设置页上的两个板块（审批中心、知识库面板）、会话头的知识库抽屉、工具调用的引用卡片——
  全部由 dsh 自己的组件与设计令牌构成。
- **嵌入端点**：任意 OpenAI 兼容端点；密钥以引用或凭据库的形式传递，永不回显。

## 安装

```sh
dsh plugin --profile web add /path/to/RAG-for-dsh/plugins/spine /path/to/RAG-for-dsh/plugins/kb-face /path/to/RAG-for-dsh/plugins/kb-web /path/to/RAG-for-dsh/plugins/ui-kb
```

每个插件包自带 `cordis.patch.yml`，只要这些包被列进 profile 的 `dsh.profile.bundles`，对应的行就会装配进去。
浏览器那一半需要构建一次：`node plugins/ui-kb/build.mjs`。

## 使用

工具就是普通的 dsh 工具，模型自行调用；注入与证据门禁对每个会话自动生效，不需要额外接线。

在 dsh 设置页「知识检索与向量」里可以选嵌入模型并测试连接、调整融合与召回深度/候选数/精排档位与配额、
构建或重建向量层，以及查看向量层健康度与 ranklog 摘要。

命令行里可以用 `clue kb` 管理同一份数据：审批、治理（`redline` / `split` / `retire` / `rebind`）、原文入库、
检索取证（`query --explain`）、跨项目泛化、旧布局迁移；`clue web` 会用同一套插件起一个本地实例。

知识存放在工作区之外，也不改动你的 git 簿记：项目层 `~/.clue/kb/<工作区键>`、共享层 `~/.clue/kb/_global`、
渲染基准 `~/.clue/baselines/<工作区键>`。

## 技术栈

- Node.js 22+（直接运行 TypeScript）
- TypeScript 6
- Cordis（插件树、`ctx` 服务、工具与 slot 注册、patch 层）
- `@deepseek-ai/dsh-*`（固定版本的发布包）
- React 18 与 `@deepseek-ai/dsh-client-ui-primitives`、`ui-slots`
- esbuild（浏览器 bundle）
- Playwright / Chromium（证据层）
- 仅用 Node 文件系统：原子写 JSON 与 JSONL 账本——不引入数据库，也不引入向量库

## 目录

```
plugins/     四个 dsh 插件包：spine、kb-face、kb-web、ui-kb（各带自己的 cordis.patch.yml）
packages/    引擎库：util、kb、rag、kb-loop、evidence-render、eval、compat
apps/cli/    clue 命令行（知识库管理、本地 web 实例、评测台）
scripts/     基准与演示脚本（BEIR 跑分、端到端演示、诊断取证）
```

## 开发

```sh
npm install
npm test          # 393 项测试，含真浏览器门禁
npm run typecheck
npm run build:ui
```
