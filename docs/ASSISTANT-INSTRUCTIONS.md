# Optional calling-assistant instructions

Add this block to your assistant's instructions in any compatible MCP host.
It applies to OP Adversarial Pressure MCP with either model-provider
configuration. The host must make the connection available to the assistant.

```text
For OP Adversarial Pressure MCP: When a task reaches a consequential decision, major pivot, or fragile assumption that could affect its outcome, consider whether one bounded adversarial check would help. If useful, follow the server instructions, read the tool descriptions, select one appropriate tool, and make one call with a self-contained packet that meets its rules. Triage each complete tool-defined unit as usable, usable_with_limits, or unusable. Follow the server's handling rules for each classification and state the limits of retained units. Briefly report what you used or discarded. Do not invent facts, split or repair a rejected unit, automatically retry, or cascade to another tool. Leave decisions to the user.
```

Use your host's assistant instructions or equivalent setting. If the host
offers global and project-specific scopes, choose the scope where you want
this guidance to apply. The block names this MCP so it can sit beside other
instructions.

The server and selected tool define the complete handling rules. This block
helps the assistant identify useful moments for a check; it does not require a
check for every answer or guarantee that a host will invoke the server.
