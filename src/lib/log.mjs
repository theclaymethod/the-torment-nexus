// @ts-check
/**
 * log.mjs — tiny logging/formatting util. No dependencies.
 *
 * Human-facing chrome (labels, color) goes to stderr so stdout stays clean for
 * machine-consumed payloads (e.g. `whimsy inject` emits context on stdout). Color
 * is disabled when NO_COLOR is set or stderr is not a TTY.
 */

const COLOR = !process.env.NO_COLOR && Boolean(process.stderr.isTTY);

/** @type {Record<string, string>} */
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  italic: '\x1b[3m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

/**
 * Wrap text in an ANSI color if color is enabled.
 * @param {keyof typeof C} name
 * @param {string} text
 * @returns {string}
 */
export function paint(name, text) {
  if (!COLOR || !C[name]) return text;
  return `${C[name]}${text}${C.reset}`;
}

export const dim = (t) => paint('dim', t);
export const bold = (t) => paint('bold', t);

/** Informational line → stderr. @param {string} msg */
export function info(msg) {
  process.stderr.write(`${paint('cyan', '·')} ${msg}\n`);
}

/** Success line → stderr. @param {string} msg */
export function success(msg) {
  process.stderr.write(`${paint('green', '✓')} ${msg}\n`);
}

/** Warning line → stderr. @param {string} msg */
export function warn(msg) {
  process.stderr.write(`${paint('yellow', '!')} ${paint('yellow', msg)}\n`);
}

/** Error line → stderr. @param {string} msg */
export function error(msg) {
  process.stderr.write(`${paint('red', '✗')} ${paint('red', msg)}\n`);
}

/** Plain line → stdout (for content/payloads). @param {string} [msg] */
export function out(msg = '') {
  process.stdout.write(`${msg}\n`);
}

/**
 * Print quoted/boxed "soul voice" text — the soul speaking in first person.
 * Rendered to stderr as a dim, italic, left-barred block with an optional label.
 * @param {string} text the soul's words (may be multi-line)
 * @param {{ label?: string, stream?: NodeJS.WritableStream }} [opts]
 * @returns {void}
 */
export function soulVoice(text, opts = {}) {
  const stream = opts.stream ?? process.stderr;
  const lines = String(text).replace(/\n+$/, '').split('\n');
  const bar = paint('magenta', '│');
  const blocks = [];
  if (opts.label) blocks.push(`${bar} ${paint('magenta', paint('bold', opts.label))}`);
  for (const line of lines) {
    blocks.push(`${bar} ${paint('italic', paint('dim', line))}`);
  }
  stream.write(blocks.join('\n') + '\n');
}
