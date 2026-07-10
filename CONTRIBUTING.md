# Contributing

## Editor setup

Formatting and linting are split into two tools with non-overlapping
responsibilities:

- **Prettier** (`prettier.config.js`) owns all formatting -- quotes, semicolons,
  trailing commas, arrow parens.
- **ESLint** (`eslint.config.js`) owns semantics and auto-fixes -- `curly`,
  `no-var`, `prefer-const`, `no-unused-vars`. It does not format: the
  `eslint-config-prettier` entry switches off every stylistic rule, so the two
  tools never fight.
- **`.editorconfig`** sets the baseline for every editor -- indent, charset,
  line endings, final newline. Prettier reads it natively, inheriting
  `indent_size` and `end_of_line`.

The goal is identical output from every editor, matching what CI enforces via
`pnpm lint`. You can always reproduce the canonical result from the command
line:

```bash
pnpm fix    # eslint --fix, then prettier --write
pnpm lint   # what CI runs
```

### VS Code

Committed settings live in `.vscode/`. On first open, accept the prompt to
install the recommended extensions (`.vscode/extensions.json`):

- Prettier -- `esbenp.prettier-vscode`
- ESLint -- `dbaeumer.vscode-eslint`
- EditorConfig -- `editorconfig.editorconfig` (VS Code does not read
  `.editorconfig` without it)

`.vscode/settings.json` then formats with Prettier and applies ESLint fixes on
save. No further configuration is needed.

### WebStorm / IntelliJ

WebStorm reads `.editorconfig` natively. Point its save actions at the same two
tools -- not the built-in "Reformat Code":

- **Settings ▸ Languages & Frameworks ▸ Prettier** -- "Automatic Prettier
  configuration", check **Run on save**.
- **Settings ▸ Languages & Frameworks ▸ JavaScript ▸ Code Quality Tools ▸
  ESLint** -- "Automatic ESLint configuration".
- **Settings ▸ Tools ▸ Actions on Save** -- enable **Run eslint --fix**, and
  turn **off** "Reformat code" so the IDE formatter does not override Prettier.
