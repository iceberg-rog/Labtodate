import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

const config = [
  // Global ignores (flat-config: an object with only `ignores`). ESLint 9 does
  // not read .gitignore, so the gitignored backup bundle + relocated legacy
  // migrations must be excluded explicitly or `eslint .` walks into them.
  { ignores: ['.backups/**', 'prisma/migrations-legacy/**', 'prisma/migrations/**'] },
  ...nextVitals,
  ...nextTypescript,
  {
    rules: {
      '@next/next/no-html-link-for-pages': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      'import/no-anonymous-default-export': 'off',
      'prefer-const': 'warn',
      'react-hooks/purity': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react/no-unescaped-entities': 'off',
    },
  },
];

export default config;
