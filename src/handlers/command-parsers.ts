export interface CommandEntity {
  type: string;
  offset: number;
  length: number;
}

function findCommandEntity(
  entities: CommandEntity[],
  text: string,
  command: string,
  botUsername: string,
): CommandEntity | null {
  for (const entity of entities) {
    if (entity.type !== "bot_command") continue;
    const raw = text.slice(entity.offset, entity.offset + entity.length);
    if (raw === command || raw === `${command}@${botUsername}`) return entity;
  }
  return null;
}

function parseIntensityCommand(
  entities: CommandEntity[],
  text: string,
  botUsername: string,
  command: "/shock" | "/stroke",
): { intensity?: number; extraText?: string } | null {
  const entity = findCommandEntity(entities, text, command, botUsername);
  if (!entity) return null;
  const remainder = text.slice(entity.offset + entity.length).trim();
  if (!remainder) return {};
  const match = remainder.match(/^([+-]?\d+)(?:\s+(.*))?$/s);
  if (!match) return { extraText: remainder };
  const extraText = match[2]?.trim();
  return {
    intensity: Number.parseInt(match[1] ?? "", 10),
    ...(extraText ? { extraText } : {}),
  };
}

export const parseShockCommand = (entities: CommandEntity[], text: string, botUsername: string) =>
  parseIntensityCommand(entities, text, botUsername, "/shock");
export const parseStrokeCommand = (entities: CommandEntity[], text: string, botUsername: string) =>
  parseIntensityCommand(entities, text, botUsername, "/stroke");

export type RollCommandParseResult =
  | { kind: "ok"; count: number; sides: number; notation: string }
  | { kind: "error"; message: string };

export function parseRollCommand(
  entities: CommandEntity[],
  text: string,
  botUsername: string,
): RollCommandParseResult | null {
  const entity = findCommandEntity(entities, text, "/roll", botUsername);
  if (!entity) return null;
  const remainder = text.slice(entity.offset + entity.length).trim();
  if (!remainder) return { kind: "ok", count: 1, sides: 20, notation: "1d20" };
  const match = remainder.match(/^(\d+)d(\d+)$/iu);
  if (!match) return { kind: "error", message: "用法是 /roll 或 /roll 2d6 这种格式喵~" };
  const count = Number.parseInt(match[1] ?? "", 10);
  const sides = Number.parseInt(match[2] ?? "", 10);
  if (count <= 0 || count > 20)
    return { kind: "error", message: "骰子数量只能是 1 到 20 的正整数喵~" };
  if (sides < 2 || sides > 99999)
    return { kind: "error", message: "骰子面数只能是 2 到 99999 的正整数喵~" };
  return { kind: "ok", count, sides, notation: `${count}d${sides}` };
}

export function rollDice(
  params: { count: number; sides: number },
  random: () => number = Math.random,
): { results: number[]; total: number } {
  const results = Array.from(
    { length: params.count },
    () => Math.floor(random() * params.sides) + 1,
  );
  return { results, total: results.reduce((sum, value) => sum + value, 0) };
}

export function formatRollResult(params: {
  notation: string;
  results: number[];
  total: number;
}): string {
  return params.results.length === 1
    ? `掷出了 ${params.notation}：${params.results[0]}`
    : `掷出了 ${params.notation}：${params.results.join(" + ")} = ${params.total}`;
}
