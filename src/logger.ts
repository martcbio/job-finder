import pino from "pino";

const isProduction =
  process.env.RAILWAY_ENVIRONMENT !== undefined || process.env.NODE_ENV === "production";

// Bun cannot reliably spawn pino-pretty worker threads; use plain stdout in dev.
const usePrettyTransport =
  !isProduction &&
  process.env.LOG_PRETTY === "1" &&
  typeof Bun === "undefined";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  ...(usePrettyTransport
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss",
            ignore: "pid,hostname",
          },
        },
      }
    : {}),
});
