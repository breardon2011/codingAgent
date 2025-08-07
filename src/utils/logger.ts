enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

class Logger {
  private level: LogLevel = LogLevel.INFO;

  setLevel(level: "debug" | "info" | "warn" | "error") {
    this.level = LogLevel[level.toUpperCase() as keyof typeof LogLevel];
  }

  debug(message: string, data?: any) {
    if (this.level <= LogLevel.DEBUG) {
      console.log(
        `🔍 [DEBUG] ${message}`,
        data ? JSON.stringify(data, null, 2) : ""
      );
    }
  }

  info(message: string, data?: any) {
    if (this.level <= LogLevel.INFO) {
      console.log(`ℹ️  [INFO] ${message}`, data || "");
    }
  }

  warn(message: string, data?: any) {
    if (this.level <= LogLevel.WARN) {
      console.warn(`⚠️  [WARN] ${message}`, data || "");
    }
  }

  error(message: string, error?: any) {
    if (this.level <= LogLevel.ERROR) {
      console.error(`❌ [ERROR] ${message}`, error || "");
    }
  }
}

export const logger = new Logger();

// Set log level from environment variable
if (process.env.LOG_LEVEL) {
  logger.setLevel(process.env.LOG_LEVEL as any);
}
