# ClueHarness

证据驱动的 agent 产品:自改进知识库(KB)+ 可插拔证据层,基于 Cordis 架构,dsh 发布包作为依赖(不 fork 源码)。

- 文档:设计 → `docs/设计.md`(系统为什么长这样:分层/宪法/检索链路/评测方法)
- 历程 → `docs/开发记录.md`(M0 → 现在:每阶段建成了什么、踩过哪些坑、哪些开关没翻、还没做完什么)
- 数字 → `docs/评测结果.md`(公开基准 + 内部合成集 + 判分链路 + 口径纪律)
- 待办 → `docs/落地计划-剩余工程.md`(剩余工程逐项:现状/要改什么/依赖/顺序)
- 决策总账 25 条 → `../ClueHarness-设计说明.md`(仓库外)
- 框架与 API 讲解:`docs/框架与API讲解.md`(除 Cordis 外全量:用了哪些框架、每个 API 在代码里怎么用、特性与坑;含 13 处注释/代码不一致清单)
- 命令入口:`clue`(对话)/ `clue web`(网页面)/ `clue render`(渲染验证)/ `clue kb`(知识库与工作区名单)
- 上游 pin:`@deepseek-ai/*@0.1.1-rc.2`(季度手动升级,compat 层收敛)
- 进度:M0–M9.1 ✅(框架/证据闭环/审批/门禁/知识循环/工作区/两级检索/面板) · V0–V5 ✅(向量混合检索与精排) · R2 ✅(一级换 BM25F) · F0–F2 ✅(评测台 + 能力门控) · **D1–D4 已实现但默认未翻**(见 `docs/开发记录.md` §5) — 353/353 测试全绿
- 两级检索一句话:**Entry 决定"相信什么"、Document 证明"原文是什么"、Chunk 决定"去哪里找"**;
  治理只在条目,原文是不可变快照,分片是可重建的派生索引(`docs/设计.md`)
- 工作区可见性:`ctx.workspaceRegistry`(dsh 侧,clue 自己的 host home 内)是唯一名单来源;
  侧边栏删工作区 → 面板问"是否一并删除知识库",删除进 `~/.clue/trash/<时间戳>/<键>`(不真删)
- 存放:`~/.clue/kb/<工作区键>`(项目层)、`~/.clue/kb/_global`(全局)、`~/.clue/baselines/<工作区键>`、
  `~/.clue/workspaces.json`(工作区名单,ClueHarness 自有)、`~/.clue/sessions/{cli,web}`。
  **工作区目录里不留任何 ClueHarness 状态**,也不改你的 git 簿记;老布局用 `clue kb migrate` 收回

## 两级检索速览(M9)

```bash
# 原文入库:哈希落盘成不可变快照 + 写入时切片(结构优先 800 字;无结构滑窗 800/600)
node apps/cli/src/bin.ts kb ingest docs/规范.md --dry-run     # 只预览分段,不写字节
node apps/cli/src/bin.ts kb ingest docs/规范.md               # 落盘 → 打印 docId
node apps/cli/src/bin.ts kb doc attach <条目id> --doc <docId> --lines 18-24   # 证据挂载(人做)
node apps/cli/src/bin.ts kb doc list                          # 快照清单 + 挂载条目

# 二级检索(纯读取:不记信号、不改状态)
node apps/cli/src/bin.ts kb chunks <docId> --query 焦点        # 按段返回行号 + heading + 摘录
node apps/cli/src/bin.ts kb detail <条目id> --query 焦点       # 从条目下钻到"原文哪一段"

# 治理与人权入口(只有人能做的事;模型只能提案)
node apps/cli/src/bin.ts kb redline <id> --lines 12-30 --reason "组件已改版"   # 划除:显示与评分双过滤
node apps/cli/src/bin.ts kb redline <id> --chars 40-80 --reason "该方案已废弃"  # 正文区间划除
node apps/cli/src/bin.ts kb split <id> --into drafts.json                     # 拆分:旧条 → superseded(终态)

# 生命周期人权入口(不需要攒够窗口分;全部留履历)
node apps/cli/src/bin.ts kb promote <id> --reason "三条独立证据核对过"          # 候选 → 可信(记 human-confirm 信号)
node apps/cli/src/bin.ts kb retire <id> --reason "组件已改版为 v2"            # 候选/可信 → 过期(必须带理由,撤 ⚑)
node apps/cli/src/bin.ts kb reactivate <id> --reason "又被引用了"             # 过期 → 候选(重新挣得可信)
node apps/cli/src/bin.ts kb rescue <id> --reason "复查后其实是对的"            # 遗弃 → 候选(捞回即停 60 天清退)
```

