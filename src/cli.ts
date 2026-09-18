#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import pc from "picocolors";
import { ADAPTERS, getAdapter, type AdapterSpec } from "./adapter.js";
import { deleteMail, listMail, pruneMail, readMail, sendMail } from "./agent/mailbox.js";
import { syncMailboxes } from "./mail-sync.js";
import { defaultHome } from "./config.js";
import {
  cloneEnv,
  createEnv,
  getEnv,
  listEnvs,
  removeEnv,
  renameEnv,
} from "./env.js";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { checkEnv, describeEnv, diffEnvs, providerReadiness } from "./inspect.js";
import { installSpecs } from "./installer.js";
import { exportManifest, loadManifestFile, readManifest, writeManifest } from "./manifest.js";
import { installPlugin, listPlugins } from "./plugins.js";
import { getPreset, listPresets } from "./preset.js";
import { publishSkill } from "./publish.js";
import {
  addRegistrySource,
  getRegistrySkill,
  listRegistrySkills,
  listRegistrySources,
  searchRegistrySkills,
  updateRegistryCache,
} from "./registry.js";
import { runCommand } from "./runner.js";
import {
  createClaudeCodeAdapter,
  createCodexPluginAdapter,
  createGeminiAdapter,
  createPiAdapter,
} from "./scaffolds.js";
import { VERSION } from "./version.js";
import { registerAgentCommands } from "./agent/cli.js";
import { resolveProvider } from "./agent/providers.js";

function fail(message: string): never {
  process.stderr.write(`${pc.red("error:")} ${message}\n`);
  process.exit(1);
}

function mustGetEnv(name: string) {
  try {
    return getEnv(name, defaultHome());
  } catch (error) {
    fail((error as Error).message);
  }
}

function printDiffSection(title: string, items: string[]): void {
  process.stdout.write(`${title}\n`);
  if (items.length === 0) {
    process.stdout.write("  -\n");
    return;
  }
  for (const item of items) {
    process.stdout.write(`  ${item}\n`);
  }
}

const program = new Command();

program
  .name("skillenv")
  .description("Manage isolated agent skill environments.")
  .version(VERSION, "-V, --version", "Print the skillenv version.");

program
  .command("version")
  .description("Print the skillenv version.")
  .action(() => {
    process.stdout.write(`skillenv ${VERSION}\n`);
  });

interface CreateOptions {
  file?: string;
  preset?: string;
  installPlugins?: boolean;
  adapter?: string;
}

program
  .command("create [name]")
  .description("Create an isolated agent skill environment.")
  .option("-f, --file <manifest>", "Create from a skillenv.yml manifest.")
  .option("-p, --preset <preset>", "Initialize manifest from a built-in preset.")
  .option("--install-plugins", "Install plugin selectors from the selected preset.", false)
  .option("-a, --adapter <adapter>", `Adapter for the environment (${Object.keys(ADAPTERS).join("|")}).`)
  .action(async (name: string | undefined, options: CreateOptions) => {
    const home = defaultHome();
    try {
      if (options.file) {
        const manifest = loadManifestFile(options.file);
        const env = createEnv(manifest.name, home, manifest.adapter);
        writeManifest(env.root, manifest);
        const outcome = await installSpecs(env.root, home, manifest.skills, { force: true });
        for (const warning of outcome.warnings) {
          process.stderr.write(`${pc.yellow("warning:")} ${warning}\n`);
        }
        for (const plugin of manifest.plugins) {
          installPlugin(env.root, plugin);
        }
        process.stdout.write(`created ${env.name}: ${env.root}\n`);
        return;
      }
      if (!name) {
        fail("environment name is required unless --file is used");
      }
      if (options.adapter && !ADAPTERS[options.adapter]) {
        fail(`unknown adapter: ${options.adapter} (available: ${Object.keys(ADAPTERS).join(", ")})`);
      }
      const adapter = options.adapter ?? "codex";
      const env = createEnv(name, home, adapter);
      if (options.preset) {
        const preset = getPreset(options.preset);
        writeManifest(env.root, {
          name: env.name,
          adapter,
          skills: preset.skills,
          plugins: preset.plugins,
        });
        if (options.installPlugins) {
          for (const plugin of preset.plugins) {
            installPlugin(env.root, plugin);
          }
        }
      }
      process.stdout.write(`created ${env.name}: ${env.root}\n`);
    } catch (error) {
      fail((error as Error).message);
    }
  });

