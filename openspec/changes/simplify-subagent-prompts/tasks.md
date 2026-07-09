## 1. Fix orchestration notice injection leak

- [ ] 1.1 Add `PI_SUBAGENT_NAME` guard to `prompt-inject.ts` — wrap the `<!-- subagent-orch-start -->` injection block so it only runs when `process.env.PI_SUBAGENT_NAME` is not set

## 2. Update worker.md to use `system-prompt: replace`

- [ ] 2.1 Change `agents/worker.md` frontmatter from `system-prompt: append` to `system-prompt: replace`
- [ ] 2.2 Embed tool definitions (`read`, `bash`, `write`, `edit`) + usage guidelines in `agents/worker.md` body
- [ ] 2.3 Remove obsolete todo-specific workflow instructions from `agents/worker.md` body (the compensation logic for `append` mode is no longer needed)

## 3. Update planner.md to use `system-prompt: replace`

- [ ] 3.1 Change `agents/planner.md` frontmatter from `system-prompt: append` to `system-prompt: replace`
- [ ] 3.2 Embed tool definitions (`read`, `bash`, `write`, `edit`, `subagent`) + usage guidelines in `agents/planner.md` body

## 4. Update scout.md to use `system-prompt: replace`

- [ ] 4.1 Change `agents/scout.md` frontmatter from `system-prompt: append` to `system-prompt: replace`
- [ ] 4.2 Embed tool definitions (`read`, `bash`, `write`, `edit`) + usage guidelines in `agents/scout.md` body

## 5. Update reviewer.md to use `system-prompt: replace`

- [ ] 5.1 Change `agents/reviewer.md` frontmatter from `system-prompt: append` to `system-prompt: replace`
- [ ] 5.2 Embed tool definitions (`read`, `bash`, `write`, `edit`) + usage guidelines in `agents/reviewer.md` body

## 6. Update visual-tester.md to use `system-prompt: replace`

- [ ] 6.1 Change `agents/visual-tester.md` frontmatter from `system-prompt: append` to `system-prompt: replace`
- [ ] 6.2 Embed tool definitions (`read`, `bash`, `write`, `edit`) + usage guidelines in `agents/visual-tester.md` body

## 7. Add --no-context-files for worker and visual-tester in spawner.ts

- [ ] 7.1 Add conditional logic in `spawner.ts` to pass `--no-context-files` flag when agent name is `worker` or `visual-tester`
- [ ] 7.2 Verify scout, planner, and reviewer still receive context files (no change needed for them)