「知识审批中心」面板是这些决定的工作台(四个桶,行内动作,不用切页面):
待批请求(证据驱动,可全批准/全忽略/ AI 润色)· ⚑待复核(复核通过=重绑当前内容 / 不再成立=转过期)
· 候选待提升(提升为可信 / 不再成立)· 已退出(过期→重新激活,遗弃→捞回候选)。

窗口演示(真实浏览器,需要 `npm run build:ui` 与 playwright chromium):

```bash
node scripts/demo-twolevel.mjs   # 徽章 → 分片浏览器 → 划除 → 拆分 → 提升 → 审批工作台(待复核/候选)
```

## 向量混合检索与精排速览（V0–V2）

词法（CJK bigram）与向量**并联召回 → RRF 融合（k=60）→ 确定性特征精排**；
向量层是派生索引（`vectors/` 删了能重建），嵌入走外部 OpenAI 兼容端点，
url / key / model 由第三个设置页「知识检索与向量」管理，**密钥只存引用或凭据存储，永不回显**。
无嵌入配置时**无损降级**为纯词法并在检索结果里如实标注（绝不把词法命中伪装成语义命中）。

```bash
# 配置(CLI 与设置页写同一份文档:$DSH_HOME/settings.yaml + dsh 凭据存储)
node apps/cli/src/bin.ts kb embed-config show                 # 打印非密字段 + 引用名 + 密钥状态(不打印值)
node apps/cli/src/bin.ts kb embed-config set --base-url https://api.siliconflow.cn/v1 \
  --model BAAI/bge-m3 --api-key-env SILICONFLOW_API_KEY --enable
printf %s "$KEY" | node apps/cli/src/bin.ts kb embed-config key --stdin   # 密钥只从 stdin 进
node apps/cli/src/bin.ts kb embed-config test                 # 测试连接 + 实测维度落盘
node apps/cli/src/bin.ts kb embed --dry-run                   # 只算账:零调用零花费

# 使用与诊断
node apps/cli/src/bin.ts kb embed [--only entries|chunks|all] [--rebuild]
node apps/cli/src/bin.ts kb doctor                            # 向量层健康度(缺失/过期/partial/维度不符/未配置)
node apps/cli/src/bin.ts kb query 分片 重建 --explain          # 分数分解:为什么它排第一

# 消融台:每配置一行 + 相对纯词法基线的 delta + 硬护栏
node apps/cli/src/bin.ts recall --embedder hash               # 默认跑 词法/混合 × 精排开关 四行
node scripts/demo-embedding.mjs                               # 真浏览器验收(15 项断言 + 截图)
```

**V3–V5 已落地**：三通道 profile（pre-step/gate/tool，含 query 规范化与标识符只走词法）· 提示词意图句 A/B（真模型）·
二级分段向量 + `kb_detail` 混合 + 面板「向量 N 段」徽章 · `llmRerank`（默认关，用已配置的对话模型真跑）·
LTR 离线实验骨架（`clue kb ltr`，数据不够时明确说"还没到时候"）。
实现记录、实测数字与踩过的坑见 `docs/开发记录.md` §4,当前数字见 `docs/评测结果.md`。
**知识库 UI 与 dsh 设置界面同源**：三个页面的版心(720px)、字号(16/500/24 标题、14/22 说明、12/18 注记)、
圆角(12px 卡片 / 8px 输入)、边框与文字颜色**全部取 dsh 的 `--dsw-*` 令牌与度量**，
标签用 dsh 的 `Pill`、状态点用 `StateDot`、破坏性动作走 `RiskConfirmation`、折叠区用 `DisclosureRow`；
唯一保留的覆盖是强调色（clue 青）。度量断言在 `scripts/demo-embedding.mjs` 里逐项比对。
**设置页有 embedder 选择器**：候选来自你已配置的 provider（`llm-pi-ai.providers` 的 baseURL + apiKeyEnv，
带密钥状态点）＋ 内置目录（dashscope/ark 的已知嵌入模型、本地 Ollama、以及"DeepSeek 无嵌入端点"这条实证否定），
选中即把 baseUrl/model/密钥引用一起写好，维度仍由「测试连接」实测。
**已接入真实嵌入端点**：`clue kb embed-config auto`（或设置页「自动检测并启用」）会遍历本组合已命名的 provider、
用**已经能解析的密钥**逐个探测并启用第一个可用的——不需要重新配置任何东西。
真指标存档：`docs/assets/v1-真端点消融-text-embedding-v4.json`（200 篇/240 查询/4 配置）。
真实语料抽查与徽章截图仍待做。