program
  .command("clone <source> <target>")
  .description("Clone an environment without sessions or logs.")
  .action((source: string, target: string) => {
    try {
      const cloned = cloneEnv(source, target, defaultHome());
      process.stdout.write(`cloned ${source} -> ${cloned.name}: ${cloned.root}\n`);
    } catch (error) {
      fail((error as Error).message);
    }
  });

program
  .command("install <env> <specs...>")
  .description("Install skills into an environment (name[@range], github:owner/repo/path[@ref], or a local path).")
  .option("-F, --force", "Overwrite already-installed skills.", false)
  .option("--skip-existing", "Leave already-installed skills untouched.", false)
  .action(async (envName: string, specs: string[], options: { force: boolean; skipExisting: boolean }) => {
    const env = mustGetEnv(envName);
    try {
      const outcome = await installSpecs(env.root, defaultHome(), specs, {
        force: options.force,
        skipExisting: options.skipExisting,
      });
      for (const warning of outcome.warnings) {
        process.stderr.write(`${pc.yellow("warning:")} ${warning}\n`);
      }
      for (const skill of outcome.installed) {
        const version = skill.version ? `@${skill.version}` : "";
        const by = skill.requiredBy.length > 1 ? ` (required by ${skill.requiredBy.join(", ")})` : "";
        process.stdout.write(`installed ${skill.name}${version}: ${skill.source}${by}\n`);
      }
    } catch (error) {
      fail((error as Error).message);
    }
  });

program
  .command("export <env>")
  .description("Print an environment manifest.")
  .action((envName: string) => {
    const env = mustGetEnv(envName);
    try {
      process.stdout.write(exportManifest(env.root));
    } catch (error) {
      fail((error as Error).message);
    }
  });

program
  .command("remove <env>")
  .description("Remove an isolated skill environment.")
  .action((envName: string) => {
    try {
      removeEnv(envName, defaultHome());
      process.stdout.write(`removed ${envName}\n`);
    } catch (error) {
      fail((error as Error).message);
    }
  });

program
  .command("doctor <env>")
  .description("Check an environment for common configuration problems.")
  .option("--agent", "Also report which built-in agent providers are ready to use.", false)
  .action((envName: string, options: { agent?: boolean }) => {
    const env = mustGetEnv(envName);
    const result = checkEnv(env.root, env.name);
    if (result.ok) {
      process.stdout.write(`OK ${env.name}\n`);
    } else {
      for (const issue of result.issues) {
        process.stdout.write(`${issue}\n`);
      }
    }
    if (options.agent) {
      process.stdout.write("agent providers:\n");
      for (const provider of providerReadiness()) {
        const status = provider.ready ? "ready" : `missing ${provider.missing}`;
        process.stdout.write(`  ${provider.id}\t${status}\n`);
      }
    }
    if (!result.ok) {
      process.exit(1);
    }
  });

program
  .command("diff <left> <right>")
  .description("Compare skills and plugins recorded in two environments.")
  .action((leftName: string, rightName: string) => {
    const left = mustGetEnv(leftName);
    const right = mustGetEnv(rightName);
    const result = diffEnvs(left.root, left.name, right.root, right.name);
    printDiffSection(`skills only in ${result.leftName}:`, result.skillsOnlyLeft);
    printDiffSection(`skills only in ${result.rightName}:`, result.skillsOnlyRight);
    printDiffSection(`plugins only in ${result.leftName}:`, result.pluginsOnlyLeft);
    printDiffSection(`plugins only in ${result.rightName}:`, result.pluginsOnlyRight);
  });

