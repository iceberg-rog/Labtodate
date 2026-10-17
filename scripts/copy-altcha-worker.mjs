// Copies the ALTCHA proof-of-work worker into public/ so the bot-check widget
// (src/components/security/Captcha.tsx) loads it from this site: the CSP
// (nginx/lab2date.conf) allows same-origin workers but not blob: ones.
// Runs before `next build` / `next dev` (package.json prebuild / predev).
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// The package's "exports" map has no ./package.json or ./dist entry: resolve
// the exported worker module and copy that file.
const worker = fileURLToPath(import.meta.resolve('altcha/workers/pbkdf2'));
const out = join(root, 'public', 'altcha');
mkdirSync(out, { recursive: true });
copyFileSync(worker, join(out, 'pbkdf2.js'));
console.log('[altcha] worker copied to public/altcha/pbkdf2.js');
