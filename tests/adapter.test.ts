import { describe, expect, it } from "vitest";
import { ADAPTERS, adapterCommand, buildAdapterEnv, getAdapter } from "../src/adapter.js";
import { getPreset, listPresets, PRESETS } from "../src/preset.js";

describe("adapters", () => {
  it("expose the correct home variables", () => {
    expect(ADAPTERS.codex?.homeVar).toBe("CODEX_HOME");
    expect(ADAPTERS.claude?.homeVar).toBe("CLAUDE_CONFIG_DIR");
    expect(ADAPTERS.pi?.homeVar).toBe("PI_CONFIG_DIR");
    expect(ADAPTERS.gemini?.homeVar).toBeNull();
    expect(ADAPTERS.generic?.homeVar).toBeNull();
  });

  it("builds generic + adapter env vars", () => {
    const vars = buildAdapterEnv("/home/user/.skillenv/envs/research", "codex");
    expect(vars.CODEX_HOME).toBe("/home/user/.skillenv/envs/research");
    expect(vars.SKILLENV_ENV).toBe("research");
    expect(vars.SKILLENV_SKILLS_DIR).toBe("/home/user/.skillenv/envs/research/skills");

    const claudeVars = buildAdapterEnv("/x/y/claude-env", "claude");
    expect(claudeVars.CLAUDE_CONFIG_DIR).toBe("/x/y/claude-env");

    const genericVars = buildAdapterEnv("/x/y/generic", "generic");
    expect(genericVars.CODEX_HOME).toBeUndefined();
    expect(genericVars.SKILLENV_ENV_ROOT).toBe("/x/y/generic");
  });

  it("resolves default commands with override support", () => {
    expect(adapterCommand("codex")).toBe("codex");
    expect(adapterCommand("claude", "claude --dangerously-skip-permissions")).toContain("--dangerously");
    expect(() => adapterCommand("generic")).toThrow("no default command");
  });

  it("rejects unknown adapters", () => {
    expect(() => getAdapter("nope")).toThrow("unknown adapter: nope");
  });

  it("codex requires config.toml for doctor", () => {
    expect(ADAPTERS.codex?.requiredFiles).toContain("config.toml");
    expect(ADAPTERS.claude?.requiredFiles).toEqual([]);
  });
});

describe("presets", () => {
  it("keeps the three built-in presets", () => {
    expect(listPresets()).toEqual(["clean", "coding", "research"]);
    expect(PRESETS.research?.skills).toContain("pdf");
  });

  it("throws for unknown presets", () => {
    expect(() => getPreset("nope")).toThrow("unknown preset: nope");
  });
});
