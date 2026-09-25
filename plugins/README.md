# 插件（dsh 插件包）

这一层是给 **dsh** 用的插件，每个包都能单独加进一个 dsh profile。引擎库（`packages/`）不是插件，
它们只被插件引用；`apps/cli` 是本地开发/管理用的命令行壳，不是运行时的必需品。

| 插件包 | 面 | 提供了什么 |
|---|---|---|
| `@clue-harness/spine` | 宿主 | 在 `ctx` 上挂 llm / session / system-prompt / tools / agents / retry / agent-loop —— 其余插件要挂靠的"底座"（`dsh-base` 之外的会话骨架） |
| `@clue-harness/kb-face` | 宿主 | `ctx.kb` 服务 · `kb_search` / `kb_detail` / `kb_propose` / `kb_cite` 四个工具 · 检索优先的 pre-step 注入 · 文件变更追踪 · 回合结束的**证据门禁**（失败签名先例检索） |
| `@clue-harness/kb-web` | 宿主（HTTP） | `/api/clue-kb/*` 同源 JSON 路由：配置、密钥状态、检索、条目治理、审批、向量层、导入 |
| `@clue-harness/ui-kb` | 浏览器 | 设置页两个板块（审批中心 + 知识库面板）· 工具调用的引用卡片 · 会话头知识库抽屉 · 品牌与主题令牌层 |

## 每个包都带一份 `cordis.patch.yml`

`package.json` 里的 `dsh.bundle.patch` 指向它，所以这些包可以直接列进 profile 的
`dsh.profile.bundles`，不需要你手写行；`ui-kb` 另有 `dsh.client`（`platform: web` + `inject`），
dsh 的客户端模块系统据此把它的 `lib/client.js` 接进浏览器启动图。

## 装进一个 dsh profile

```sh
# 1) 装依赖（本地路径版；发布到 npm 之后可以直接写包名）
dsh plugin --profile web add \
  /path/to/RAG-for-dsh/plugins/spine \
  /path/to/RAG-for-dsh/plugins/kb-face \
  /path/to/RAG-for-dsh/plugins/kb-web \
  /path/to/RAG-for-dsh/plugins/ui-kb

# 2) 让它们成为这一层的 bundle（顺序有意义：spine 在前）
#    $DSH_HOME/profiles/web/package.json
#    "dsh": { "profile": { "bundles": [
#      "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
#      "@clue-harness/spine", "@clue-harness/kb-face",
#      "@clue-harness/kb-web", "@clue-harness/ui-kb" ] } }

# 3) 浏览器那一半要构建一次
pnpm --filter @clue-harness/ui-kb build     # 或 node <repo>/plugins/ui-kb/build.mjs

# 4) 不启动、先看装配结果（我们的行会各自标出由哪个 bundle 贡献）
dsh --profile web --dump-config | grep -A3 clue
```

`kb-face` 的 `config.cwd` 是默认工作区锚点；一次会话真正落在哪个项目知识库上，由会话自己校验过的工作区 cwd 决定。

## 依赖与边界

- 宿主插件（spine / kb-face / kb-web）**只依赖 dsh 的发布包**（`@deepseek-ai/dsh-*`），不 fork 源码。
- 浏览器插件 `ui-kb` 的外部依赖**只有 dsh 客户端基线**（react 家族 / cordis / ui-slots / ui-primitives / runtime），
  自研代码全部内联进 `lib/client.js`。
- 引擎库（`packages/{util,kb,rag,kb-loop,evidence-render,eval}`）**零 dsh 依赖**，可以单独拿来用。
