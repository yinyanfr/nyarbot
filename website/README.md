# 教学文档站

课程使用 Astro + Starlight，文章位于 `src/content/docs/`，侧栏在 `astro.config.mjs` 配置。用 Node.js 24.19.0 或更新版本，在 `website/` 运行：

```sh
npm ci
npm run dev
```

检验正式构建与站内搜索时，运行 `npm run build` 后用 `npm run preview` 打开 `/nyarbot/`。

引用机器人源码时，把代码片段、GitHub 链接的 commit 和行号一起更新。教学例子只使用合成数据或仓库测试。

`.github/workflows/pages.yml` 在 PR 中构建文档，合入 `main` 后发布到 GitHub Pages。Pages 的发布源是 GitHub Actions。
