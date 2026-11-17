// Promise lint for the window code (src/ui): a promise that can reject and is neither awaited in a
// try nor given a catch is a crash report in the window (see src/ui/main.tsx). Only this rule is on.
// A call whose failure is decided on purpose is marked `void` (ignoreVoid), and nothing else passes.
import tseslint from 'typescript-eslint';

export default [
  {
    files: ['src/ui/**/*.ts', 'src/ui/**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
    },
  },
];
