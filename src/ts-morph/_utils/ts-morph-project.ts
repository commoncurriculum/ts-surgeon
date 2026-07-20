import { Project, type SourceFile } from "ts-morph";
import * as path from "node:path";
import { NewLineKind } from "typescript";
import logger from "../../utils/logger.js";

/**
 * When set, initializeProject reuses one Project per tsconfig instead of
 * re-parsing the whole program on every call. Enabled by the CLI's batch
 * mode; every tool sees the results of the previous operations because they
 * share the same (saved) in-memory AST.
 */
let projectCache: Map<string, Project> | null = null;

/** Turns on project reuse across tool calls (batch mode). */
export function enableProjectCache(): void {
	projectCache = new Map();
}

/** Turns off project reuse and drops every cached project. */
export function disableProjectCache(): void {
	projectCache = null;
}

export function initializeProject(tsconfigPath: string): Project {
	const absoluteTsconfigPath = path.resolve(tsconfigPath);
	const cached = projectCache?.get(absoluteTsconfigPath);
	if (cached) {
		// Reuse only when the in-memory AST matches disk (everything saved).
		// A dry run or a failed operation leaves unsaved mutations behind;
		// such a project must be re-parsed, never reused.
		if (cached.getSourceFiles().every((sf) => sf.isSaved())) {
			return cached;
		}
		projectCache?.delete(absoluteTsconfigPath);
	}
	const project = new Project({
		tsConfigFilePath: absoluteTsconfigPath,
		manipulationSettings: {
			newLineKind: NewLineKind.LineFeed,
		},
	});
	projectCache?.set(absoluteTsconfigPath, project);
	return project;
}

export function getChangedFiles(project: Project): SourceFile[] {
	return project.getSourceFiles().filter((sf) => !sf.isSaved());
}

export async function saveProjectChanges(
	project: Project,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	try {
		await project.save();
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw error;
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`An error occurred while saving files: ${message}`);
	}
}

export function getTsConfigPaths(
	project: Project,
): Record<string, string[]> | undefined {
	try {
		const options = project.compilerOptions.get();
		if (!options.paths) {
			return undefined;
		}
		if (typeof options.paths !== "object") {
			logger.warn(
				{ paths: options.paths },
				"Compiler options 'paths' is not an object.",
			);
			return undefined;
		}

		const validPaths: Record<string, string[]> = {};
		for (const [key, value] of Object.entries(options.paths)) {
			if (
				Array.isArray(value) &&
				value.every((item) => typeof item === "string")
			) {
				validPaths[key] = value;
			} else {
				logger.warn(
					{ pathKey: key, pathValue: value },
					"Invalid format for paths entry, skipping.",
				);
			}
		}
		return validPaths;
	} catch (error) {
		logger.error({ err: error }, "Failed to get compiler options or paths");
		return undefined;
	}
}

export function getTsConfigAliasKeys(project: Project): string[] {
	return Object.keys(getTsConfigPaths(project) ?? {});
}

export function getTsConfigBaseUrl(project: Project): string | undefined {
	try {
		const options = project.compilerOptions.get();
		return options.baseUrl;
	} catch (error) {
		logger.error({ err: error }, "Failed to get compiler options baseUrl");
		return undefined;
	}
}
