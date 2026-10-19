# 插件（dsh 插件包）

这一层是给 **dsh** 用的四个插件包，每个包都能单独加进一个 dsh profile。引擎库（`packages/`）不是插件，只被插件引用。
仓库不再包含 CLI 或独立应用。

| 插件包 | 面 | 提供了什么 |
|---|---|---|
| `@clue-harness/kb-face` | 宿主 | `ctx.kb` 服务 · `kb_search` / `kb_detail` / `kb_propose` / `kb_cite` 四个工具 · 检索优先的 pre-step 注入 · 原文漂移追踪 · 回合结束的**证据门禁**（失败签名先例检索） |
| `@clue-harness/kb-web` | 宿主（HTTP） | `/api/clue-kb/*` 同源 JSON 路由：配置、密钥状态、检索、条目治理、审批、原文/分片、向量层、导入 |
| `@clue-harness/ui-kb` | 浏览器 | 设置页两个板块（审批中心 + 知识库面板）· 工具调用的引用卡片 · 会话头知识库抽屉 · 品牌与主题令牌层 |
| `@clue-harness/ui-skin` | 宿主 + 浏览器 | 外观美化：全屏背景 / 可调遮罩 / 面板毛玻璃 / 液态玻璃气泡 / 终端与文件查看玻璃化 · 设置页「外观与背景」· 配置走 dsh settings（`ui-clue-skin` 命名空间），图片存浏览器 IndexedDB |

## 每个包都带一份 `cordis.patch.yml`

`package.json` 里的 `dsh.bundle.patch` 指向它，所以这些包可以直接列进 profile 的 `dsh.profile.bundles`，不需要你手写
装配行；`ui-kb` 与 `ui-skin` 另有 `dsh.client`（`platform: web` + `inject`），dsh 的客户端模块系统据此把它们的
`lib/client.js` 接进浏览器启动图。

## 装进一个 dsh profile

```sh
# 1) 装依赖（本地路径版；发布到 npm 之后可以直接写包名）
dsh plugin --profile web add \
  /path/to/clue-harness/plugins/kb-face \
  /path/to/clue-harness/plugins/kb-web \
  /path/to/clue-harness/plugins/ui-kb \
  /path/to/clue-harness/plugins/ui-skin

# 2) 让它们成为这一层的 bundle
#    $DSH_HOME/profiles/web/package.json
#    "dsh": { "profile": { "bundles": [
#      "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
#      "@clue-harness/kb-face", "@clue-harness/kb-web",
#      "@clue-harness/ui-kb", "@clue-harness/ui-skin" ] } }

# 3) 浏览器那一半构建一次（两个插件一起）
npm run build:ui

# 4) 不启动、先看装配结果
dsh --profile web --dump-config | grep -A3 clue
```

**本地 TypeScript 插件要用链接，不能复制进 `node_modules`。** Node 的类型剥离拒绝 `node_modules` 下的文件
（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`）。参考 profile 对 `ui-skin` 用 `link:`，另外三个用符号链接的插件目录；
发布编译产物是另一条可用路线。

参考 profile 可能使用 `ui-kb`/`kb-web` 的**无品牌 staging 副本**；本仓库保存的是带 ClueHarness 品牌的源码。对比运行中
的界面与这份源码时请留意这一点。

`kb-face` 的 `config.cwd` 是默认工作区锚点；一次会话真正落在哪个项目知识库上，由会话自己校验过的工作区 cwd 决定。

## 依赖与边界

- 宿主插件（kb-face / kb-web）**只依赖 dsh 的发布包**（`@deepseek-ai/dsh-*`）与 `packages/` 里的引擎，不 fork dsh 源码。
- 浏览器插件 `ui-kb` / `ui-skin` 的外部依赖**只有 dsh 客户端基线**（react 家族 / cordis / ui-slots / ui-primitives /
  runtime），自研代码全部内联进各自的 `lib/client.js`。
- 引擎库（`packages/{util,compat,kb,rag,kb-loop,evidence-render,eval}`）大多零 dsh 依赖；`compat` 是包裹知识库所依赖
  的 dsh API 的薄兼容层。
