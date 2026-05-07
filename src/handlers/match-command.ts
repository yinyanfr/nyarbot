export function matchCommand(
  entities: { type: string; offset: number; length: number }[],
  text: string,
  command: string,
  botUsername: string,
): boolean {
  return entities.some(
    (e) =>
      e.type === "bot_command" &&
      (text.slice(e.offset, e.offset + e.length) === command ||
        text.slice(e.offset, e.offset + e.length) === `${command}@${botUsername}`),
  );
}
