#!/usr/bin/env node
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { spawn } from 'child_process';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, '..');

const tsxPkg = JSON.parse(readFileSync(join(packageRoot, 'node_modules', 'tsx', 'package.json'), 'utf-8'));
const tsxBinField = tsxPkg.bin;
const tsxBinRelative = typeof tsxBinField === 'string' ? tsxBinField : (tsxBinField.tsx ?? tsxBinField['tsx']);
const tsxEntry = join(packageRoot, 'node_modules', 'tsx', tsxBinRelative);
const entry = join(__dirname, 'tyr.ts');

const child = spawn(process.execPath, [tsxEntry, entry, ...process.argv.slice(2)], {
    stdio: 'inherit'
});

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
    console.error(`Error: Could not start tyr. ${err.message}`);
    console.error(`tsx not found at: ${tsxEntry}`);
    console.error('Try reinstalling: npm install -g @orxataguy/tyr');
    process.exit(1);
});
