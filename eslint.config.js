import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['src/**/*.ts', 'test/**/*.ts'], rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-restricted-syntax': ['error', { selector: "Literal[regex=/^(0x)?[0-9a-fA-F]{64}$/]", message: 'Nada de chaves/segredos literais no código.' }]
  } },
  { ignores: ['dist/**', 'node_modules/**', 'web/**', 'contracts/**', 'scripts/**'] }
);
