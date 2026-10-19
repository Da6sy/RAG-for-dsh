# `@clue-harness/ui-skin` — dsh Web 外观插件

一张背景铺满整个窗口,侧栏、对话区、停靠面板、浮动窗口、设置页和输入框以毛玻璃浮在上面,用户气泡是液态玻璃。所有样式走 dsh 的稳定钩子;所有设置写进 dsh 自己的 settings section,刷新/重启保留。

> 依据:`docs/设计规划_前端UI美化插件.md`。W0 选择器普查与实现中的设计取舍见该文档末尾的「附录 A」,以及本文 §2。

## 1. 能做什么

| 能力 | 行为 |
|---|---|
| 背景 | 本地图片(IndexedDB,≤8 MB)/ 外链 URL / 三套内置渐变(极光·暮色·雾海)/ 关闭 |
| 遮罩 | 不透明度 0–0.9;颜色自动跟随深浅主题,也可自定义 |
| 面板玻璃 | 侧栏、对话区、右侧停靠区、浮动窗口、设置页、输入框统一 `backdrop-filter` 磨砂 + 半透明表面 |
| 液态玻璃气泡 | 渐变高光 + 内描边 + 2% 噪声 + 模糊;只作用于用户消息(含发送中的回声气泡) |
| 终端 / 文件查看 | 右侧栏终端与文档预览同样走面板玻璃:终端面板一层 tint + xterm 背景透明(DOM 渲染器),文件/代码/PDF 预览只加浅 veil,均受通透度与模糊控制 |
| 侧栏动画 | 左侧栏/右侧栏收起展开与对话区走同一条 0.3s grid 轨道,连接处不跳;pointerdown/keydown 预先上膛,修复 dsh 自身过渡时有时无的问题;拖拽/全屏/减弱动画仍即时 |
| 圆角补丁 | Windows 会话栏左上角 16px 圆角外的缺口,用会话表面 + 同一磨砂补一块径向遮罩的 16x16 补丁;随侧栏边同曲线移动 |
| 可读性护栏 | 按背景实测平均亮度 + 遮罩算出每个表面的对比度下限,自动抬升面板/气泡不透明度,保证正文与气泡 ≥ 4.5:1 |
| 性能 | `auto` / `低功耗`;低功耗关气泡与背景模糊、面板模糊降到 4px、表面加深 |
| 主题 | 跟随 `body[data-ds-dark-theme]` 实时切换,浅色用浅遮罩、深色用深遮罩 |
| 设置页 | 设置 → 外观与背景:实时预览 + 五组控件 + 恢复默认 |
| 默认 | `bgKind=none`,装上插件**不改变**任何外观,选择背景后才生效 |

## 2. 设计取舍(实现时拍板的地方)