program
  .command("run <env> [args...]")
  .description("Run a command inside an environment (adapter isolation vars applied). Defaults to the adapter's command.")
  .allowUnknownOption(true)
  .action((envName: string, args: string[]) => {
    const env = mustGetEnv(envName);
    try {
      const manifest = readManifest(env.root);
      const effective = args.length > 0 ? args : [getAdapter(manifest.adapter).defaultCommand ?? ""].filter(Boolean);
      if (effective.length === 0) {
        fail(`adapter '${manifest.adapter}' has no default command; pass one after --`);
      }
      const code = runCommand(env.root, manifest.adapter, effective);
      process.exit(code);
    } catch (error) {
      fail((error as Error).message);
    }
  });

const envApp = program.command("env").description("Inspect and manage environments.");

envApp
  .command("list")
  .description("List isolated skill environments.")
  .action(() => {
    const envs = listEnvs(defaultHome());
    if (envs.length === 0) {
      process.stdout.write("no environments\n");
      return;
    }
    for (const env of envs) {
      process.stdout.write(`${env.name}\t${env.root}\n`);
    }
  });

envApp
  .command("info <env>")
  .description("Print a summary of one environment.")
  .action((envName: string) => {
    const env = mustGetEnv(envName);
    const summary = describeEnv(env.root, env.name);
    process.stdout.write(`name: ${summary.name}\n`);
    process.stdout.write(`root: ${summary.root}\n`);
    process.stdout.write(`adapter: ${summary.adapter}\n`);
    process.stdout.write(`skills: ${summary.skills.length > 0 ? summary.skills.join(", ") : "-"}\n`);
    process.stdout.write(`plugins: ${summary.plugins.length > 0 ? summary.plugins.join(", ") : "-"}\n`);
  });

envApp
  .command("rename <old> <new>")
  .description("Rename an environment, preserving its skills, plugins, and sessions.")
  .action((oldName: string, newName: string) => {
    try {
      const renamed = renameEnv(oldName, newName, defaultHome());
      process.stdout.write(`renamed ${oldName} -> ${renamed.name}: ${renamed.root}\n`);
    } catch (error) {
      fail((error as Error).message);
    }
  });

const presetApp = program.command("preset").description("Inspect built-in environment presets.");

presetApp
  .command("list")
  .description("List built-in environment presets.")
  .action(() => {
    for (const name of listPresets()) {
      const preset = getPreset(name);
      process.stdout.write(`${preset.name}\t${preset.description}\n`);
    }
  });

const registryApp = program.command("registry").description("Inspect and manage skill registries.");

registryApp
  .command("list")
  .description("List skills across the bundled registry and all cached sources.")
  .action(() => {
    for (const skill of listRegistrySkills(defaultHome())) {
      const versions = skill.versions ? Object.keys(skill.versions).join(",") : "-";
      process.stdout.write(`${skill.name}\t${versions}\t${skill.source ?? ""}\t${skill.description}\n`);
    }
  });

registryApp
  .command("show <name>")
  .description("Show one registry skill with its versions.")
  .action((name: string) => {
    try {
      const skill = getRegistrySkill(name, defaultHome());
      process.stdout.write(`name: ${skill.name}\n`);
      process.stdout.write(`description: ${skill.description}\n`);
      if (skill.source) process.stdout.write(`source: ${skill.source}\n`);
      for (const [version, meta] of Object.entries(skill.versions ?? {})) {
        process.stdout.write(`version: ${version}\t${meta.source}\n`);
      }
    } catch (error) {
      fail((error as Error).message);
    }
  });

registryApp
  .command("search <query>")
  .description("Search bundled and cached registry skills.")
  .action((query: string) => {
    for (const skill of searchRegistrySkills(query, defaultHome())) {
      const versions = skill.versions ? Object.keys(skill.versions).join(",") : "-";
      process.stdout.write(`${skill.name}\t${versions}\t${skill.source ?? ""}\t${skill.description}\n`);
    }
  });

