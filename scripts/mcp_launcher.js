const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

// --- Configuration ---
// Log file output path (change as needed)
const LOG_FILE_PATH = path.resolve(__dirname, "../.logs/mcp_launcher.log");
// The actual command and arguments to execute
const ACTUAL_COMMAND = "npx";
const ACTUAL_ARGS = ["-y", "@sirosuzume/mcp-tsmorph-refactor"];
// --- End of configuration ---

function ensureLogDirectoryExists(filePath) {
	const dirname = path.dirname(filePath);
	if (fs.existsSync(dirname)) {
		return true;
	}
	fs.mkdirSync(dirname, { recursive: true });
}

function logToFile(message) {
	try {
		ensureLogDirectoryExists(LOG_FILE_PATH);
		const timestamp = new Date().toISOString();
		fs.appendFileSync(LOG_FILE_PATH, `[${timestamp}] ${message}\n`);
	} catch (error) {
		// Failed log writes are printed to the console (may not be visible to the MCP client)
		console.error("Failed to write to launcher log file:", error);
	}
}

logToFile("Launcher script started.");
logToFile(`CWD: ${process.cwd()}`);
logToFile(`Executing: ${ACTUAL_COMMAND} ${ACTUAL_ARGS.join(" ")}`);

const child = spawn(ACTUAL_COMMAND, ACTUAL_ARGS, {
	stdio: ["pipe", "pipe", "pipe"], // pipe stdin, stdout, stderr
	shell: process.platform === "win32", // shell: true tends to be more stable on Windows
});

logToFile(`Spawned child process with PID: ${child.pid}`);

// Forward child stdout to the wrapper's stdout and to the log file
child.stdout.on("data", (data) => {
	process.stdout.write(data); // Output to MCP client
	logToFile(`[CHILD STDOUT] ${data.toString().trim()}`);
});

// Forward child stderr to the wrapper's stderr and to the log file
child.stderr.on("data", (data) => {
	process.stderr.write(data); // Output to MCP client (as error)
	logToFile(`[CHILD STDERR] ${data.toString().trim()}`);
});

// Forward the parent's stdin to the child process
process.stdin.pipe(child.stdin);

child.on("error", (error) => {
	logToFile(`Failed to start child process: ${error.message}`);
	process.exit(1); // Exit on error
});

child.on("close", (code, signal) => {
	logToFile(`Child process closed with code ${code}, signal ${signal}`);
});

child.on("exit", (code, signal) => {
	logToFile(`Child process exited with code ${code}, signal ${signal}`);
	process.exitCode = code ?? 1; // Set the parent process exit code
});

process.on("exit", (code) => {
	logToFile(`Launcher script exiting with code ${code}.`);
});
