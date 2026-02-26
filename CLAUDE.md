# Claude Code Instructions

## CrowMemory

At the start of every session, load the CrowMemory system prompt:

```
@.crow-memory-prompt-pro.md
```

Then call `get_pinned` to load critical guardrails and `recall_by_tag` with `["project:packdev"]` to restore recent context.
