import { maxSatisfying, validRange } from "semver";

/** A dependency spec: plain `name` or `name@range`. Sources (github:/local:/paths) never reach here. */
export interface SkillSpec {
  name: string;
  /** Empty string means "any version". */
  range: string;
}

export function parseSkillSpec(value: string): SkillSpec {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("skill spec cannot be empty");
  }
  const at = trimmed.indexOf("@", 1);
  if (at === -1) {
    return { name: trimmed, range: "" };
  }
  return { name: trimmed.slice(0, at), range: trimmed.slice(at + 1) };
}

export function specToString(spec: SkillSpec): string {
  return spec.range ? `${spec.name}@${spec.range}` : spec.name;
}

/** One skill as exposed to the resolver by a registry (or test fixture). */
export interface CatalogEntry {
  name: string;
  /** semver → version metadata. */
  versions: Record<string, { source: string; dependencies?: string[] }>;
  /** Present when the entry has a bare `source` without versions. */
  unversioned?: { source: string; dependencies?: string[] };
}

export interface Resolution {
  name: string;
  /** Picked version; undefined for unversioned entries. */
  version?: string;
  source: string;
  /** Dependency specs declared by this skill, verbatim. */
  dependencies: string[];
  /** Every requirer of this skill; the synthetic root is called `manifest`. */
  requiredBy: string[];
}

export interface ResolutionResult {
  /** Topologically ordered: dependencies before dependents. */
  resolved: Resolution[];
  /** Skills requested but unversioned, so range constraints could not be verified. */
  warnings: string[];
}

/**
 * Resolve a list of root specs into a closed, conflict-free dependency set.
 *
 * Runs as a fixpoint: every new range constraint narrows the candidate set and
 * forces a re-pick; if the picked version changes, the skill's dependencies are
 * re-enqueued. Disjoint constraints raise a conflict error naming every
 * requirer and its range. Cycles are tolerated via the worklist itself (a
 * re-enqueue is a no-op once constraints stop changing).
 */
export function resolveDependencies(
  rootSpecs: string[],
  catalog: (name: string) => CatalogEntry | null,
): ResolutionResult {
  const constraints = new Map<string, { range: string; by: string }[]>();
  const picks = new Map<string, { version?: string; metadata: { source: string; dependencies?: string[] } }>();
  const warnings: string[] = [];
  const queue: { spec: SkillSpec; by: string }[] = [];

  const enqueue = (spec: SkillSpec, by: string): void => {
    const existing = constraints.get(spec.name) ?? [];
    const duplicate = existing.some((c) => c.range === spec.range && c.by === by);
    if (!duplicate) {
      existing.push({ range: spec.range, by });
      constraints.set(spec.name, existing);
      // A new constraint can invalidate a previous pick; force re-pick and
      // re-expansion of its dependencies.
      picks.delete(spec.name);
    }
    queue.push({ spec, by });
  };

  for (const rootSpec of rootSpecs) {
    enqueue(parseSkillSpec(rootSpec), "manifest");
  }

  let guard = 0;
  const guardLimit = 10_000;
  while (queue.length > 0) {
    guard += 1;
    if (guard > guardLimit) {
      throw new Error("dependency resolution did not converge; check for contradictory constraints");
    }
    const { spec, by } = queue.shift() as { spec: SkillSpec; by: string };
    if (picks.has(spec.name)) {
      continue;
    }

    const entry = catalog(spec.name);
    if (!entry) {
      throw new Error(`skill not found in registry: ${spec.name} (required by ${by})`);
    }
    const ranges = constraints.get(spec.name) ?? [];
    const version = pickVersion(spec.name, entry, ranges, warnings);

    const metadata = version
      ? entry.versions[version]
      : entry.unversioned ?? latestFallback(entry);
    if (!metadata) {
      throw new Error(`registry entry for ${spec.name} has no installable source`);
    }

    picks.set(spec.name, { version, metadata });
    for (const depSpec of metadata.dependencies ?? []) {
      enqueue(parseSkillSpec(depSpec), spec.name);
    }
  }

  const resolved = topoSort(picks, constraints);
  return { resolved, warnings };
}

function pickVersion(
  name: string,
  entry: CatalogEntry,
  ranges: { range: string; by: string }[],
  warnings: string[],
): string | undefined {
  const versions = Object.keys(entry.versions).sort(compareVersions);
  if (versions.length === 0) {
    if (ranges.some((constraint) => constraint.range !== "")) {
      warnings.push(
        `${name} has no versions in the registry; constraints (${ranges
          .filter((constraint) => constraint.range !== "")
          .map((constraint) => `${constraint.by}@${constraint.range}`)
          .join(", ")}) could not be verified`,
      );
    }
    return undefined;
  }
  const active = ranges.filter((constraint) => constraint.range !== "");
  for (let index = versions.length - 1; index >= 0; index--) {
    const candidate = versions[index] as string;
    if (active.every((c) => maxSatisfying([candidate], c.range, { includePrerelease: true }) === candidate)) {
      return candidate;
    }
  }
  const detail = active.map((c) => `${c.by} requires ${c.range}`).join("; ");
  throw new Error(
    `dependency conflict for '${name}': ${detail || "no constraint"}; available versions: ${versions.join(", ")}`,
  );
}

function latestFallback(entry: CatalogEntry): { source: string; dependencies?: string[] } | undefined {
  const versions = Object.keys(entry.versions).sort(compareVersions);
  const latest = versions[versions.length - 1];
  return latest ? entry.versions[latest] : undefined;
}

function compareVersions(a: string, b: string): number {
  const [pa, pb] = [parseVersion(a), parseVersion(b)];
  for (let index = 0; index < 3; index++) {
    const [na, nb] = [pa[index] ?? 0, pb[index] ?? 0];
    if (na !== nb) return na - nb;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseVersion(version: string): [number, number, number] {
  const core = version.split("-")[0] ?? version;
  const [major, minor = "0", patch = "0"] = core.split(".");
  return [Number(major) || 0, Number(minor) || 0, Number(patch) || 0];
}

/** Post-order DFS over the final dependency edges so dependencies precede dependents. */
function topoSort(
  picks: Map<string, { version?: string; metadata: { source: string; dependencies?: string[] } }>,
  constraints: Map<string, { range: string; by: string }[]>,
): Resolution[] {
  const resolutions = new Map<string, Resolution>();
  for (const [name, pick] of picks) {
    resolutions.set(name, {
      name,
      source: pick.metadata.source,
      dependencies: pick.metadata.dependencies ?? [],
      requiredBy: (constraints.get(name) ?? []).map((c) => c.by),
      ...(pick.version ? { version: pick.version } : {}),
    });
  }
  const ordered: Resolution[] = [];
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const resolution = resolutions.get(name);
    if (!resolution) return;
    for (const dep of resolution.dependencies) {
      visit(safeParse(dep).name);
    }
    ordered.push(resolution);
  };
  for (const name of [...resolutions.keys()].sort()) {
    visit(name);
  }
  return ordered;
}

function safeParse(value: string): SkillSpec {
  try {
    return parseSkillSpec(value);
  } catch {
    return { name: value, range: "" };
  }
}

/**
 * True when the spec is a bare name (optionally with range), not a source.
 * Windows-style paths (`C:\...`, `dir\skill`) count as sources.
 */
export function isNameSpec(value: string): boolean {
  return (
    !value.startsWith("github:") &&
    !value.startsWith("local:") &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !/^[a-zA-Z]:/.test(value)
  );
}

export { validRange as isValidRange };
