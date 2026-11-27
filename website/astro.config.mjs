import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://yinyanfr.github.io",
  base: "/nyarbot",
  integrations: [
    starlight({
      title: "从 nyarbot 学 AI 应用工程",
      description: "从语言模型的第一次调用开始，沿真实的 Telegram 机器人源码学习 AI 应用工程。",
      defaultLocale: "root",
      locales: {
        root: { label: "简体中文", lang: "zh-CN" },
      },
      disable404Route: true,
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/yinyanfr/nyarbot" }],
      sidebar: [
        { label: "入门：模型与应用", items: ["ai-basics", "message-to-reply"] },
        {
          label: "核心概念",
          items: ["agent-harness", "tool-calling", "context", "memory-rag", "mcp"],
        },
        { label: "从能跑到可靠", items: ["routing", "diary", "capstone"] },
        { label: "查阅", items: ["glossary", "source-map"] },
      ],
    }),
  ],
});