1. **遮罩默认 0.24,不是文档 §3.4 的 0.35 / §3.8 的 0.18。** 原文这两处互相矛盾(颜色与深浅方向都相反)。实测定案:一个不透明度 + 自动颜色(深色 `#0a0f18`、浅色 `#f2f4f8`)。0.24 是像素级对比后的结果——更高的遮罩叠加玻璃会把壁纸压成一片纯色;可读性由护栏负责,不需要靠遮罩拉满。
2. **面板不透明度按主题分曲线。** 浅色玻璃(白 0.57)比深色玻璃(0.67)更透明:同样的 alpha 下,白色表面会把浅色壁纸洗白。设置页、终端与文件查看保持略高一点的 tint(终端/文件 = base + 0.08,再走护栏)。
3. **客户端选择器按真实 DOM 深度重写。** 渲染器在 `#root` 与 AppFrame 之间多了一层 `[data-slot="root"]`;旧选择器 `#root > div > div:first-child` 实际命中的是**整个 frame**,于是全景被 `backdrop-filter` 磨砂、侧栏列从未被真正瞄准。Windows 桌面壳还会在中心列再刷一层 `--dsw-alias-bg-base`,叠加后壁纸几乎被压成纯黑。现在:frame 透明且不磨砂、侧栏列磨砂、中心列透明、真正的对话根只铺一层 tint。详见设计规划附录 A.6。
4. **设置页不再压成黑块。** 设置遮罩改成主题化的一层 `--cl-xs-settings-mask`(深 0.22 / 浅 0.35),面板 alpha 从 +0.16 降到 +0.06;设置页现在是玻璃而不是 50% 黑遮罩上的实心深色块。
5. **气泡的钩子是回退方案。** dsh 的用户气泡没有语义 `data-*`,只有 CSS Modules 的局部类名 `bubble`。本插件用 `[data-chat-flow-kind="user"] [class*="bubble"]`(及其 steering / 回声变体),并用契约测试锁定已发布 dsh 包里的 `*_bubble` 局部名。上游一旦改名,测试先红,而不是悄悄失效。
6. **助手回复不做气泡。** dsh 的助手输出是文档式正文;给每条回复套玻璃卡片会破坏阅读节奏,也会把"气泡"这个设计词用错地方。液态玻璃只用于用户消息与发送中的回声。
7. **终端与文件查看也玻璃化(2026-10-19 追加)。** 终端面板的 `--dsw-alias-bg-base` 置空,终端 screen 保留**一层** tint(比对话略强,守卫仍保证 4.5:1);xterm 6 在本组合里用的是 **DOM 渲染器**(没有 canvas addon),主题背景被写成 `.xterm-scrollable-element` 的内联样式,用一条 `!important` 把它清成透明 —— 这样 screen 的 tint 只有一层,且 dsh 传给 xterm 主题的背景色仍是真实表面色(文字对比度算法不会误判)。文件预览同理:preview 根一层 document tint,`[data-document-markdown]` 根透明,代码块/行内代码/PDF 只加 12–20% 的浅 veil。若上游改用 canvas 渲染器,终端会退化为"screen tint + 不透明画布",不会假装透明。
8. **含 fixed 浮层的容器一律不直接加 `backdrop-filter`(2026-10-19 Windows 修复)。** 滤镜会给 `position: fixed` 后代建立定位参照物(containing block)。Windows 的侧栏 toggle / 收起后的新建会话在侧栏列里是 fixed,ui-kb 的知识库抽屉在会话头里是 fixed,dockkit 浮窗在右侧栏列里是 fixed —— 都曾被滤镜劫持:按钮下移 40px 并压住品牌图标,收起后侧栏控件被裁掉,知识库抽屉被压成 75px 高的一条。现在侧栏 frost 走 `::before` + `z-index: 2`,会话头只保留 tint(去掉这 76px 的模糊),右侧栏 frost 下放到已停靠的 `[data-dockkit-pane]`。加玻璃前先查这个容器里有没有 fixed 后代。
9. **侧栏/右栏 track 动画预先上膛(2026-10-19 追加)。** dsh 的 AppFrame 只在 React 的 data-animating 状态存在时才对 grid-template-columns 做过渡,而这个状态在 layout effect 里写,可能和新的 grid 值同一次样式计算生效,导致过渡属性第一次出现时已经是新值,浏览器不做过渡;右栏面板自己的 transform 又一直有过渡,所以只剩一边在动。ui-skin 在 pointerdown/keydown 捕获阶段先给 frame 打 data-cl-xs-track-animating,样式用 :where(...) 把过渡属性特异性降到 0,让 dsh 自己的拖拽/全屏/instant/reduced-motion 的 transition:none 继续优先;600ms 后自动摘除。三条 grid 轨道(侧栏/会话/右栏)因此一起走 0.3s,连接处是同一条 grid 边。详见设计规划附录 A.9。

   帧率/右侧边界:皮肤在动画路径上没有逐帧 JS;给 `[data-conversation-content]` 和 `[data-dockkit-pane]` 加了 `contain: layout`(不裁剪、固定浮层不在这些元素内),并给右栏 dock 面板加 `will-change: transform`。临时 dsh web(1405×821,皮肤开启,右栏开合)headless Chromium 实测:不降模糊约 **46fps**(帧间隔 16–51ms);在 shell 的 `data-animating` 期间把会话区/侧栏/右栏的 `backdrop-filter` 临时设为 `none`,**动画帧间隔 16–17ms(60fps)**,静止后恢复 `blur(10px) saturate(1.26)`,tint 保留、颜色不变。也就是说,过渡的 0.3s 是“无模糊但颜色不变”的玻璃,静止画面仍是完整磨砂;这是为帧率做的显式取舍。右侧面板的 transform 与会话栏 grid 轨道是两条时间线;UI 插件曾用 rAF 逐帧贴边,实测反而落后一帧(开合 60ms 附近边界差可达 178px),已撤回;要真正贴边/高刷稳定,需要 dsh 源码让面板位置由轨道或列裁剪决定。
10. **Windows 会话栏左上角补丁(2026-10-19 追加)。** Windows 会话栏的 16px 左上圆角会把玻璃裁出一个缺口,露出后面的壁纸;ui-skin 在 frame 的 `::after` 用会话表面 + 同一磨砂补一块 16x16、径向遮罩只填圆角外缺口,位置读 frame 的内联 grid 首轨,并在轨道过渡时用同一条 0.3s 曲线 `transition: left`;拖拽/窗口缩放不补间。收起时宽内容仍按 dsh 的 Windows `wide` 逻辑立即卸载;DOM 残影方案实测会带来闪烁/位移/顿挫,已撤回,不再使用。
11. **Windows 原生标题栏按钮底色(2026-10-19 追加)。** 最小化/最大化/关闭是 Electron 的 `titleBarOverlay`,不是 DOM,CSS 不能直接改。桌面端 preload 用一个隐藏探针(内联 `background-color:var(--dsw-specific-sidebar-fill)`)量色,经 `windowsAppearance` IPC 传给主进程 `setTitleBarOverlay`。ui-skin 覆盖这个探针:

