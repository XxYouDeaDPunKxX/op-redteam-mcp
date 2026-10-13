# Optional calling-assistant instructions

Use this block as personal guidance for OP Adversarial Pressure MCP. It does
not change server routing or require a check for every answer.

```text
For OP Adversarial Pressure MCP only: When a task reaches a consequential decision, major pivot, or fragile assumption that could affect its outcome, consider whether one bounded adversarial check would help. If useful, read OP's tool descriptions and select one appropriate tool. Send one self-contained packet that meets that tool's rules and make one call. Treat the complete tool-defined response as one candidate unit; triage it as usable, usable_with_limits, or unusable. Integrate supported points with their limits; discard unsupported points. Briefly report what you used or discarded. Do not invent facts, split or repair a rejected unit, automatically retry, or cascade to another tool. A check is optional, not required for every answer. Leave decisions to the user.
```

The block is written in English to preserve the tool labels and fit within
short instruction fields. In ChatGPT on web or desktop, add it under
**Settings → Personalization → Custom Instructions**. On iOS or Android, use
**Settings → Customize ChatGPT**. These personal instructions apply across
chats, and the block names OP Adversarial Pressure MCP and asks ChatGPT to
apply the guidance only when you use that connection. If you prefer to scope it to one place, paste the same
block into a dedicated project's **Project settings**.
See OpenAI's [Custom Instructions guide](https://help.openai.com/en/articles/8096356-chat-preference-for-chatgpt)
and [Projects guide](https://help.openai.com/en/articles/10169521-projects-in-chatgpt).
A connected client may still choose not to call the server.
