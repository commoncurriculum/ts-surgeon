import * as fs from "node:fs";
import * as path from "node:path";
import type pino from "pino";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
import { z } from "zod";

// The CLI reserves stdout for tool results only.
// Any diagnostic output therefore goes to stderr (console.error), never stdout
// (console.log), so it cannot corrupt the protocol stream.

const DEFAULT_NODE_ENV = "development";
const DEFAULT_LOG_LEVEL: pino.Level = "info";
const DEFAULT_LOG_OUTPUT: "console" | "file" = "console";
const DEFAULT_LOG_FILE_PATH = path.resolve(process.cwd(), "app.log");

const envSchema = z.object({
	NODE_ENV: z
		.enum(["development", "production", "test"])
		.default(DEFAULT_NODE_ENV),
	LOG_LEVEL: z
		.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
		.default(DEFAULT_LOG_LEVEL),
	LOG_OUTPUT: z.enum(["console", "file"]).default(DEFAULT_LOG_OUTPUT),
	LOG_FILE_PATH: z.string().default(DEFAULT_LOG_FILE_PATH),
});

type EnvConfig = z.infer<typeof envSchema>;

/**
 * Parses environment variables against the Zod schema and returns a validated config object.
 * On a parse failure it prints an error message to the console and returns a config object
 * populated with default values.
 *
 * @returns {EnvConfig} The validated environment configuration, or defaults on failure.
 */
export function parseEnvVariables(): EnvConfig {
	const parseResult = envSchema.safeParse(process.env);

	if (!parseResult.success) {
		// Only print errors outside of the test environment.
		if (process.env.NODE_ENV !== "test") {
			console.error(
				"❌ Invalid environment variables:",
				parseResult.error.flatten().fieldErrors,
				"\nFalling back to the default logging configuration.",
			);
		}
		return {
			NODE_ENV: DEFAULT_NODE_ENV,
			LOG_LEVEL: DEFAULT_LOG_LEVEL,
			LOG_OUTPUT: DEFAULT_LOG_OUTPUT,
			LOG_FILE_PATH: DEFAULT_LOG_FILE_PATH,
		};
	}

	const parsedEnv = parseResult.data;
	if (parsedEnv.LOG_OUTPUT === "file") {
		parsedEnv.LOG_FILE_PATH = path.resolve(parsedEnv.LOG_FILE_PATH);
	}
	return parsedEnv;
}

/**
 * Builds the Pino transport configuration for file log output.
 * Attempts to create the log directory when it does not exist.
 * Returns undefined when the directory cannot be prepared.
 *
 * @param {string} logFilePath - Absolute path to the log file.
 * @returns {pino.TransportSingleOptions | undefined} The file transport configuration, or undefined on failure.
 */
function setupLogFileTransport(
	logFilePath: string,
): pino.TransportSingleOptions | undefined {
	const logDir = path.dirname(logFilePath);

	try {
		if (!fs.existsSync(logDir)) {
			fs.mkdirSync(logDir, { recursive: true });
			console.error(`Created log directory: ${logDir}`);
		}
	} catch (err) {
		console.error(
			`Error while checking/creating the log directory: ${logDir}`,
			err,
		);
		return undefined;
	}

	if (!fs.existsSync(logDir)) {
		console.error(
			`File logging is disabled: could not confirm that log directory ${logDir} exists.`,
		);
		return undefined;
	}

	console.error(`Writing logs to file: ${logFilePath}`);
	return {
		target: "pino/file",
		options: { destination: logFilePath, mkdir: false },
	};
}

/**
 * Builds the Pino transport configuration for console log output.
 * Outside of production it attempts to use pino-pretty.
 * When pino-pretty is unavailable, or in production, it returns no transport configuration
 * (undefined), in which case Pino's default JSON output is written to standard error
 * (stderr; the default destination is configured in logger.ts) — never standard output.
 *
 * @param {string} nodeEnv - The current NODE_ENV (`development`, `production`, `test`).
 * @returns {pino.TransportSingleOptions | undefined} The console transport configuration (for pino-pretty), or undefined when none is needed.
 */