```css
html[data-cl-xs-on] body > span[style*='--dsw-specific-sidebar-fill'] {
  background-color: transparent !important;
}
```

原生按钮的底色因此透明、页面玻璃透上来;符号色仍由 `--dsw-alias-label-primary` 决定,悬停仍是原生/Electron 行为。选择器依赖 preload 的实现细节,audit 为它开了唯一一个 `[style]` 例外;`!important` 总数为 2(xterm 内联背景 + 这个探针)。不重新打包桌面端也生效。

12. **内置三套渐变。** 文档只要求 none/image/url;加 `preset` 是为了让用户不选图也能立即看到效果,零存储、纯 CSS。深浅主题各有独立配色。
13. **配置走 dsh settings section,不写 localStorage。** 宿主半边把 16 个字段声明为 `.volatile()`;浏览器用 `ctx.configForms.get('ui-clue-skin')` 读写,写入落进 profile 的 patch 文件(0.2 机制)。图片是唯一的浏览器本地状态(IndexedDB),因此换机器时配置还在、图片需要重传——设置页会明确提示。
14. **插件 id 就是设置命名空间。** 行 id `ui-clue-skin` 同时是 cordis patch 的 entry id 与 `ctx.configForms` 的 key。改名会同时改三处,已写进测试。

## 3. 结构

```
src/
  skin-config.ts       纯配置模型:默认值、区间、主题色、三套预置渐变
  contrast.ts          WCAG 对比度、sRGB 合成、alpha 下限搜索
  plan.ts              每个表面的 alpha 与对比度(可读性护栏)
  audit.ts             样式表选择器契约检查(测试用)
  index.ts             宿主半边:Config schema + 关闭自动表单页
  client/
    index.ts           注册样式表、控制器、settings.section
    styles.ts          整张样式表(CSS 变量 + data-cl-xs-* 开关)
    controller.ts      settings 合并、壁纸解析、CSS 变量投影、防抖写回
    frame-animation.ts 侧栏/右栏 track 过渡预置(pointerdown/keydown,600ms)
    image-store.ts     IndexedDB 图片、亮度测量、URL 加载
    Section.tsx        「外观与背景」设置页
    controls.tsx       range / 九宫格 / 选项组 / 二次确认按钮
test/
  ui-skin.test.ts      配置、对比度、护栏、选择器审计
  contract.test.ts     与已安装 dsh 客户端包的钩子契约
```

浏览器 bundle 的构建与 ui-kb 完全同构:`lib/client.js` 是交给 `window.__ModuleLoader__.load` 的 CJS 工厂,外部依赖只有 dsh 客户端基线(react 家族 / cordis / ui-slots / ui-primitives),其余全部内联。

## 4. 安装

```sh
# 1) 构建浏览器半边(仓库根)
npm run build:ui

# 2) 装进 dsh profile
dsh plugin --profile web add /home/daisy/app/clue-harness/plugins/ui-skin

# 3) 让这一行成为 profile bundle(settings 编辑器要能按组合层找到它)
#    ~/.dsh/profiles/web/package.json
#    "dsh": { "profile": { "bundles": [ ..., "@clue-harness/ui-skin" ] } }

# 4) 重启 dsh web;设置 → 外观与背景
```

插件自己的 `cordis.patch.yml` 只插入一行:

```yaml
- insert:
    - id: ui-clue-skin
      name: '@clue-harness/ui-skin'
```

要让当前 dsh web profile 生效:把该包加进 profile 的 `dsh.profile.bundles`(参考 profile 已这样做),运行
`npm run build:ui`,再完全重启客户端。

## 5. 设置项

| 组 | 键(settings 字段) | 默认 |
|---|---|---|
| 背景 | `bgKind` / `bgPreset` / `bgUrl` / `bgFit` / `bgPosition` / `bgBlur` | none / aurora / "" / cover / center / 0 |
| 遮罩 | `maskOpacity` / `maskColor` | 0.24 / auto |
| 玻璃 | `glassPanels` / `glassStrength`(通透度) / `glassBlur`(模糊 0–24px) / `glassBorder` | true / 0.5 / 10 / true |
| 气泡 | `bubbleLiquid` / `bubbleIntensity` / `bubbleReadability` | true / 0.5 / true |
| 性能 | `perfMode` | auto |

**想让壁纸更清楚**:设置 → 外观与背景 → 毛玻璃 → 观感「清晰」(通透度 100% + 模糊 0),必要时再把遮罩降到 0。通透度与模糊是两个独立滑杆;旧版把两者绑在一起,「强度」拉满反而更模糊,这是 2026-10-19 客户端反馈后改掉的。

