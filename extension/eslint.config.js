import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // The popup and the dashboard are page entry points: they mount a root and
    // export nothing, by design. `react-refresh/only-export-components` exists
    // to keep Vite's HMR boundary intact in an app where these files would be
    // imported by a router; here nothing imports them, so the rule only ever
    // fires on the two files it cannot apply to.
    files: ['src/popup/popup.tsx', 'src/dashboard/dashboard.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // Tests assert against replies that cross `chrome.runtime.sendMessage`,
    // which is JSON-shaped and untyped on the wire. Reconstructing those types
    // in the test would assert against our own declarations rather than
    // against what the worker actually sent.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
])
