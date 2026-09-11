import path from "node:path";

/**
 * An adapter teaches skillenv how one agent CLI consumes an isolated home:
 * which environment variable redirects its config directory, what command to
 * launch by default, and which files a healthy environment contains.
 */
export interface AdapterSpec {
  id: string;
  displayName: string;
  /** Environment variable that redirects the agent's config/home directory, or null when unknown. */
  homeVar: string | null;
  /** Command launched by `skillenv run <env>` when no explicit command is given. */
  defaultCommand: string | null;
  /** Files required for `skillenv doctor` to pass. */
  requiredFiles: string[];
  notes: string;
}

export const ADAPTERS: Record<string, AdapterSpec> = {
  codex: {
    id: "codex",
    displayName: "OpenAI Codex CLI",
    homeVar: "CODEX_HOME",
    defaultCommand: "codex",
    requiredFiles: ["config.toml"],
    notes: "Fully supported: CODEX_HOME points at the environment root; plugins live in config.toml.",
  },
  claude: {
    id: "claude",
    displayName: "Claude Code",
    homeVar: "CLAUDE_CONFIG_DIR",
    defaultCommand: "claude",
    requiredFiles: [],
    notes: "Fully supported: CLAUDE_CONFIG_DIR points at the environment root; skills install into skills/ which Claude Code reads as user-level skills.",
  },
  pi: {
    id: "pi",
    displayName: "pi coding agent",
    homeVar: "PI_CONFIG_DIR",
    defaultCommand: "pi",
    requiredFiles: [],
    notes: "Best effort: PI_CONFIG_DIR is set to the environment root. pi reads skills from skills/.",
  },
  gemini: {
    id: "gemini",
    displayName: "Gemini CLI (experimental)",
    homeVar: null,
    defaultCommand: "gemini",
    requiredFiles: [],
    notes: "Experimental: gemini-cli has no config-dir override yet, so only generic SKILLENV_* variables are exported.",
  },
  generic: {
    id: "generic",
    displayName: "Generic agent command",
    homeVar: null,
    defaultCommand: null,
    requiredFiles: [],
    notes: "Sets SKILLENV_ENV, SKILLENV_ENV_ROOT and SKILLENV_SKILLS_DIR; the agent command decides what to do with them.",
  },
};

export function getAdapter(id: string): AdapterSpec {
  const adapter = ADAPTERS[id];
  if (!adapter) {
    throw new Error(
      `unknown adapter: ${id} (available: ${Object.keys(ADAPTERS).join(", ")})`,
    );
  }
  return adapter;
}

/**
 * Environment variables exported when running an agent inside an environment.
 * Always includes the generic SKILLENV_* variables; adds the adapter home
 * variable when one is defined.
 */
export function buildAdapterEnv(envRoot: string, adapterId: string): Record<string, string> {
  const adapter = getAdapter(adapterId);
  const vars: Record<string, string> = {
    SKILLENV_ENV: path.basename(envRoot),
    SKILLENV_ENV_ROOT: envRoot,
    SKILLENV_SKILLS_DIR: path.join(envRoot, "skills"),
  };
  if (adapter.homeVar) {
    vars[adapter.homeVar] = envRoot;
  }
  return vars;
}

/** Command to launch for an environment, honoring an explicit override. */
export function adapterCommand(adapterId: string, override?: string): string {
  const adapter = getAdapter(adapterId);
  if (override && override.length > 0) {
    return override;
  }
  if (adapter.defaultCommand) {
    return adapter.defaultCommand;
  }
  throw new Error(
    `adapter '${adapterId}' has no default command; pass one explicitly, e.g. skillenv run <env> -- my-agent`,
  );
}