```bash
# 提示词 A/B:真模型写 query、产品自己检索(两半都不模拟)
clue recall --prompt-ab --samples 48 --batch 6 --chunks 600 --k 1,5
clue kb query <词…> --llm-rerank      # V5:模型重排 + 与确定性精排的差异
clue kb query <词…> --explain --profile gate   # V3:gate profile 下的通道名次与分数分解
clue kb chunks <docId> --query <词…>          # V4:二级检索(有嵌入时自动熔合语义通道)
clue kb ltr                                   # V5:离线 LTR 就绪度/拟合对照(只报告,不改配置)
```

## 检索召回评测（合成集，秒级）

`clue recall` 是 CLI 的一个子命令（`scripts/rag-recall.mjs` 是同一实现的薄壳），随 `clue` 一起全局可用：

```bash
npm link                      # 一次:把 clue 链到全局(node_modules/.bin 与 npm prefix/bin)
clue recall                   # 600 篇 / 300 查询,几秒跑完,任意工作目录下都能跑
clue recall --chunks 2000 --queries 1000 --k 1,5,10,20
clue recall --json            # 机器可读报告
```

自造合成语料(中文技术文本,种子固定 ⇒ 结果可复现)+ 三类查询,**按类别分别报告** recall@K / nDCG@K / MRR:

| 类别 | 含义 | 用途 |
|---|---|---|
| `exact` 逐字引用 | 查询串逐字来自金标分片 | **上限**:应接近 100%,低就是 bug |
| `paraphrase` 同义改写 | 同一主题换措辞(不逐字重复) | **真实难点**:衡量 bigram 匹配的短板 |
| `entity` 实体检索 | 型号/组件名 + 主题 | 代码库/规范检索的常见形态 |

装置自检:每次运行都会用**产品自己的 `queryChunks`** 抽检若干条,并在跑之前校验"金标短语确实在自身语料里"
(生成器这两个坑都真实发生过:短语抽了两次导致查询文本不在金标文档里、短语不唯一导致一个查询有几十个正确答案)。

## 开发

```bash
npm install
npm run clue        # 对话(源码直跑;需 DEEPSEEK_API_KEY,可放 .env)
npm run typecheck   # 全仓类型检查
npm test            # 全部测试
```

**运行时无转译器**:直接 `node xxx.ts`(Node ≥ 22.18 原生类型剥离,零注入)。
这是渲染提取器 `page.evaluate` 自包含契约的前提——tsx/esbuild 会往函数体注入
`__name` 助手导致浏览器内 ReferenceError,详见开发记录踩坑 #9。

**浏览器门禁测试**(确定性门禁等 4 项)需要 Chromium:

```bash
npx playwright install chromium                 # Windows / Arch(缺库按报错补)
npx playwright install --with-deps chromium     # Ubuntu/Debian 一步到位
# Arch 系统库清单:
sudo pacman -S --needed atk at-spi2-atk at-spi2-core cups libdrm libxkbcommon \
  libxcomposite libxdamage libxfixes libxrandr mesa alsa-lib pango cairo nss nspr libxshmfence
```

## 渲染验证速览(M1)

M9 之后**首次升级要做的一件事**(把 M8 存在项目里的库收回中心):

```bash
node apps/cli/src/bin.ts kb migrate --dry-run   # 先看报告(不覆盖、不删)
node apps/cli/src/bin.ts kb migrate             # 真搬:kb/ 基准/渲染面配置 → ~/.clue
node apps/cli/src/bin.ts kb workspace list      # 名单:自动登记的 + 手动添加的
```

```bash
node apps/cli/src/bin.ts render <页.html> --show --mask .volatile    # 单次结构树+检查
node apps/cli/src/bin.ts render <页.html> --record                   # 存基准(待确认)
node apps/cli/src/bin.ts render <页.html> --confirm                  # 人工确认基准
node apps/cli/src/bin.ts render <页.html>                            # 与基准比对(默认)
```
