# ClueHarness for dsh

[English](README.md) | **中文**

一套自包含的 **dsh 插件集**：给 dsh 带来可治理、可引用的知识库，以及一个液态玻璃外观插件。它运行在 dsh 的 web
profile 里，不是独立的命令行或应用。

## 四个插件

| 插件 | 面 | 提供什么 |
| --- | --- | --- |
| `@clue-harness/kb-face` | 宿主 | `ctx.kb`、四个模型侧工具（`kb_search`、`kb_detail`、`kb_propose`、`kb_cite`）、检索优先的 pre-step 注入、原文漂移追踪、回合结束的证据门禁 |
| `@clue-harness/kb-web` | 宿主（HTTP） | 同源 `/api/clue-kb/*` 路由：配置、审批、条目治理、原文与分片、嵌入、检索、导入 |
| `@clue-harness/ui-kb` | 浏览器 | 设置页两个板块（审批中心 + 知识库面板）、引用卡片、会话头知识库抽屉、ClueHarness 品牌与主题层 |
| `@clue-harness/ui-skin` | 宿主 + 浏览器 | 全屏背景、可调遮罩、面板毛玻璃、液态玻璃气泡、终端/文件查看玻璃化，以及设置页「外观与背景」（`ui-clue-skin` 命名空间） |

四个插件共享七个引擎包：`util`、`compat`、`kb`、`rag`、`kb-loop`、`evidence-render`、`eval`。引擎可以单独使用；
`compat` 是包裹知识库所依赖的 dsh API 的薄兼容层。

## 它做什么

- **检索**：倒排索引上的 BM25F、可选的向量通道、RRF 融合、确定性特征精排。没有可用嵌入端点时降级为纯词法，
  并在结果里写明原因——绝不用词法命中冒充语义命中。
- **四个模型侧工具**：`kb_search` 检索、`kb_detail` 下钻原文、`kb_propose` 提出新知识（模型只能提，批准始终由人做）、
  `kb_cite` 声明这一轮真正依据了哪几条。
- **自动检索与核对**：第一步之前按预算注入相关知识；回合结束时若验证失败，证据门禁用失败签名回捞先例。
- **治理**：五态生命周期（候选 / 可信 / 过期 / 遗弃 / 被替代）、审批队列、信号账本、原文不可变快照与漂移检测、
  人工划除与拆分。治理发生在条目上，原文始终是不可变证据。
- **浏览器界面**：dsh 设置页的两个板块、会话头知识库抽屉、工具调用的引用卡片，全部由 dsh 自己的组件与设计令牌构成。
- **外观**：背景预设或本地图片、可调的透出遮罩、面板毛玻璃、液态玻璃气泡、终端/文件查看的玻璃面板。皮肤配置在
  `ui-clue-skin` 命名空间；背景图只存浏览器的 IndexedDB。
- **嵌入端点**：任意 OpenAI 兼容端点；密钥以引用或凭据库的形式传递，永不回显。

## 装进一个 dsh profile

```sh
dsh plugin --profile web add \
  /path/to/clue-harness/plugins/kb-face \
  /path/to/clue-harness/plugins/kb-web \
  /path/to/clue-harness/plugins/ui-kb \
  /path/to/clue-harness/plugins/ui-skin
```

每个插件包自带 `cordis.patch.yml`，只要把四个包列进 profile 的 `dsh.profile.bundles` 就会装配：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@clue-harness/kb-face",
        "@clue-harness/kb-web",
        "@clue-harness/ui-kb",
        "@clue-harness/ui-skin"
      ]
    }
  }
}
```

浏览器那一半构建一次：

```sh
npm run build:ui   # plugins/ui-kb/lib/client.js + plugins/ui-skin/lib/client.js
```

**本地 TypeScript 插件要用链接，不能复制进 `node_modules`。** Node 的类型剥离拒绝 `node_modules` 下的文件
（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`）。参考 profile 对 `ui-skin` 用 `link:`，另外三个用符号链接的插件目录。
发布编译产物是另一条可用路线。

参考 profile 可能使用 `ui-kb`/`kb-web` 的**无品牌 staging 副本**；本仓库保存的是带 ClueHarness 品牌的源码。
对比运行中的界面与这份源码时请留意这一点。

## 配置

- **知识库**：dsh 设置页「知识检索与向量」。可以选嵌入模型并测试连接、调整融合/召回深度/候选数/精排、构建或重建
  向量层，以及查看健康度。`kb-face` 的 `config.cwd` 是默认工作区锚点；一次会话真正落在哪个项目知识库上，由会话
  自己校验过的工作区 cwd 决定。
- **知识位置**：项目层 `~/.clue/kb/<工作区键>`，共享层 `~/.clue/kb/_global`，都在工作区之外，也不改动你的 git 簿记。
- **外观**：dsh 设置页「外观与背景」。观感预置有「清晰 / 均衡 / 磨砂」；「清晰」= 通透度 100% + 模糊 0。通透度与
  模糊是分开控制的。终端和文件查看跟随同一组玻璃参数。会话头保留玻璃 tint，但去掉了模糊，因为知识库抽屉是固定在
  它里面的；如果头部有滤镜，抽屉会被裁成头部高度。

## 目录

```
plugins/   ui-skin、ui-kb、kb-web、kb-face
packages/  util、compat、kb、rag、kb-loop、evidence-render、eval
```

## 开发

```sh
npm install
npm run build:ui
npm run typecheck
npm test
```

`npm test` 运行 `packages/` 与 `plugins/` 里的 386 项单元/契约测试（参考机器约 7.5 秒）。浏览器那一半用 esbuild
构建。`ui-skin` 的契约测试会读取已安装的 dsh 客户端 bundle，因此 dsh 客户端包声明在它的 devDependencies 里。

## 技术栈

- Node.js 22.19+（TypeScript 源码，类型剥离）
- TypeScript 6、Cordis、React 18、esbuild
- dsh 0.2.0-rc.2 发布包（固定版本）
- 仅用 Node 文件系统：原子写 JSON 与 JSONL 账本——不引入数据库，也不引入向量库
- Playwright / Chromium 只用于引擎层的 evidence-render 测试

## License

MIT
