import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://yinyanfr.github.io",
  base: "/nyarbot",
  integrations: [
    starlight({
      title: "从 nyarbot 学 AI 应用工程",
      description: "沿着真实的 Telegram 机器人源码，学懂 Agent、Harness、MCP 和 RAG。",
      defaultLocale: "root",
      locales: {
        root: { label: "简体中文", lang: "zh-CN" },
      },
      disable404Route: true,
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/yinyanfr/nyarbot" }],
      sidebar: [
        { label: "入口", items: ["message-to-reply"] },
        {
          label: "核心概念",
          items: ["agent-harness", "tool-calling", "context", "memory-rag", "mcp"],
        },
        { label: "生产案例", items: ["routing", "diary"] },
        { label: "查阅", items: ["glossary", "source-map"] },
      ],
    }),
  ],
});
