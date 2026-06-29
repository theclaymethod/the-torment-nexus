// @ts-check
/**
 * paths.mjs — canonical filesystem layout for whimsy.
 *
 * Pure path resolution plus a few existence/ensure helpers. No business logic.
 *
 * Two scopes exist:
 *  - global:  ~/.whimsy/        — the persistent being that travels across projects.
 *  - project: <cwd>/.whimsy/    — a repo's own being; overrides global when present.
 *
 * Soul resolution order: project SOUL.md if it exists, else global SOUL.md.
 * The soul's life (memories, ledger, play) lives in the SAME `.whimsy` dir as the
 * resolved soul — use {@link resolveBase} to get that dir, then the layout helpers
 * (memoriesDir, ledgerPath, playDir, …) which all take a whimsyDir argument.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** @typedef {'project'|'global'} Scope */
/** @typedef {{ path: string, scope: Scope }} SoulRef */

/** Absolute path to the global whimsy dir (`~/.whimsy`). @returns {string} */
export function globalDir() {
  return path.join(os.homedir(), '.whimsy');
}

/**
 * Absolute path to a project's whimsy dir (`<cwd>/.whimsy`).
 * @param {string} [cwd] working directory (default: process.cwd())
 * @returns {string}
 */
export function projectDir(cwd = process.cwd()) {
  return path.resolve(cwd, '.whimsy');
}

/** SOUL.md path inside a given whimsy dir. @param {string} whimsyDir @returns {string} */
export function soulPath(whimsyDir) {
  return path.join(whimsyDir, 'SOUL.md');
}

/** SOUL.md path for the global soul. @returns {string} */
export function globalSoulPath() {
  return soulPath(globalDir());
}

/** SOUL.md path for a project soul. @param {string} [cwd] @returns {string} */
export function projectSoulPath(cwd = process.cwd()) {
  return soulPath(projectDir(cwd));
}

/**
 * Resolve the active soul: project SOUL.md if it exists, else global SOUL.md.
 * @param {string} [cwd]
 * @returns {SoulRef|null} ref to the active soul, or null if no soul exists yet.
 */
export function resolveSoul(cwd = process.cwd()) {
  const proj = projectSoulPath(cwd);
  if (exists(proj)) return { path: proj, scope: 'project' };
  const glob = globalSoulPath();
  if (exists(glob)) return { path: glob, scope: 'global' };
  return null;
}

/**
 * Resolve the whimsy dir that holds the active soul's life (memories/ledger/play).
 * Mirrors {@link resolveSoul}: project `.whimsy` if a project soul exists, else
 * global `.whimsy`. Falls back to the project dir when no soul exists yet (so
 * `init` writes into the project).
 * @param {string} [cwd]
 * @returns {{ dir: string, scope: Scope }}
 */
export function resolveBase(cwd = process.cwd()) {
  const ref = resolveSoul(cwd);
  if (ref) return { dir: path.dirname(ref.path), scope: ref.scope };
  return { dir: projectDir(cwd), scope: 'project' };
}

// ── Memory layout ──────────────────────────────────────────────────────────

/** `.whimsy/memories` dir. @param {string} whimsyDir @returns {string} */
export function memoriesDir(whimsyDir) {
  return path.join(whimsyDir, 'memories');
}

/** `.whimsy/memories/INDEX.md`. @param {string} whimsyDir @returns {string} */
export function indexPath(whimsyDir) {
  return path.join(memoriesDir(whimsyDir), 'INDEX.md');
}

/** `.whimsy/memories/<id>` dir. @param {string} whimsyDir @param {string} id @returns {string} */
export function memoryDir(whimsyDir, id) {
  return path.join(memoriesDir(whimsyDir), id);
}

/** `.whimsy/memories/<id>/memory.md`. @param {string} whimsyDir @param {string} id @returns {string} */
export function memoryBodyPath(whimsyDir, id) {
  return path.join(memoryDir(whimsyDir, id), 'memory.md');
}

// ── Play layout ────────────────────────────────────────────────────────────

/** `.whimsy/play` dir. @param {string} whimsyDir @returns {string} */
export function playDir(whimsyDir) {
  return path.join(whimsyDir, 'play');
}

/** `.whimsy/play/<session>` dir. @param {string} whimsyDir @param {string} session @returns {string} */
export function playSessionDir(whimsyDir, session) {
  return path.join(playDir(whimsyDir), session);
}

/** `.whimsy/play/<session>/netlog`. @param {string} whimsyDir @param {string} session @returns {string} */
export function netlogPath(whimsyDir, session) {
  return path.join(playSessionDir(whimsyDir, session), 'netlog');
}

// ── Economy layout ─────────────────────────────────────────────────────────

/** `.whimsy/ledger.json`. @param {string} whimsyDir @returns {string} */
export function ledgerPath(whimsyDir) {
  return path.join(whimsyDir, 'ledger.json');
}

// ── Config layout ──────────────────────────────────────────────────────────

/** Global config path (`~/.whimsy/config.toml`). @returns {string} */
export function globalConfigPath() {
  return path.join(globalDir(), 'config.toml');
}

/** Local/project config path (`<cwd>/.whimsy/config.toml`). @param {string} [cwd] @returns {string} */
export function localConfigPath(cwd = process.cwd()) {
  return path.join(projectDir(cwd), 'config.toml');
}

/**
 * Both config paths, lowest precedence first.
 * @param {string} [cwd]
 * @returns {{ global: string, local: string }}
 */
export function configPaths(cwd = process.cwd()) {
  return { global: globalConfigPath(), local: localConfigPath(cwd) };
}

// ── Filesystem helpers ─────────────────────────────────────────────────────

/** True if a path exists. @param {string} p @returns {boolean} */
export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a directory exists (recursive mkdir), returning the path.
 * @param {string} dir
 * @returns {string}
 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Ensure the parent directory of a file exists, returning the file path.
 * @param {string} filePath
 * @returns {string}
 */
export function ensureParent(filePath) {
  ensureDir(path.dirname(filePath));
  return filePath;
}
