## 1. Prompt Text Update

- [ ] 1.1 Add `const ORCHESTRATION_TOOLS` array in `prompt-inject.ts` with four lines: `subagent_status` (backoff wording), `subagent_interrupt`, `subagents_list`, `send_messages`
- [ ] 1.2 In the delegate-ON branch (Rules), replace the `subagent_status` rate-limit line with a spread of `ORCHESTRATION_TOOLS`
- [ ] 1.3 In the delegate-OFF branch (Guidance), replace the `subagent_status` rate-limit line with a spread of `ORCHESTRATION_TOOLS`

## 2. Test

- [ ] 2.1 Extend `createMockExtensionApi()` in test/test.ts to capture `before_agent_start` callbacks via a handlers map
- [ ] 2.2 Add test: `registerPromptInject` injects a section containing `subagent_status`, `subagent_interrupt`, `subagents_list`, `send_messages`
- [ ] 2.3 Add test: injected section re-injects (replaces existing markers) on second call

## 3. Validate

- [ ] 3.1 Run `openspec status --change "orchestration-tools-nudge" --json` and confirm `isComplete: true`
