import config from "../configs/env.js";

export function getPersonaLabel(): string {
  return `${config.botPersonaName}（${config.botPersonaFullName}，读作 ${config.botPersonaReading}）`;
}

export function getPersonaIdentityLine(): string {
  return `你的 Telegram 用户名是 @${config.botUsername}，但你的名字是 ${config.botPersonaName}。`;
}
