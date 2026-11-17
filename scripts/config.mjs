// Plugin options. Claude Code exports userConfig values to hook processes as
// CLAUDE_PLUGIN_OPTION_<KEY>; the review worker inherits them from the hook.
import fs from 'node:fs';
import path from 'node:path';
import { claudeDir, dataDir } from './paths.mjs';

const DEFAULTS = {
  learning: true,
  autonomy: 'auto',
  learning_language: 'en',
  inloop_review: true,
  review_every_turns: 10,
  early_review_failures: 2,
  background_review: true,
  reviewer_model: 'haiku',
  judge_model: 'haiku',
  monthly_budget_usd: 5,
  inloop_review_max_context: 150000,
};

function envRaw(key) {
  return process.env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`];
}

function asBool(v, fallback) {
  if (v === undefined || v === '') return fallback;
  return !/^(false|0|no|off)$/i.test(String(v).trim());
}

function asNumber(v, fallback) {
  const n = Number(v);
  return v === undefined || v === '' || !Number.isFinite(n) ? fallback : n;
}

/** Snapshot written by the SessionStart hook, for tools started outside hooks (backfill). */
function snapshot() {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir(), 'options.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The options as Claude Code stores them: `pluginConfigs["ouroboros@<marketplace>"].options`
 * in the user settings, where `/plugin` saves them. Read by tools that run outside hooks
 * (the dashboard, the worker started by hand), so a value changed there shows up without
 * waiting for the next session start to refresh the snapshot. Returns { values, mtimeMs }
 * or null. Project and local settings are not read (a dashboard has no project).
 */
export function settingsOptions() {
  const file = path.join(claudeDir(), 'settings.json');
  try {
    const configs = JSON.parse(fs.readFileSync(file, 'utf8'))?.pluginConfigs;
    if (!configs || typeof configs !== 'object') return null;
    let values = null;
    for (const [id, conf] of Object.entries(configs)) {
      if ((id === 'ouroboros' || id.startsWith('ouroboros@')) && conf?.options && typeof conf.options === 'object') {
        values = { ...values, ...conf.options };
      }
    }
    return values ? { values, mtimeMs: fs.statSync(file).mtimeMs } : null;
  } catch {
    return null;
  }
}

function fromEnv() {
  return parse(envRaw);
}

function parse(raw) {
  return {
    learning: asBool(raw('learning'), DEFAULTS.learning),
    autonomy: ['auto', 'hybrid', 'queue'].includes(raw('autonomy')) ? raw('autonomy') : DEFAULTS.autonomy,
    learningLanguage: ['en', 'pt-BR', 'auto'].includes(raw('learning_language')) ? raw('learning_language') : DEFAULTS.learning_language,
    inloopReview: asBool(raw('inloop_review'), DEFAULTS.inloop_review),
    reviewEveryTurns: Math.max(1, asNumber(raw('review_every_turns'), DEFAULTS.review_every_turns)),
    earlyReviewFailures: Math.max(1, asNumber(raw('early_review_failures'), DEFAULTS.early_review_failures)),
    // `measure_review` was the phase 1 name of this option.
    backgroundReview: asBool(raw('background_review') ?? raw('measure_review'), DEFAULTS.background_review),
    reviewerModel: raw('reviewer_model') || DEFAULTS.reviewer_model,
    // Screen and editor of the learning evaluation; follows the reviewer unless set.
    judgeModel: raw('judge_model') || raw('reviewer_model') || DEFAULTS.judge_model,
    monthlyBudgetUsd: asNumber(raw('monthly_budget_usd'), DEFAULTS.monthly_budget_usd),
    // In-session reviews are skipped above this context size (tokens); 0 = no limit.
    inloopReviewMaxContext: Math.max(0, asNumber(raw('inloop_review_max_context'), DEFAULTS.inloop_review_max_context)),
  };
}

let inHook = false;

/**
 * Called by the hook dispatcher. Claude Code exports only the options the user set, so in
 * a hook an absent variable means the default, not "read the snapshot": a hook that fell
 * back to the snapshot wrote it back, and a value set once outlived its reset.
 */
export function optionsFromEnvOnly() {
  inHook = true;
}

export function options() {
  const hasEnv = Object.keys(process.env).some((k) => k.startsWith('CLAUDE_PLUGIN_OPTION_'));
  if (hasEnv || inHook) return fromEnv();
  return storedOptions() || fromEnv();
}

/**
 * The options as last set, for a process that is not a hook and may run for days (the
 * dashboard): the plugin settings when they changed after the snapshot was taken (an
 * option edited since the last session start), else the snapshot. Null when neither exists.
 */
export function storedOptions() {
  const base = parse(() => undefined);
  const snap = snapshot();
  // The settings are what Claude Code exports to the next hook: an option they do not set
  // is its default there, as here.
  const settings = settingsOptions();
  if (settings && (!snap || settings.mtimeMs > (Number(snap.updatedAt) || 0))) {
    return parse((key) => (settings.values[key] === undefined || settings.values[key] === null ? undefined : String(settings.values[key])));
  }
  if (!snap) return null;
  const { updatedAt, measureReview, autoMemory, ...rest } = snap;
  return { ...base, ...(measureReview !== undefined && rest.backgroundReview === undefined ? { backgroundReview: measureReview } : {}), ...rest };
}
