import type { FileSystemHost, Project } from "ts-morph";
import logger from "../../utils/logger.js";

export interface PackageExportWarning {
	/** Absolute path to the package.json of the warned package */
	packageJsonPath: string;
	/** `name` field from package.json (undefined for unnamed packages) */
	packageName: string | undefined;
	/**
	 * Relative paths from package.json entry points (`exports` / `main` / `module` / `types`)
	 * that could not be resolved to a scanned source file (e.g. `./dist/index.js`).
	 */
	externalEntryTargets: string[];
	/** Number of unused export candidates reported from this package */
	candidateCount: number;
}

/**
 * Structurally detects systematic false positives that originate from packages publishing built dist.
 *
 * In a monorepo, when a package's package.json entry points (`exports` / `main` /
 * `module` / `types`) point outside the scanned sources (e.g. `./dist/index.js`),
 * imports from other packages resolve to the build artifact (or node_modules) side,
 * making references to src-side symbols invisible. As a result, every export of that
 * package appears as an unused candidate even when it is actually consumed.
 *
 * This function returns one warning per package that satisfies all of the following:
 * 1. The scanned files span two or more packages (package.json owners)
 *    (a single package has no cross-package references, so this form of false positive cannot occur)
 * 2. The package has at least one unused export candidate
 * 3. At least one of the package.json entry points cannot be resolved to an analyzed source file
 *    (after trying extension substitutions like `./dist/index.js` → `./dist/index.ts`,
 *    the path does not reach any non-declaration file in the project)
 *
 * Each source file's owning package.json is found by walking upward to the nearest one.
 * Read failures and malformed JSON are silently ignored (detection is best-effort).
 */
export function collectPackageExportWarnings(
	project: Project,
	scannedFilePaths: string[],
	candidateFilePaths: string[],
): PackageExportWarning[] {
	const fs = project.getFileSystem();
	const dirToPackageJson = new Map<string, string | undefined>();

	const packageOf = (filePath: string): string | undefined =>
		findOwningPackageJson(dirnameOf(filePath), fs, dirToPackageJson);

	// Condition 1: do the scanned files span multiple packages?
	const scannedPackages = new Set<string>();
	for (const filePath of scannedFilePaths) {
		const pkg = packageOf(filePath);
		if (pkg) scannedPackages.add(pkg);
	}
	if (scannedPackages.size < 2) return [];

	// Condition 2: candidate count per package
	const candidateCountByPackage = new Map<string, number>();
	for (const filePath of candidateFilePaths) {
		const pkg = packageOf(filePath);
		if (!pkg) continue;
		candidateCountByPackage.set(
			pkg,
			(candidateCountByPackage.get(pkg) ?? 0) + 1,
		);
	}

	// Set of visible sources used for condition 3.
	// Declaration files (.d.ts) are excluded because even if they are a resolution target,
	// they are not the same as src symbols.
	const visibleSourcePaths = new Set<string>();
	for (const sf of project.getSourceFiles()) {
		if (sf.isInNodeModules()) continue;
		if (sf.isDeclarationFile()) continue;
		visibleSourcePaths.add(sf.getFilePath() as string);
	}

	const warnings: PackageExportWarning[] = [];
	for (const [packageJsonPath, candidateCount] of candidateCountByPackage) {
		const manifest = readManifest(packageJsonPath, fs);
		if (!manifest) continue;

		const packageDir = dirnameOf(packageJsonPath);
		const externalEntryTargets = collectEntryTargets(manifest).filter(
			(target) =>
				!resolvesToVisibleSource(target, packageDir, visibleSourcePaths),
		);
		if (externalEntryTargets.length === 0) continue;

		warnings.push({
			packageJsonPath,
			packageName:
				typeof manifest.name === "string" ? manifest.name : undefined,
			externalEntryTargets: [...new Set(externalEntryTargets)].sort(),
			candidateCount,
		});
	}

	return warnings.sort((a, b) =>
		a.packageJsonPath.localeCompare(b.packageJsonPath),
	);
}

function dirnameOf(filePath: string): string {
	const idx = filePath.lastIndexOf("/");
	return idx <= 0 ? "/" : filePath.slice(0, idx);
}

/**
 * Walks upward from `dir` to find the nearest package.json (results are cached per directory).
 */
