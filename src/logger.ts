import pino from "pino";

/** Builds the application logger from explicit environment configuration. */
export function createLogger(env: NodeJS.ProcessEnv) {
  const isProduction = env.RAILWAY_ENVIRONMENT !== undefined || env.NODE_ENV === "production";
  // Bun cannot reliably spawn pino-pretty worker threads; use plain stdout in dev.
  const usePrettyTransport = !isProduction && env.LOG_PRETTY === "1" && typeof Bun === "undefined";

  return pino({
    level: env.LOG_LEVEL ?? "info",
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
}

export const logger = createLogger(process.env);