registryApp
  .command("add <name> <url>")
  .description("Add a local or remote registry source.")
  .action((name: string, url: string) => {
    try {
      addRegistrySource(name, url, defaultHome());
      process.stdout.write(`added ${name}: ${url}\n`);
    } catch (error) {
      fail((error as Error).message);
    }
  });

registryApp
  .command("sources")
  .description("List configured registry sources.")
  .action(() => {
    const sources = listRegistrySources(defaultHome());
    if (sources.length === 0) {
      process.stdout.write("no registry sources\n");
      return;
    }
    for (const source of sources) {
      process.stdout.write(`${source.name}\t${source.url}\n`);
    }
  });

registryApp
  .command("update")
  .description("Refresh configured registry caches.")
  .action(async () => {
    try {
      const outcome = await updateRegistryCache(defaultHome());
      for (const name of outcome.updated) {
        process.stdout.write(`updated ${name}\n`);
      }
      for (const failure of outcome.failed) {
        process.stderr.write(`${pc.yellow("warning:")} source '${failure.name}' failed: ${failure.error}\n`);
      }
      process.stdout.write(
        `updated ${outcome.updated.length} registry source${outcome.updated.length === 1 ? "" : "s"}${outcome.failed.length > 0 ? `, ${outcome.failed.length} failed` : ""}\n`,
      );
      if (outcome.updated.length === 0 && outcome.failed.length > 0) {
        process.exit(1);
      }
    } catch (error) {
      fail((error as Error).message);
    }
  });

registryApp
  .command("publish <skill-dir>")
  .description("Validate a skill and emit (or upsert) a versioned registry entry.")
  .option("-s, --source <spec>", "Published source spec recorded in the entry (e.g. github:owner/repo/path@v1.0.0).")
  .option("-r, --registry <file>", "Upsert the entry into this registry JSON file instead of printing it.")
  .option("-d, --depends <specs>", "Comma-separated dependency specs for the published version.")
  .action((skillDir: string, options: { source?: string; registry?: string; depends?: string }) => {
    try {
      const result = publishSkill(skillDir, {
        source: options.source,
        registry: options.registry,
        dependencies: (options.depends ?? "").split(","),
      });
      for (const warning of result.warnings) {
        process.stderr.write(`${pc.yellow("warning:")} ${warning}\n`);
      }
      if (!options.registry) {
        const entry = { version: 2, skills: [result.entry] };
        process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
      } else {
        process.stdout.write(`upserted ${result.entry.name}@${Object.keys(result.entry.versions)[0]} into ${options.registry}\n`);
      }
    } catch (error) {
      fail((error as Error).message);
    }
  });

const adapterApp = program.command("adapter").description("Generate agent adapter artifacts.");

adapterApp
  .command("list")
  .description("List supported agent adapters and their isolation variables.")
  .action(() => {
    for (const id of Object.keys(ADAPTERS).sort()) {
      const spec = ADAPTERS[id] as AdapterSpec;
      const home = spec.homeVar ? `\t${spec.homeVar}` : "\t-";
      process.stdout.write(`${spec.id}${home}\t${spec.displayName}\n`);
    }
  });

adapterApp
  .command("codex")
  .option("-o, --out <dir>", "Parent directory for the adapter plugin.", "plugins")
  .description("Create a Codex plugin adapter for skillenv.")
  .action((options: { out: string }) => {
    try {
      const root = createCodexPluginAdapter(options.out);
      process.stdout.write(`created skillenv-codex: ${root}\n`);
    } catch (error) {
      fail((error as Error).message);
    }
  });

adapterApp
  .command("claude-code")
  .option("-o, --out <dir>", "Parent directory for the Claude Code adapter.", "adapters")
  .description("Create a Claude Code skill adapter for skillenv.")
  .action((options: { out: string }) => {
    try {
      const root = createClaudeCodeAdapter(options.out);
      process.stdout.write(`created skillenv-claude-code: ${root}\n`);
    } catch (error) {
      fail((error as Error).message);
    }
  });

