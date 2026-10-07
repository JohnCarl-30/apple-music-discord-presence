export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function createLogger(name: string): Logger {
  const emit = (level: string, msg: string): void => {
    process.stderr.write(`${new Date().toISOString()} ${level} [${name}] ${msg}\n`);
  };
  return {
    info: (m) => emit("INFO ", m),
    warn: (m) => emit("WARN ", m),
    error: (m) => emit("ERROR", m),
  };
}