function findOwningPackageJson(
	dir: string,
	fs: FileSystemHost,
	cache: Map<string, string | undefined>,
): string | undefined {
	const visited: string[] = [];
	let current = dir;
	let found: string | undefined;

	while (true) {
		if (cache.has(current)) {
			found = cache.get(current);
			break;
		}
		visited.push(current);
		const candidate =
			current === "/" ? "/package.json" : `${current}/package.json`;
		let exists = false;
		try {
			exists = fs.fileExistsSync(candidate);
		} catch {
			// Unreadable directories are silently skipped (best-effort)
		}
		if (exists) {
			found = candidate;
			break;
		}
		const parent = dirnameOf(current);
		if (parent === current) break;
		current = parent;
	}

	for (const v of visited) cache.set(v, found);
	return found;
}

interface PackageManifest {
	name?: unknown;
	exports?: unknown;
	main?: unknown;
	module?: unknown;
	types?: unknown;
}

function readManifest(
	packageJsonPath: string,
	fs: FileSystemHost,
): PackageManifest | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(packageJsonPath));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		return parsed as PackageManifest;
	} catch (error) {
		logger.debug(
			{ err: error, packageJsonPath },
			"Failed to read package.json; skipping package warning check for this file",
		);
		return undefined;
	}
}

/** Only treat paths that look like JS/TS code as entry points (e.g. exclude `./package.json`). */
const CODE_TARGET_RE = /\.[mc]?[jt]sx?$/;

/**
 * Enumerates relative paths from package.json that could be the module resolution target
 * for external consumers. `exports` can nest conditions / subpaths, so string leaves are
 * collected recursively.
 */
function collectEntryTargets(manifest: PackageManifest): string[] {
	const targets: string[] = [];

	const visit = (value: unknown): void => {
		if (typeof value === "string") {
			if (CODE_TARGET_RE.test(value) || value.includes("*")) {
				targets.push(value);
			}
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (typeof value === "object" && value !== null) {
			for (const item of Object.values(value)) visit(item);
		}
	};

	visit(manifest.exports);
	for (const field of [manifest.main, manifest.module, manifest.types]) {
		if (typeof field === "string" && CODE_TARGET_RE.test(field)) {
			targets.push(field);
		}
	}
	return targets;
}

/**
 * Determines whether an entry point relative path resolves to a visible analyzed source file.
 *
 * - Paths pointing to build output (`./dist/index.js` etc.) are checked after trying
 *   extension substitutions (`.js` → `.ts`/`.tsx`, `.d.ts` → `.ts`, etc.).
 * - Subpath patterns containing `*` cannot be resolved individually; if any visible source
 *   starts with the prefix before `*`, the path is considered resolvable.
 */
function resolvesToVisibleSource(
	target: string,
	packageDir: string,
	visibleSourcePaths: Set<string>,
): boolean {
	const normalized = target.replace(/^\.\//, "");

	const starIndex = normalized.indexOf("*");
	if (starIndex >= 0) {
		const prefix = `${packageDir}/${normalized.slice(0, starIndex)}`;
		for (const sourcePath of visibleSourcePaths) {
			if (sourcePath.startsWith(prefix)) return true;
		}
		return false;
	}

	const absolute = `${packageDir}/${normalized}`;
	for (const candidate of sourceCandidatesFor(absolute)) {
		if (visibleSourcePaths.has(candidate)) return true;
	}
	return false;
}

/** Enumerates possible source file paths that could correspond to a given build output path. */
function sourceCandidatesFor(absolutePath: string): string[] {
	const candidates = [absolutePath];
	if (absolutePath.endsWith(".d.ts")) {
		const base = absolutePath.slice(0, -".d.ts".length);
		candidates.push(`${base}.ts`, `${base}.tsx`);
	} else if (absolutePath.endsWith(".d.mts")) {
		candidates.push(`${absolutePath.slice(0, -".d.mts".length)}.mts`);
	} else if (absolutePath.endsWith(".d.cts")) {
		candidates.push(`${absolutePath.slice(0, -".d.cts".length)}.cts`);
	} else if (absolutePath.endsWith(".js")) {
		const base = absolutePath.slice(0, -".js".length);
		candidates.push(`${base}.ts`, `${base}.tsx`);
	} else if (absolutePath.endsWith(".mjs")) {
		candidates.push(`${absolutePath.slice(0, -".mjs".length)}.mts`);
	} else if (absolutePath.endsWith(".cjs")) {
		candidates.push(`${absolutePath.slice(0, -".cjs".length)}.cts`);
	} else if (absolutePath.endsWith(".jsx")) {
		candidates.push(`${absolutePath.slice(0, -".jsx".length)}.tsx`);
	}
	return candidates;
}