adapterApp
  .command("pi")
  .option("-o, --out <dir>", "Parent directory for the pi adapter.", "adapters")
  .description("Create a pi coding agent adapter for skillenv.")
  .action((options: { out: string }) => {
    try {
      const root = createPiAdapter(options.out);
      process.stdout.write(`created skillenv-pi: ${root}\n`);
    } catch (error) {
      fail((error as Error).message);
    }
  });

adapterApp
  .command("gemini")
  .option("-o, --out <dir>", "Parent directory for the Gemini adapter.", "adapters")
  .description("Create a Gemini CLI adapter for skillenv (experimental).")
  .action((options: { out: string }) => {
    try {
      const root = createGeminiAdapter(options.out);
      process.stdout.write(`created skillenv-gemini: ${root}\n`);
    } catch (error) {
      fail((error as Error).message);
    }
  });

const pluginApp = program.command("plugin").description("Manage environment plugin selectors.");

pluginApp
  .command("install <env> <selector>")
  .description("Record a plugin selector in an environment config.")
  .action((envName: string, selector: string) => {
    const env = mustGetEnv(envName);
    try {
      const installed = installPlugin(env.root, selector);
      process.stdout.write(`installed ${installed}\n`);
    } catch (error) {
      fail((error as Error).message);
    }
  });

pluginApp
  .command("list <env>")
  .description("List plugin selectors recorded in an environment.")
  .action((envName: string) => {
    const env = mustGetEnv(envName);
    const plugins = listPlugins(env.root);
    if (plugins.length === 0) {
      process.stdout.write("no plugins\n");
      return;
    }
    for (const plugin of plugins) {
      process.stdout.write(`${plugin}\n`);
    }
  });

// Built-in coding agent (provider-agnostic OpenAI-compatible harness).
registerAgentCommands(program);

