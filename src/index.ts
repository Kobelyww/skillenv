/**
 * skillenv public API — the same primitives the CLI uses, importable from
 * other Node/TypeScript programs.
 */
export { defaultHome, envsDir, registriesPath, registryCacheDir } from "./config.js";
export {
  createEnv,
  cloneEnv,
  getEnv,
  listEnvs,
  removeEnv,
  validateEnvName,
  rewriteManifestName,
  type Env,
} from "./env.js";
export {
  defaultLock,
  readLock,
  writeLock,
  addSkillRecord,
  addPluginRecord,
  directoryChecksum,
  type LockFile,
  type LockSkill,
  type LockPlugin,
} from "./lock.js";
export {
  parseManifest,
  renderManifest,
  readManifest,
  writeManifest,
  exportManifest,
  loadManifestFile,
  type Manifest,
} from "./manifest.js";
export { SKILL_FILE, readSkillMeta, type SkillMeta } from "./skill.js";
export { PRESETS, listPresets, getPreset, type Preset } from "./preset.js";
export {
  ADAPTERS,
  getAdapter,
  buildAdapterEnv,
  adapterCommand,
  type AdapterSpec,
} from "./adapter.js";
export {
  installLocalSkill,
  installGitHubSkill,
  parseGitHubSource,
  parseSourceSpec,
  type GitHubSkillSource,
  type LocalSkillSource,
  type SkillSource,
} from "./install.js";
export { installSpecs, type InstallOutcome, type InstallOptions } from "./installer.js";
export {
  parseSkillSpec,
  resolveDependencies,
  isNameSpec,
  type CatalogEntry,
  type Resolution,
  type ResolutionResult,
  type SkillSpec,
} from "./resolve.js";
export {
  loadBundledRegistry,
  listRegistrySkills,
  searchRegistrySkills,
  getRegistrySkill,
  listRegistrySources,
  addRegistrySource,
  updateRegistryCache,
  type RegistrySkill,
  type RegistrySource,
  type RegistryPayload,
} from "./registry.js";
export { installPlugin, listPlugins } from "./plugins.js";
export { checkEnv, describeEnv, diffEnvs, type DoctorResult, type DiffResult } from "./inspect.js";
export { buildRunEnv, runCommand } from "./runner.js";
export {
  createCodexPluginAdapter,
  createClaudeCodeAdapter,
  createPiAdapter,
  createGeminiAdapter,
} from "./scaffolds.js";
export { VERSION } from "./version.js";
