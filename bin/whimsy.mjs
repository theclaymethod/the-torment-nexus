#!/usr/bin/env node
// @ts-check
/**
 * whimsy CLI entry point.
 *
 * Thin shim: parse argv (minus the `node` + script path prefix) and hand off to
 * the router in src/cli.mjs, which owns parsing and dispatch.
 */

import { run } from '../src/cli.mjs';

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
