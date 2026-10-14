# Third-party notices

OP_Adversarial_Pressure/Bounded_Tests/Targeted_Challenges is licensed under MIT; see [LICENSE](LICENSE).
The package-lock records these license identifiers for the direct runtime
dependencies:

| Package | Version | License identifier |
| --- | ---: | --- |
| `@cloudflare/workers-oauth-provider` | 0.8.0 | MIT |
| `@modelcontextprotocol/sdk` | 1.32.1 | MIT |
| `@openai-oauth/core` | 2.0.0 | Apache-2.0 |
| `agents` | 0.17.3 | MIT |
| `ajv` | 8.20.0 | MIT |
| `ajv-formats` | 3.0.1 | MIT |
| `json-canonicalize` | 2.0.0 | MIT |
| `zod` | 4.4.3 | MIT |

Consult each package's license and notice files when redistributing it.

## `@openai-oauth/core` 2.0.0

The optional account transport uses `@openai-oauth/core` 2.0.0 from
[EvanZhouDev/openai-oauth](https://github.com/EvanZhouDev/openai-oauth),
licensed under Apache License 2.0. The package's original license text and
NOTICE are preserved in
[`third-party-licenses/openai-oauth-core/`](third-party-licenses/openai-oauth-core/).
The NOTICE identifies OpenAI OAuth, copyright 2026 Evan Zhou and OpenAI OAuth
contributors.

## Protocol research reference

The account transport was informed by protocol research at
[`lordmacu/chatgpt-proxy`, revision `d008ef6d006532766f44ff107b104172936bd17c`](https://github.com/lordmacu/chatgpt-proxy/tree/d008ef6d006532766f44ff107b104172936bd17c).
That pinned repository state exposed no LICENSE or NOTICE file, so this
reference does not assign it a license or imply permission to redistribute its
code. The transport in this project was implemented independently from
protocol observations and project-owned fixtures; no proxy code is included.
