# nyarbot

A personal AI-powered Telegram bot for a single group chat, built with [grammy](https://grammy.dev) and the [Vercel AI SDK](https://sdk.vercel.ai).

## Status

Early development. Core architecture is in place — the bot entrypoint, Firebase integration, and CI pipeline are wired up. Message handling, AI conversation, and proactive messaging are still to be implemented.

## Stack

| Layer                  | Library                            |
| ---------------------- | ---------------------------------- |
| Telegram bot framework | `grammy`                           |
| AI / LLM               | `ai` (Vercel AI SDK) with DeepSeek |
| Web search             | `@tavily/ai-sdk`                   |
| Database               | `firebase-admin` (Firestore)       |
| Runtime                | Node.js, TypeScript (ESM)          |

## Setup

```bash
cp .env.example .env   # fill in your API keys and group/user IDs
npm ci
npm run build
node dist/app.js
```

## Disclaimer

This bot is a personal project. If you choose to run or interact with it, please be aware that it may include features and behaviors that are tailored to its owner's use case and are not fully documented. Use at your own discretion.
