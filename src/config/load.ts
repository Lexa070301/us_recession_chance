import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  channelsConfigSchema,
  modelConfigSchema,
  signalsConfigSchema,
  sourcesConfigSchema,
  type ChannelsConfig,
  type ModelConfig,
  type SignalDef,
  type SourcesConfig,
} from "./schema.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG_DIR = join(ROOT, "config");

function loadYaml<T>(file: string, schema: { parse: (v: unknown) => T }): T {
  const raw = YAML.parse(readFileSync(join(CONFIG_DIR, file), "utf8"));
  return schema.parse(raw);
}

export interface AppConfig {
  sources: SourcesConfig;
  signals: SignalDef[];
  channels: ChannelsConfig;
  model: ModelConfig;
  env: {
    fredApiKey?: string;
    telegramBotToken?: string;
    databasePath: string;
    timezone: string;
    logLevel: string;
  };
}

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (cached) return cached;

  const sourcesCfg = loadYaml("sources.yaml", sourcesConfigSchema);
  const signalsCfg = loadYaml("signals.yaml", signalsConfigSchema);
  const channelsCfg = loadYaml("channels.yaml", channelsConfigSchema);
  const modelCfg = loadYaml("model.yaml", modelConfigSchema);

  cached = {
    sources: sourcesCfg,
    signals: signalsCfg.signals,
    channels: channelsCfg,
    model: modelCfg,
    env: {
      fredApiKey: process.env.FRED_API_KEY,
      telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
      databasePath: process.env.DATABASE_PATH ?? "./data/recession.db",
      timezone: process.env.TIMEZONE ?? "UTC",
      logLevel: process.env.LOG_LEVEL ?? "info",
    },
  };
  return cached;
}

export function getSeriesDef(key: string) {
  return getConfig().sources.series.find((s) => s.key === key);
}

export function getSignalDef(key: string) {
  return getConfig().signals.find((s) => s.key === key);
}

/** Resolve channel chat ids from env; channels without env set are skipped. */
export interface ChannelTarget {
  id: string;
  locale: string;
  kind: "channel" | "group";
  chatId: string;
}

export function getChannelTargets(): ChannelTarget[] {
  const out: ChannelTarget[] = [];
  for (const c of getConfig().channels.channels) {
    const chatId = process.env[c.chat_id_env];
    if (chatId) out.push({ id: c.id, locale: c.locale, kind: c.kind, chatId });
  }
  return out;
}
