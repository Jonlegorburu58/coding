import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['dist', 'dist-mock', 'mock-public', 'src/api/schema.d.ts', 'test-results', 'playwright-report']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // DMS text is untrusted: never render it as HTML.
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Render DMS text as plain text only (see D203).',
        },
        {
          selector: "MemberExpression[property.name='innerHTML']",
          message: 'Do not use innerHTML; DMS text is untrusted.',
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'localStorage', message: 'No browser storage of data or tokens (D204).' },
        { name: 'sessionStorage', message: 'No browser storage of data or tokens (D204).' },
      ],
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    files: ['src/test/**', 'src/**/*.test.{ts,tsx}', 'e2e/**'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
]);
