/**
 * Follows the convention of `admin-dev/themes/new-theme` in PrestaShop/PrestaShop:
 * eslint-plugin-vue with @vue/eslint-config-typescript, on newer versions of both.
 */
import js from '@eslint/js';
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript';
import pluginVue from 'eslint-plugin-vue';

export default defineConfigWithVueTs(
  {
    // Generated output, recorded API responses and the screenshot helper, which is plain
    // JavaScript resolved from wherever Playwright happens to be installed.
    ignores: ['dist/**', 'dist-site/**', '.local/**', 'fixtures/**', 'docs/**'],
  },
  js.configs.recommended,
  pluginVue.configs['flat/recommended'],
  vueTsConfigs.recommended,
  {
    rules: {
      // Kept off because the assertions are load-bearing: with noUncheckedIndexedAccess on,
      // every `x[i]!` is a claim the compiler checks, and removing one fails the build. The
      // dataset is positional arrays by design and the decoder reads them by index, so
      // banning the operator here would mean replacing checked assertions with unchecked
      // defaults.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Single-word component names are the clearest here: there is one page and the files
      // sit in components/, so `FilterBar.vue` needs no prefix to disambiguate.
      'vue/multi-word-component-names': 'off',
      'vue/max-attributes-per-line': ['warn', { singleline: 6 }],
    },
  },
);
