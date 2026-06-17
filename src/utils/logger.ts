import pino from "pino";
import {
	configureTransport,
	parseEnvVariables,
	setupExitHandlers,
} from "./logger-helpers";

const env = parseEnvVariables();

const isTestEnv = env.NODE_ENV === "test";

const pinoOptions: pino.LoggerOptions = {
	level: isTestEnv ? "silent" : env.LOG_LEVEL,
	base: { pid: process.pid },
	timestamp: pino.stdTimeFunctions.isoTime,
	formatters: {
		level: (label) => ({ level: label.toUpperCase() }),
	},
};

const transport = !isTestEnv
	? configureTransport(env.NODE_ENV, env.LOG_OUTPUT, env.LOG_FILE_PATH)
	: undefined;

// When no transport is configured, Pino writes to fd 1 (stdout) by default.
// For an MCP stdio server stdout must stay JSON-RPC only, so direct the
// default JSON output to fd 2 (stderr) instead. Transports (pino-pretty /
// pino/file) already target stderr or a file, so they are left untouched.
const baseLogger = transport
	? pino(pinoOptions, pino.transport(transport))
	: pino(pinoOptions, pino.destination(2));

setupExitHandlers(baseLogger);

// Do not emit the initialization log in the test environment.
if (!isTestEnv) {
	baseLogger.info(
		{
			logLevel: env.LOG_LEVEL,
			logOutput: env.LOG_OUTPUT,
			logFilePath: env.LOG_OUTPUT === "file" ? env.LOG_FILE_PATH : undefined,
			nodeEnv: env.NODE_ENV,
		},
		"Logger initialization complete",
	);
}

export default baseLogger;
