import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
let HOME = "";
let projectDir = "";

function cli(args: string[], options: { input?: string; expectFailure?: boolean } = {}): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync("node", [path.join(ROOT, "dist", "cli.js"), ...args], {
    env: { ...process.env, SKILLENV_HOME: HOME },
    input: options.input,
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

beforeAll(() => {
  HOME = mkdtempSync(path.join(tmpdir(), "cli-home-"));
  projectDir = mkdtempSync(path.join(tmpdir(), "cli-project-"));
  writeFileSync(path.join(projectDir, "hello.txt"), "hello world\n", "utf8");
  writeFileSync(path.join(projectDir, "SKILL.md"), "---\nname: demo-project\ndescription: demo skill for e2e\n---\n\n# demo\n", "utf8");
});

describe("CLI end-to-end", () => {
  it("prints the version", () => {
    const result = cli(["version"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^skillenv \d+\.\d+\.\d+$/);
  });

  it("creates, inspects, and removes an environment", () => {
    expect(cli(["create", "e2e"]).status).toBe(0);
    expect(cli(["env", "list"]).stdout).toContain("e2e");
    expect(cli(["env", "info", "e2e"]).stdout).toContain("adapter: codex");
    expect(cli(["doctor", "e2e"]).stdout).toBe("OK e2e\n");

    const exported = cli(["export", "e2e"]).stdout;
    expect(exported).toContain("name: e2e");

    expect(cli(["remove", "e2e"]).stdout).toBe("removed e2e\n");
    expect(cli(["env", "list"]).stdout).toContain("no environments");
  });

  it("creates from a preset and installs plugins", () => {
    const result = cli(["create", "preset-env", "-p", "research", "--install-plugins"]);
    expect(result.status).toBe(0);
    const plugins = cli(["plugin", "list", "preset-env"]).stdout;
    expect(plugins).toContain("latex@openai-bundled");
  });

  it("installs a local skill and verifies checksums with doctor", () => {
    cli(["create", "skills-env"]);
    const result = cli(["install", "skills-env", projectDir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("installed");

    // Tamper with the installed copy; doctor must fail with a checksum mismatch.
    const installedSkill = path.join(HOME, "envs", "skills-env", "skills", path.basename(projectDir));
    writeFileSync(path.join(installedSkill, "SKILL.md"), "---\nname: changed\n---\nTAMPERED\n", "utf8");
    const doctor = cli(["doctor", "skills-env"]);
    expect(doctor.status).toBe(1);
    expect(doctor.stdout).toContain("checksum mismatch");
  });

  it("installs from a manifest file with force semantics", () => {
    const manifest = path.join(HOME, "repro.yml");
    writeFileSync(manifest, `name: from-manifest\nadapter: claude\nskills:\n  - ${projectDir}\nplugins: []\n`, "utf8");
    const result = cli(["create", "-f", manifest]);
    expect(result.status).toBe(0);
    expect(existsSync(path.join(HOME, "envs", "from-manifest", "skills", path.basename(projectDir)))).toBe(true);
    expect(cli(["env", "info", "from-manifest"]).stdout).toContain("adapter: claude");
  });

  it("diffs two environments", () => {
    cli(["create", "diff-a"]);
    cli(["create", "diff-b"]);
    cli(["install", "diff-a", projectDir]);
    const diff = cli(["diff", "diff-a", "diff-b"]).stdout;
    expect(diff).toContain(`skills only in diff-a:`);
    expect(diff).toContain(path.basename(projectDir));
  });

  it("run executes with adapter isolation vars", () => {
    cli(["create", "runner"]);
    const result = cli(["run", "runner", "--", "node", "-e", "process.stdout.write(process.env.CODEX_HOME ?? 'missing')"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(path.join(HOME, "envs", "runner"));
  });

  it("agent fails with a clear message when no API key is present", () => {
    cli(["create", "agent-env"]);
    const previous = process.env.DEEPSEEK_API_KEY;
    const result = spawnSync(
      "node",
      [path.join(ROOT, "dist", "cli.js"), "agent", "agent-env", "-q", "hello"],
      {
        env: { ...process.env, SKILLENV_HOME: HOME, DEEPSEEK_API_KEY: "" },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DEEPSEEK_API_KEY");
    if (previous) process.env.DEEPSEEK_API_KEY = previous;
  });

  it("registry list shows versioned bundled skills", () => {
    const listing = cli(["registry", "list"]).stdout;
    expect(listing).toContain("pdf\t1.0.0");
    expect(listing).toContain("skillenv-basics");
  });

  it("doctor --agent reports provider readiness without failing", () => {
    cli(["create", "doctor-agent-env"]);
    const result = cli(["doctor", "doctor-agent-env", "--agent"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("agent providers:");
    expect(result.stdout).toContain("deepseek");
    expect(result.stdout).toContain("ollama\tready");
  });

  it("env rename preserves content and rewrites the manifest", () => {
    cli(["create", "to-rename"]);
    expect(cli(["env", "rename", "to-rename", "renamed-env"]).status).toBe(0);
    expect(cli(["env", "info", "renamed-env"]).stdout).toContain("name: renamed-env");
    expect(cli(["doctor", "renamed-env"]).stdout).toBe("OK renamed-env\n");
    expect(cli(["env", "rename", "ghost", "nope"]).status).not.toBe(0);
  });

  it("session export writes markdown", () => {
    // agent runs create sessions only with a provider; exercise the command's
    // error path plus a fabricated session file end to end.
    cli(["create", "export-sessions"]);
    const sessionsDir = path.join(HOME, "envs", "export-sessions", "sessions");
    writeFileSync(
      path.join(sessionsDir, "agent-test.json"),
      JSON.stringify({
        id: "agent-test",
        created_at: "2026-09-12T00:00:00Z",
        updated_at: "2026-09-12T00:00:00Z",
        provider: "deepseek",
        model: "deepseek-chat",
        env: "export-sessions",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi there" },
        ],
      }),
      "utf8",
    );
    const out = path.join(HOME, "export.md");
    const result = cli(["session", "export", "export-sessions", "agent-test", "-o", out]);
    expect(result.status).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("# agent session agent-test");
    expect(readFileSync(out, "utf8")).toContain("hi there");
    const stdout = cli(["session", "export", "export-sessions", "agent-test"]);
    expect(stdout.stdout).toContain("## assistant");
  });

  (process.platform === "win32" ? it : it.skip)("run resolves npm .cmd shims on windows", () => {
    cli(["create", "cmd-runner"]);
    const result = cli(["run", "cmd-runner", "--", "npm", "--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
  });

  it("unknown commands fail gracefully", () => {
    const result = cli(["definitely-not-a-command"]);
    expect(result.status).not.toBe(0);
  });
});
