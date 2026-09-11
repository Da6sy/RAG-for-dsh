# ClueHarness

证据驱动的 agent 产品:自改进知识库(KB)+ 可插拔证据层,基于 Cordis 架构,dsh 发布包作为依赖(不 fork 源码)。

- 设计文档:`../ClueHarness-设计说明.md`(决策总账 25 条)
- 开发记录:`docs/开发记录-M0-M1.md`(逐文件讲解 + 课程锚点 + 踩坑账本 + 自查题)
- 命令入口:`clue`(对话)/ `clue web`(网页面)/ `clue render`(渲染验证)/ `clue kb`(知识库与工作区名单)
- 上游 pin:`@deepseek-ai/*@0.1.1-rc.2`(季度手动升级,compat 层收敛)
- 进度:M0–M6 主线 ✅ · M8 ✅ · **M9 存储中心化 ✅ · M9.1 面板与宿主工作区同源 ✅** — 156/156 测试全绿
- 工作区可见性:`ctx.workspaceRegistry`(dsh 侧,clue 自己的 host home 内)是唯一名单来源;
  侧边栏删工作区 → 面板问"是否一并删除知识库",删除进 `~/.clue/trash/<时间戳>/<键>`(不真删)
- 存放:`~/.clue/kb/<工作区键>`(项目层)、`~/.clue/kb/_global`(全局)、`~/.clue/baselines/<工作区键>`、
  `~/.clue/workspaces.json`(工作区名单,ClueHarness 自有)、`~/.clue/sessions/{cli,web}`。
  **工作区目录里不留任何 ClueHarness 状态**,也不改你的 git 簿记;老布局用 `clue kb migrate` 收回

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
