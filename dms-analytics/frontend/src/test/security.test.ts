import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}
const src = files(join(root, 'src')).filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes('/test/') && !f.endsWith('.d.ts') && !/\.test\.tsx?$/.test(f));

describe('security guards', () => {
  it('index.html carries the strict CSP', () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    expect(html).toContain("default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'");
    expect(html).not.toMatch(/https?:\/\//);
  });
  it('never renders HTML from strings or uses browser storage', () => {
    // The one exception: the portal remembers its mapping settings (never rows) in localStorage (D217).
    const SETTINGS_STORE = join('src', 'portal', 'settings.ts');
    for (const f of src) {
      const s = readFileSync(f, 'utf8');
      expect(s, f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=/);
      if (f.endsWith(SETTINGS_STORE)) {
        expect(s).not.toMatch(/sessionStorage|indexedDB/);
        expect(s.match(/localStorage/g)).toHaveLength(1);
      } else expect(s, f).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    }
  });
  it('makes no requests to external hosts', () => {
    for (const f of src.filter((x) => !x.includes('/mocks/'))) {
      const s = readFileSync(f, 'utf8');
      expect(s, f).not.toMatch(/fetch\(\s*['"`]https?:/);
      // `.invalid` (RFC 2606) never resolves; the portal shim uses it only as a label for in-page requests.
      expect(s, f).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|[a-z.]+\.invalid['/])[a-z]/i);
    }
  });
});
