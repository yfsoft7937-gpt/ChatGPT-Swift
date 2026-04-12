# ChatGPT Swift v0.4.1

ChatGPT Swift keeps long ChatGPT conversations fast, readable, and pleasant to use. It trims distant history, restores nearby context automatically, and handles heavy code blocks more carefully so marathon chats stay smooth instead of turning sluggish.

## What it does
- Automatically restores virtualized messages as they approach the viewport
- Uses separate restore and virtualize thresholds to reduce flicker
- Batches restores across animation frames to keep scrolling responsive
- Reuses placeholders instead of constantly recreating them
- Processes large code blocks incrementally instead of rescanning every `pre`
- Uses `ResizeObserver` to keep placeholder heights in sync with live content
- Applies lighter route-change detection and tighter mutation filtering
- Shares one set of defaults across the content script, popup, options page, and service worker

## Recommended defaults
- Min messages before virtualizing: 12
- Overscan: 3
- Keep newest live: 4
- Pause after typing: 800ms
- Auto restore above viewport: 320px
- Auto restore below viewport: 760px
- Virtualize above viewport: 1400px
- Virtualize below viewport: 1800px
- Auto restores per frame: 2

## Behavior summary
- Nearby messages stay live or come back automatically before you reach them
- Mid-distance messages are left alone to avoid unnecessary DOM churn
- Far-away history becomes placeholders to keep the live DOM small
- Safe mode keeps all messages in the DOM and relies on browser containment instead of replacement

## Install
1. Open `chrome://extensions` or `edge://extensions`
2. Enable Developer mode
3. Click **Load unpacked**
4. Choose this folder
5. Reload ChatGPT

## Version notes
### v0.4.1
- Fixed auto restore by observing virtualized placeholders with `IntersectionObserver`
- Kept restore batching and hysteresis so nearby history becomes visible without heavy scroll jank

---

# ChatGPT Swift v0.4.1 中文说明

ChatGPT 网页往往越聊越卡，甚至打字都非常卡顿，本项目致力于解决此问题：ChatGPT Swift 适合那些越聊越长、上下文越来越多的 ChatGPT 对话。它会把远处的历史消息轻量化处理，在你快要看到时再自动恢复回来，同时更稳地处理大型代码块，让整页体验保持顺滑、清爽，也更容易继续聊下去。

## 它能做什么
- 当虚拟化消息接近视口时，自动把内容恢复出来
- 把“恢复阈值”和“虚拟化阈值”分开，减少占位块闪烁
- 按动画帧分批恢复，尽量减少滚动卡顿
- 复用占位块，而不是反复销毁和重建
- 对大型代码块做增量处理，不再每次都重新扫描所有 `pre`
- 用 `ResizeObserver` 让占位高度和真实内容变化保持一致
- 用更轻量的路由检测和更严格的 DOM 过滤，减少不必要的更新
- 在 content script、popup、options 页面和 service worker 之间共享同一套默认配置

## 推荐默认参数
- 开始虚拟化的最小消息数：12
- Overscan：3
- 始终保留最新消息数：4
- 输入后暂停虚拟化时间：800ms
- 视口上方自动恢复距离：320px
- 视口下方自动恢复距离：760px
- 视口上方虚拟化阈值：1400px
- 视口下方虚拟化阈值：1800px
- 每帧自动恢复数量：2

## 行为说明
- 靠近当前视口的消息会保持真实渲染，或在你滚到附近前自动恢复
- 中距离消息会暂时保留原样，避免不必要的 DOM 抖动
- 远离视口的历史消息会替换成占位块，减小实时 DOM 体积
- 安全模式不会替换 DOM，而是保留所有消息节点，只使用浏览器侧 containment 优化

## 安装方式
1. 打开 `chrome://extensions` 或 `edge://extensions`
2. 开启开发者模式
3. 点击 **Load unpacked**
4. 选择当前项目文件夹
5. 重新加载 ChatGPT 页面

## 版本说明
### v0.4.1
- 通过 `IntersectionObserver` 观察已虚拟化的占位块，修复了自动恢复逻辑
- 保留恢复批处理与迟滞策略，让附近历史消息自动可见，同时尽量避免明显滚动卡顿
