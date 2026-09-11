export interface Preset {
  name: string;
  description: string;
  skills: string[];
  plugins: string[];
}

export const PRESETS: Record<string, Preset> = {
  clean: {
    name: "clean",
    description: "Minimal isolated agent home with no extra skills.",
    skills: [],
    plugins: [],
  },
  coding: {
    name: "coding",
    description: "Software engineering environment.",
    skills: ["openai-docs", "superpowers", "token-usage-meter"],
    plugins: ["browser@openai-bundled", "superpowers@openai-curated"],
  },
  research: {
    name: "research",
    description: "Research and paper-writing environment.",
    skills: ["pdf", "jupyter-notebook", "latex", "zotero", "transcribe"],
    plugins: ["latex@openai-bundled", "zotero@openai-curated"],
  },
};

export function listPresets(): string[] {
  return Object.keys(PRESETS).sort();
}

export function getPreset(name: string): Preset {
  const preset = PRESETS[name];
  if (!preset) {
    throw new Error(`unknown preset: ${name}`);
  }
  return preset;
}
