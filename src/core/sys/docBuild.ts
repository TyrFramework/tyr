/**
 * @fileoverview Built-in `tyr doc:build` command — the static counterpart to `sys/doc.ts`. Where
 * `tyr doc` parses JSDoc on every request and serves it live on `localhost:3000`, this command
 * runs the exact same extraction (via `buildDocsData()` in `sys/docData.ts`) once and writes the
 * result to a JSON file, so the `pages/` GitHub Pages site (a sibling folder / git submodule of
 * this repo) can serve a stable, versioned `/docs` page with no server involved.
 *
 * Deliberately just a data dump: this file knows nothing about HTML or styling — all of that
 * lives in the `pages` repo (`docs/index.html`, `assets/js/docs.js`), which only ever reads the
 * JSON this command produces. Unlike `tyr doc`, this intentionally drops the "User Commands"
 * section (`buildDocsData()`'s `commands`, scanned from `~/.tyr/commands/*.tyr.ts`): that folder
 * holds whoever ran the build's own local/personal commands, never appropriate to publish on the
 * public framework site, so only `systemContext` and `modules` (the framework's own Managers) are
 * written out.
 */
import fs from 'fs';
import path from 'path';
import { TyrContext } from '../Kernel';
import { buildDocsData } from './docData';

/**
 * @method docBuild (default export)
 * @description Runs the same JSDoc extraction `tyr doc` serves live, and writes the framework's
 * own `systemContext`/`modules` as pretty-printed JSON instead of rendering HTML — deliberately
 * excluding the "User Commands" section, since that reflects whoever ran the build's local
 * `~/.tyr/commands/`, not the public framework. Defaults to
 * `<frameworkRoot>/pages/docs/data/en.json` (the `pages` submodule's docs data folder); pass
 * `--out <path>` to write somewhere else. Creates any missing parent directories. Does NOT commit
 * or push anything — the `pages` repo is a separate git checkout, so staging/committing/pushing
 * the regenerated file is left to the user.
 * @param {TyrContext} context - Only `logger`, `frameworkRoot` and `userRoot` are needed here.
 * @returns {(args: string[]) => Promise<void>} Handler; reads `--out <path>` from `args` if present.
 * @example
 * // tyr doc:build
 * // -> Docs data written to: C:\...\TyrFramework\pages\docs\data\en.json
 * // -> Remember to commit & push the change inside the pages/ submodule.
 *
 * // tyr doc:build --out ./tmp/docs.json
 */
export default function docBuild({ logger, frameworkRoot, userRoot }: TyrContext) {
    return async (args: string[]) => {
        const outFlagIndex = args.indexOf('--out');
        const outPath = outFlagIndex !== -1 && args[outFlagIndex + 1]
            ? path.resolve(args[outFlagIndex + 1])
            : path.resolve(frameworkRoot, 'pages/docs/data/en.json');

        logger.info('📚 Building static documentation data...');

        const { systemContext, modules } = buildDocsData({ frameworkRoot, userRoot });
        const data = { systemContext, modules };

        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf-8');

        logger.success(`Docs data written to: ${outPath}`);
        logger.info('Remember to commit & push the change inside the pages/ submodule.');
    };
};