program
  .command("pantheon")
  .description("Launch the Pantheon round-table GUI — one fully isolated agent harness per god.")
  .option("-g, --god <env...>", "Environment names as gods (repeatable; missing default gods are auto-created).")
  .option("--persona <pair...>", "Persona override god=text (repeatable).")
  .option("-p, --provider <id>", "Shared provider for gods without their own env override.")
  .option("-m, --model <model>", "Shared model.")
  .option("--base-url <url>", "Shared provider base URL.")
  .option("--api-key <key>", "Shared API key.")
  .option("--port <n>", "Port to listen on.", "4620")
  .option("--dir <path>", "Working directory for gods' tools (default: current directory).")
  .option("--no-open", "Do not open the browser automatically.")
  .action(async (options: {
    god?: string[]; persona?: string[]; provider?: string; model?: string;
    baseUrl?: string; apiKey?: string; port?: string; dir?: string; open?: boolean;
  }) => {
    const { listenPantheon, resolveGods, ensureGodEnv } = await import("./ui/pantheon.js");
    try {
      const shared = resolveProvider({
        provider: options.provider,
        model: options.model,
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
      });
      const personas: Record<string, string> = {};
      for (const pair of options.persona ?? []) {
        const eq = pair.indexOf("=");
        if (eq === -1) fail(`--persona expects god=text, got: ${pair}`);
        personas[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      const requested = options.god ?? [];
      // Pre-create explicitly requested gods so resolveGods sees them as intentional.
      for (const name of requested) ensureGodEnv(name, defaultHome());
      const gods = resolveGods(requested, shared, personas, defaultHome());
      const port = Math.max(1, Number.parseInt(options.port ?? "4620", 10) || 4620);
      const workdir = path.resolve(options.dir ?? process.cwd());
      const { server, url } = await listenPantheon({ gods, workdir }, port);
      const roster = gods.map((god) => god.name).join(", ");
      process.stdout.write(
        `PANTHEON convened: ${roster}\n${url}  (provider=${shared.id}/${shared.model}, dir=${workdir})\nCtrl-C to adjourn.\n`,
      );
      if (options.open !== false) {
        const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
        const openerArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
        try {
          spawn(opener, openerArgs, { stdio: "ignore", detached: true }).unref();
        } catch {
          // best effort only
        }
      }
      const shutdown = (): void => {
        server.close();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    } catch (error) {
      fail((error as Error).message);
    }
  });

const mailApp = program.command("mail").description("Read and send cross-environment mailbox messages (the agent bus humans can use too).");

mailApp
  .command("send <env> <to> <subject...>")
  .description("Send a message into another environment's mailbox (same skillenv home).")
  .option("--body <text>", "Message body (prompt for stdin when omitted).")
  .action((envName: string, to: string, subjectParts: string[], options: { body?: string }) => {
    const from = mustGetEnv(envName);
    const toEnv = mustGetEnv(to);
    try {
      let body = options.body ?? "";
      if (body.length === 0) {
        body = readFileSync(0, "utf8");
      }
      const id = sendMail({
        fromEnv: from.name,
        fromRoot: from.root,
        toEnv: toEnv.name,
        toRoot: toEnv.root,
        subject: subjectParts.join(" "),
        body: body.trim(),
      });
      process.stdout.write(`sent ${id}: ${from.name} -> ${toEnv.name}\n`);
    } catch (error) {
      fail((error as Error).message);
    }
  });

mailApp
  .command("list <env>")
  .description("List mailbox messages (newest first; unread only by default).")
  .option("-a, --all", "Include already-read messages.", false)
  .action((envName: string, options: { all?: boolean }) => {
    const env = mustGetEnv(envName);
    const messages = listMail(env.root, { unreadOnly: !options.all });
    if (messages.length === 0) {
      process.stdout.write("(mailbox empty)\n");
      return;
    }
    for (const message of messages) {
      const state = message.read ? "read  " : "unread";
      process.stdout.write(`${state}\t${message.id}\t${message.from}\t${message.subject}\n`);
    }
  });

mailApp
  .command("read <env> <id>")
  .description("Print one message (marks it read).")
  .action((envName: string, id: string) => {
    const env = mustGetEnv(envName);
    try {
      const message = readMail(env.root, id);
      if (!message) fail(`message not found: ${id}`);
      process.stdout.write(`from: ${message?.from}\nsubject: ${message?.subject}\n\n${message?.body}\n`);
    } catch (error) {
      fail((error as Error).message);
    }
  });

mailApp
  .command("delete <env> <id>")
  .description("Delete one mailbox message.")
  .action((envName: string, id: string) => {
    const env = mustGetEnv(envName);
    if (!deleteMail(env.root, id)) fail(`message not found: ${id}`);
    process.stdout.write(`deleted ${id}\n`);
  });

mailApp
  .command("prune <env>")
  .description("Delete old messages (read ones older than --days; --all includes unread).")
  .option("-d, --days <n>", "Age threshold in days.", "30")
  .option("-a, --all", "Include unread messages.", false)
  .action((envName: string, options: { days?: string; all?: boolean }) => {
    const env = mustGetEnv(envName);
    const days = Number.parseInt(options.days ?? "30", 10);
    if (Number.isNaN(days) || days < 0) fail(`invalid --days: ${options.days}`);
    const deleted = pruneMail(env.root, { maxAgeDays: days, includeUnread: options.all ?? false });
    process.stdout.write(`pruned ${deleted} message${deleted === 1 ? "" : "s"} from ${env.name}\n`);
  });

mailApp
  .command("sync <remote>")
  .description("Two-way sync of all environment mailboxes with a git remote (cross-machine).")
  .option("-m, --message <text>", "Commit message for this sync round.")
  .action((remote: string, options: { message?: string }) => {
    try {
      const outcome = syncMailboxes(defaultHome(), remote, { message: options.message });
      process.stdout.write(
        `synced: imported ${outcome.imported}, exported ${outcome.exported} message(s); ${outcome.commits} commit(s)\nbus: ${outcome.workdir}\n`,
      );
    } catch (error) {
      fail((error as Error).message);
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