function setupConsoleTransport(
	nodeEnv: string,
): pino.TransportSingleOptions | undefined {
	if (nodeEnv === "production") {
		return undefined;
	}

	try {
		require.resolve("pino-pretty");
		// These lines describe the logger's own setup, which is only of
		// interest when actively debugging logging — gate them behind
		// LOG_LEVEL=debug so a normal run (e.g. an `npx` consumer, where
		// pino-pretty is a devDependency and thus absent) stays quiet.
		if (nodeEnv === "development" && process.env.LOG_LEVEL === "debug") {
			console.error("Using pino-pretty for console logging.");
		}
		return {
			target: "pino-pretty",
			// destination: 2 -> stderr, keeping stdout free for tool results.
			options: { colorize: true, ignore: "pid,hostname", destination: 2 },
		};
	} catch (e) {
		// pino-pretty is a devDependency, so it is expectedly missing in a
		// published install; the JSON fallback is fine. Only surface this
		// when explicitly debugging the logger (LOG_LEVEL=debug).
		if (nodeEnv === "development" && process.env.LOG_LEVEL === "debug") {
			console.error(
				"pino-pretty was not found. Falling back to the default JSON console logging.",
			);
		}
		return undefined;
	}
}

/**
 * Configures the appropriate Pino transport based on NODE_ENV and the log output target.
 * When this returns undefined, the caller (logger.ts) falls back to Pino's default JSON
 * output on standard error (stderr); standard output is reserved for tool results.
 *
 * @param {string} nodeEnv - The current NODE_ENV.
 * @param {"console" | "file"} logOutput - The log output destination.
 * @param {string} logFilePath - The log file path when writing to a file.
 * @returns {pino.TransportSingleOptions | undefined} The configured transport, or undefined when no transport is needed.
 */
export function configureTransport(
	nodeEnv: string,
	logOutput: "console" | "file",
	logFilePath: string,
): pino.TransportSingleOptions | undefined {
	if (logOutput === "file") {
		return setupLogFileTransport(logFilePath);
	}

	return setupConsoleTransport(nodeEnv);
}

/**
 * Handler that flushes logs and terminates the process on process exit events or exceptions.
 *
 * @param {pino.Logger} logger - The Pino logger instance to use.
 * @param {string} evt - The name of the event that occurred (e.g. 'SIGINT', 'uncaughtException').
 * @param {Error | number | null} [err] - The associated error object or exit code.
 */
function exitHandler(
	logger: pino.Logger,
	evt: string,
	err?: Error | number | null,
) {
	const isTestEnv = process.env.NODE_ENV === "test";
	try {
		logger.flush();
	} catch (flushErr) {
		if (!isTestEnv) {
			console.error("Error flushing logs on exit:", flushErr);
		}
	}

	const errorObj =
		err instanceof Error
			? err
			: err != null
				? new Error(`Exit code or reason: ${err}`)
				: null;

	if (!isTestEnv) {
		console.error(`Process exiting (${evt})...`);
	}

	if (errorObj) {
		if (!isTestEnv) {
			console.error("Exit error:", errorObj);
		}
		process.removeAllListeners("uncaughtException");
		process.removeAllListeners("unhandledRejection");
		process.exit(1);
	} else {
		process.exit(0);
	}
}

/**
 * Registers listeners that capture SIGINT, SIGTERM, uncaughtException, and unhandledRejection
 * events and invoke exitHandler. Also registers a listener for the normal exit event.
 *
 * @param {pino.Logger} logger - The Pino logger instance passed to exitHandler.
 */
export function setupExitHandlers(logger: pino.Logger) {
	process.once("SIGINT", () => exitHandler(logger, "SIGINT"));
	process.once("SIGTERM", () => exitHandler(logger, "SIGTERM"));
	process.once("uncaughtException", (err) =>
		exitHandler(logger, "uncaughtException", err),
	);
	process.once("unhandledRejection", (reason) =>
		exitHandler(
			logger,
			"unhandledRejection",
			reason instanceof Error ? reason : new Error(String(reason)),
		),
	);

	// Run the normal exit handler even in the test environment (some test runners require it).
	process.on("exit", (code) => {
		const isTestEnv = process.env.NODE_ENV === "test";
		if (!isTestEnv && process.env.LOG_LEVEL !== "silent") {
			console.error(
				`Process exit code: ${code}. Logs should have been flushed.`,
			);
		}
		// Some tests assert on the exit code, so only attempt to flush the logs.
		try {
			logger.flush();
		} catch (e) {
			/* ignore flush error on exit */
		}
	});
}
