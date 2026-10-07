// Copies the production build (dist/) into the backend's static folder so the
// local API serves it. Run with `npm run build:embed`.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '..', 'dist');
const target = resolve(here, '..', '..', 'backend', 'src', 'dms_analytics', 'static');

if (!existsSync(join(dist, 'index.html'))) {
  console.error('dist/index.html not found. Run `npm run build` first.');
  process.exit(1);
}
if (!existsSync(dirname(target))) {
  console.error(`Backend package folder not found: ${dirname(target)}`);
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(dist, target, { recursive: true });
console.log(`Copied ${dist} -> ${target}`);
