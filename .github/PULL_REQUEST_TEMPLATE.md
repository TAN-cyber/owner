## ✨ Summary

<!-- What changed, and why? Link related issues when available. -->

## 🎯 Scope

<!-- Check all areas touched by this PR. -->

- [ ] CLI commands (`init`, `status`, `doctor`, `update`)
- [ ] Core installer / platform detection
- [ ] Owner skills (`assets/skills/`, `assets/skills-zh/`)
- [ ] Owner shell scripts (`assets/skills/owner/scripts/`)
- [ ] Tests / CI
- [ ] Documentation / changelog
- [ ] Other:

## 🧪 Testing

<!-- List the commands you ran and summarize the result. -->

- [ ] `pnpm build`
- [ ] `pnpm lint`
- [ ] `pnpm run lint:architecture`
- [ ] `pnpm format:check`
- [ ] `pnpm test`
- [ ] `pnpm test -- test/domains/owner-pipeline/owner-scripts.test.ts`
- [ ] Not run:

## ✅ Checklist

- [ ] PR title follows Conventional Commits, for example `fix: handle project-scope init`
- [ ] User-facing behavior is documented in `README.md`, `README-zh.md`, or `CONTRIBUTING.md`
- [ ] `CHANGELOG.md` is updated when behavior changes
- [ ] Skill changes were made in Chinese first when applicable, then synced to English
- [ ] New scripts are included in `assets/manifest.json` and relevant tests
- [ ] Shell scripts remain portable across macOS, Linux, and Windows Git Bash
- [ ] No unrelated generated files or local artifacts are included

## 👀 Notes for Reviewers

<!-- Anything reviewers should pay special attention to? -->