## 6. 验证

- `node --test plugins/ui-skin/test/*.test.ts` — 28 项:配置归一化、schema 默认值与渲染默认值一致、对比度数学、护栏抬升、选择器审计、与已安装 dsh 包的钩子契约、bundle 形状。
- `npx tsc -p plugins/ui-skin/tsconfig.json`。
- 真浏览器(dsh web profile + Playwright):深浅主题切换、预设/上传/URL、遮罩与通透度/模糊滑杆、设置页布局(1440/1024 无溢出)、上传后刷新保留、恢复默认、像素采样确认壁纸能透过面板;右侧栏文件查看(文本/代码/Markdown)在深浅主题下透明、代码卡只加 20% veil。终端用「已安装 bundle 的真实 DOM 契约 + 真实面板内注入带内联主题背景的 `.xterm-scrollable-element` 探针」验证(隔离的 dsh web 测试实例没有可启动的 terminal host)。Windows 标题栏模拟下还验证:展开 toggle 在 (12,6) 不与品牌重叠;收起后 toggle (12,6)、新建会话 (48,6) 可见可点;知识库抽屉 scrim 全屏 (1405x821)、面板 460x821;侧栏列 filter none 而 `::before` 有模糊,右栏列 none 而停靠面板有模糊。验收截图留在本地 `docs/assets/`(不入库)。

- 真浏览器动画(临时 dsh web,1405x821,皮肤关闭):连续 10 次收起/展开全部出现中间帧(每次 16–18 个中间宽度),过渡 0.3s,`side.right - center.left = 0`;frame 的 `data-cl-xs-track-animating` 在 pointerdown 后为 true。右栏未在临时实例打开(无会话),但同一条 frame track 与同一个预置;右栏面板 transform 本身已有过渡。
- 真浏览器圆角(临时 dsh web,Windows 标题栏模拟,皮肤开启,1405x821):补丁同一帧 `left` 193.835 对侧栏 193.8(差 0.035px),343ms 0.466 对 0.5;补丁 16x16、`top` 40、`background rgba(255,255,255,0.57)`、`filter blur(10px) saturate(1.26)`、`mask radial 16px`。
## 7. 升级 dsh 时

1. 先跑 `node --test plugins/ui-skin/test/contract.test.ts`:它读取**已安装**的 dsh 客户端 bundle,逐个断言 `data-*` 钩子与气泡局部类名还在。
2. 再跑 `node --test plugins/ui-skin/test/ui-skin.test.ts`:样式表里任何离开 `cl-xs-*` / 语义 `data-*` / `html,body,#root` 的选择器都会失败。
3. 若上游改了 token 或钩子,按附录 A 的普查表更新选择器与契约表;不要在样式表里加哈希类名。唯一的第三方 class 例外是 xterm 的公开 DOM 结构(`.xterm-*`):契约测试锁定 `xterm-scrollable-element` 并断言终端包没有 canvas addon,升级换渲染器时会先红。

## 8. 已知限制

- 背景图不跨浏览器/设备同步(设计 v1 明确不做)。
- 外链图片可能被 CSP 或对方 CORS 拦截;失败时设置页给出中文提示,可退回本地上传。
- 终端透明依赖 xterm 的 DOM 渲染器(dsh 0.2.0-rc.2 的组合即如此);若上游改用 canvas 渲染器,终端只剩面板 tint(契约测试会先提示)。
- 会话头为了不劫持知识库抽屉,去掉了这一条 76px 的模糊,只保留玻璃 tint;如果以后 dsh 把知识库抽屉 portal 到 body,可以再把模糊加回头部。
- 文件预览的 **PDF/HTML 内容面**仍由文档自身绘制;玻璃化的是查看器 chrome、代码/文本与 Markdown 面。
- 侧栏/右栏动画的预置依赖 dsh 的 frame grid(`#root [data-slot='root'] > div` 的 `grid-template-columns`);上游换布局容器时标记会失效,但不会报错。
- Windows 收起时宽内容仍按 dsh 的 `wide` 逻辑立即卸载;要让它被会话栏逐渐盖住,需上游改 `SidebarRoot` 的 `wide`/settle(UI 插件不再做 DOM 克隆)。圆角补丁依赖 Windows 的 16px 圆角与 frame 内联 `grid-template-columns` 首轨格式。
- `backdrop-filter` 不可用时自动退化为更高不透明度的实色玻璃(JS 检测 + `@supports`)。
- 宿主日志/设置命名空间依赖 profile bundle 层;只把包塞进启动图、不列进 `dsh.profile.bundles` 时,设置页不会出现(壁纸也不会持久化)。
