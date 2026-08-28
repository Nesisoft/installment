import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.turbo/**',
      'packages/db/drizzle/**',
      'docs/design/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      // TypeScript's own checker already flags undefined identifiers, and it is
      // aware of both Node and DOM/browser globals per each package's tsconfig
      // `lib`. The base `no-undef` rule is not, so it false-positives on browser
      // globals (window, localStorage, document) in the React apps.
      'no-undef': 'off',
    },
  },
  {
    // Metro and Babel load these config files through Node's CommonJS require
    // before any bundler is involved, so they cannot be ESM and cannot use
    // `import`. The rule is right everywhere else in the workspace.
    files: ['apps/*-mobile/metro.config.js', 'apps/*-mobile/babel.config.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  prettier,
);
