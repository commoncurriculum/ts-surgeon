import { z, type ZodRawShape } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { registerTsMorphTools } from "./ts-morph-tools";

/** Result shape every tool handler returns (via runTool). */
export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	/** Machine-readable result payload, emitted by the CLI's --json mode. */
	data?: unknown;
}

/** Thrown by call() when params fail schema validation. Exit code 2 in the CLI. */
export class ToolParamsError extends Error {}

/** Thrown by call()/inputSchema() for a tool name that isn't registered. */
export class UnknownToolError extends Error {
	constructor(
		toolName: string,
		public readonly registeredNames: string[],
	) {
		super(
			`Unknown tool '${toolName}'. Available tools:\n  ${registeredNames.join("\n  ")}`,
		);
	}
}

export interface RegisteredTool {
	name: string;
	description: string;
	schemaShape: ZodRawShape;
	handler: (args: never) => Promise<ToolResult> | ToolResult;
}

/**
 * Plain in-process registry for the ts-morph refactoring tools. Each
 * register-*.ts declares its tool here (name, description, Zod schema,
 * handler), and the CLI drives them via list()/inputSchema()/call().
 */
export class ToolRegistry {
	private readonly tools = new Map<string, RegisteredTool>();

	tool<Shape extends ZodRawShape>(
		name: string,
		description: string,
		schemaShape: Shape,
		handler: (
			args: z.infer<z.ZodObject<Shape>>,
		) => Promise<ToolResult> | ToolResult,
	): void {
		if (this.tools.has(name)) {
			throw new Error(`Tool '${name}' is already registered`);
		}
		this.tools.set(name, {
			name,
			description,
			schemaShape,
			handler: handler as RegisteredTool["handler"],
		});
	}

	list(): RegisteredTool[] {
		return [...this.tools.values()];
	}

	/** JSON Schema (draft-07) for a tool's parameters, for `describe`. */
	inputSchema(name: string): object {
		return zodToJsonSchema(z.object(this.get(name).schemaShape).strict());
	}

	/** Validates params against the tool's schema, then runs its handler. */
	async call(name: string, params: unknown): Promise<ToolResult> {
		const tool = this.get(name);
		const parsed = z.object(tool.schemaShape).strict().safeParse(params);
		if (!parsed.success) {
			const issues = parsed.error.issues
				.map(
					(issue) =>
						`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
				)
				.join("\n");
			throw new ToolParamsError(`Invalid parameters for '${name}':\n${issues}`);
		}
		return (
			tool.handler as (args: unknown) => Promise<ToolResult> | ToolResult
		)(parsed.data);
	}

	/**
	 * Resolves a user-supplied tool name to its canonical registration.
	 * Accepts dashes for underscores (`rename-symbol`) and the legacy
	 * `*_by_tsmorph` names as aliases.
	 */
	resolveName(name: string): string {
		const normalized = name.replaceAll("-", "_");
		if (this.tools.has(normalized)) {
			return normalized;
		}
		const legacySuffix = "_by_tsmorph";
		if (normalized.endsWith(legacySuffix)) {
			const stripped = normalized.slice(0, -legacySuffix.length);
			if (this.tools.has(stripped)) {
				return stripped;
			}
		}
		throw new UnknownToolError(name, [...this.tools.keys()]);
	}

	/** Looks up a tool by any accepted spelling; throws UnknownToolError. */
	get(name: string): RegisteredTool {
		const tool = this.tools.get(this.resolveName(name));
		if (!tool) {
			throw new UnknownToolError(name, [...this.tools.keys()]);
		}
		return tool;
	}
}

/** Creates the registry with every ts-morph tool registered. */
export function createToolRegistry(): ToolRegistry {
	const registry = new ToolRegistry();
	registerTsMorphTools(registry);
	return registry;
}
