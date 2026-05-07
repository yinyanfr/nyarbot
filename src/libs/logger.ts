import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

const baseOptions: pino.LoggerOptions = {
  name: "nyarbot",
  level: process.env.LOG_LEVEL ?? "info",
};

export const logger = isDev
  ? pino({
      ...baseOptions,
      transport: { target: "pino-pretty", options: { colorize: true } },
    })
  : pino(baseOptions);
