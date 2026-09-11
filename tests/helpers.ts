import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Create a fresh isolated SKILLENV_HOME and point the process at it.
 * Call the returned function once per test, inside the test body:
 *
 *   const home = useTempHome()();
 */
export function useTempHome(): () => string {
  return () => {
    const home = mkdtempSync(path.join(tmpdir(), "skillenv-test-"));
    process.env.SKILLENV_HOME = home;
    return home;
  };
}

/** Make a minimal skill directory containing a SKILL.md. */
export function makeSkill(
  root: string,
  name: string,
  options: { description?: string; version?: string; dependencies?: string[]; body?: string } = {},
): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  const front: string[] = ["---", `name: ${name}`];
  if (options.description) front.push(`description: ${options.description}`);
  if (options.version) front.push(`version: ${options.version}`);
  if (options.dependencies && options.dependencies.length > 0) {
    front.push("dependencies:", ...options.dependencies.map((dep) => `  - ${dep}`));
  }
  front.push("---", "", options.body ?? `# ${name}`, "");
  writeFileSync(path.join(dir, "SKILL.md"), front.join("\n"), "utf8");
  return dir;
}
