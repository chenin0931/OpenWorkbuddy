import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/release/**', '**/node_modules/**', 'outputs/**', 'work/**', '**/target/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
)
