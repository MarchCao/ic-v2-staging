# 图片 / 视频格式转换 🔄

纯静态单页网站，发布到 GitHub Pages（自定义域名 `shift.haice.top`）。

**纯净版：无广告、不收费、无需注册，所有转换在浏览器本地完成，文件不上传任何服务器。**

## 文件

- `index.html` — 页面结构（中文界面，手机端适配）
- `styles.css` — 样式
- `app.js` — 逻辑（原生 JS，ES5 风格 `var`/`function`，无构建步骤）
- `ffmpeg-worker.js` — 视频转换 Worker（FFmpeg.wasm，懒加载）
- `vendor/ffmpeg/` — 自托管 FFmpeg 静态资源（UMD wrapper + ESM core/wasm，同源零 CDN 依赖）
- `video/index.html` — `/video` 独立入口（写 sessionStorage 标记后跳回主页并自动进入视频模式）
- `CNAME` — GitHub Pages 自定义域名

## 功能

### 🖼️ 图片模式（默认）

1. 上传：点击选择 / 拖拽 / 粘贴，支持多选；列表显示缩略图、文件名、原格式、原大小
2. 输出格式：PNG、JPEG、WebP、BMP；AVIF 仅在浏览器支持 `canvas.toBlob('image/avif')` 时显示
3. 质量滑杆 1~100（默认 85），仅 JPEG / WebP / AVIF 时显示
4. 尺寸：保持原尺寸 / 按宽度 / 按高度 / 自定义宽高（含保持纵横比开关）
5. 转换后显示 原大小 → 新大小、压缩率；支持原图/结果对比预览
6. 单张下载、全部转换、全部打包下载 ZIP（JSZip CDN，失败时回退逐个下载并提示）
7. 清空列表、移除单张；HEIC/HEIF 输入给出中文提示并跳过
8. 图片模式下选择视频文件会被拦截并提示

### 🎬 视频模式

1. 通过顶部 Tab 或访问 `/video` 进入；FFmpeg.wasm 仅在视频模式懒加载，图片模式零开销
2. 上传：点击选择 / 拖拽，支持多选；视频模式只接收视频文件
3. 输出格式：MP4、WebM、MOV、MKV（默认 MP4）；全局格式按钮同步所有待转换项，单项下拉可单独覆盖
4. 质量：小文件 / 平衡 / 高质量（默认平衡，不暴露编码器参数）
5. 尺寸：原尺寸 / 1080p / 720p / 480p / 自定义（保持纵横比）
6. 帧率：保持原帧率 / 24 / 30 / 60 FPS；音频：保留 / 静音
7. 真实首帧缩略图（失败回退 🎬 不中断转换）；显示文件名、大小、分辨率、时长
8. 转换在 Web Worker 中串行执行，进度条为 FFmpeg 真实进度；单项失败自动跳过继续下一项
9. 输出变大时不显示"节省百分比"；单项下载、打包 ZIP（浏览器本地生成）
10. 清空释放 Blob URL、终止 Worker、清理 FFmpeg 文件系统

### 技术说明

- 单线程 FFmpeg core（无需 COOP/COEP，可直接跑在 GitHub Pages）
- WebM（VP9）使用全关键帧编码：该 core 的 libvpx 帧间预测路径存在 wasm 崩溃，已实测 `-g 1` 可稳定编码
- 转换失败导致 FFmpeg 异常时，Worker 内自动重建引擎，不影响后续任务
- 不支持 WebAssembly 的浏览器会提示"当前浏览器暂不支持视频转换。请升级浏览器后重试。"

## 发布

仓库根目录推送到 main 分支，GitHub Pages 选择 main 分支即可；
DNS 做好 `shift.haice.top` 的 CNAME 解析后，在 Pages 设置里填入自定义域名并强制 HTTPS。
