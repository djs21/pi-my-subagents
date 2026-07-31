## 1. Config (status.ts)

- [ ] 1.1 Add `minIntervalMs` field to StatusConfig interface (default 30_000)
- [ ] 1.2 Add `minIntervalMs` to parseStatusConfig with env override `PI_SUBAGENT_STATUS_MIN_INTERVAL_MS`
- [ ] 1.3 Add `minIntervalMs` to allowed keys in rejectUnsupportedKeys
- [ ] 1.4 Add min bound validation: reject `minIntervalMs` < 1000 in parseStatusConfig

## 2. Throttle Gate (shared.ts, index.ts, spin.ts)

- [ ] 2.1 Add `lastStatusCheckAt` module-level timestamp in shared.ts
- [ ] 2.2 Export `resetStatusCheckThrottle()` function from shared.ts
- [ ] 2.3 Add throttle check at top of `subagent_status` execute handler in index.ts (import from shared.ts)
- [ ] 2.4 Call `resetStatusCheckThrottle()` in `launchSubagent` in spin.ts (import from shared.ts)
- [ ] 2.5 Update tool description in index.ts to state rate limit (30s)
- [ ] 2.6 Update promptSnippet in index.ts to mention rate limit

## 3. Prompt Text (prompt-inject.ts)

- [ ] 3.1 Add rate-limit notice to orchestrator section: "subagent_status is rate-limited (30s). Status auto-delivered via steers."

## 4. Config Example & Tests

- [ ] 4.1 Add `"minIntervalMs": 30000` under status in config.json.example
- [ ] 4.1b Update existing parseStatusConfig tests at test/test.ts:512-527 to account for `minIntervalMs` in the allowed keys list and return shape
- [ ] 4.2 Add unit test: call within interval → throttled response
- [ ] 4.3 Add unit test: call after interval → full data
- [ ] 4.4 Add unit test: parseStatusConfig accepts minIntervalMs
