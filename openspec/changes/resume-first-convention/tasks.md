## 1. Prompt Text

- [ ] 1.1 Add the "Resume-First Convention" section text (after `ORCHESTRATION_TOOLS` in `prompt-inject.ts`): default to `subagent_resume(sessionPath, agent, message)` when a sub-agent finishes with a session path; fresh spawn only for first agent / unrelated task / parallel agents
- [ ] 1.2 Document the typical chain (scout → worker → reviewer → worker) resuming each prior session
- [ ] 1.3 Add the convention to both the delegate-ON (Rules) and delegate-OFF (Guidance) arrays in `formatAgentSection`

## 2. Test

- [ ] 2.1 In `test/test.ts`, add a test capturing `before_agent_start` via `createMockExtensionApi` and asserting the injected prompt contains the resume guidance (e.g. `subagent_resume`, `Resume-First`)

## 3. Validate

- [ ] 3.1 Run `npm test` — expect 166+ pass, 0 fail
- [ ] 3.2 Run `openspec status --change "resume-first-convention" --json` and confirm `isComplete: true`
