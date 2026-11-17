# LLM Safety

On main `5cf7951`, Settle has one active LLM use: the private chat assistant in `src/lib/assistant.ts`. Claude reads a person's messages and returns a reply and preference updates. Code chooses the final plan.

## The lethal trifecta

- Untrusted input: yes. Users can type anything into their chat.
- Sensitive data: their own recent chat and preferences. No other member's records or application secrets.
- External communication: replies go back to the same authenticated user. The model has no tool for sending them to other members or an arbitrary destination.

The assistant sees private information, but it cannot read another person's data or send its free-text answer to the group. For example, asking for Jimmy's budget cannot retrieve it: Jimmy's record is not in the request and there is no retrieval tool.

## How the code enforces this

- `sendMessageAction` takes the user ID from the session, not from the submitted message. `events.ts` checks membership and reads chat and preferences for that user and plan.
- Claude receives up to 20 recent messages, that person's recorded preferences, and our instructions. Restaurant search results, other members' records, and account credentials are not added to the prompt. A user can still put personal details into their own message.
- The only tool is `record_preferences`. It returns data for the server to check; it grants no database, browsing, or messaging access. Code matches restaurant names. Starting-location text can go through a fixed Google geocoding request, whose endpoint the model cannot choose.
- `assistant.ts` checks updates block by block with Zod. Invalid blocks are dropped and the user is told. Code maps food terms and times to supported values before saving.
- `PrivateChat.tsx` renders replies as plain text. The public plan contains selected restaurants, times, alternatives, and limited counts. The strict optimizer result schema has no field for model-written explanations, chat text, or private notes.
- Input is capped at 500 characters; model reply text at 400, before server-written notices. Rate and spending checks limit calls. After eight assistant turns, code filters sentences ending in question marks and adds a closing message.

The model supplies `onTopic`. If false, code discards the update and replaces the reply with a fixed redirect. Correct classification still depends on Claude; the data boundaries above do not. The rule-based fallback has no LLM or general-purpose tools.

Model-generated preferences can affect the group's choice, which is their intended purpose. Free-text notes are not evaluated as instructions by the optimizer or copied into the group result.

## The old negotiation engine

The previous engine used LLMs for individual agents, proposal selection, and a final explanation. After #138, the app's planning flow calls the optimizer instead. The old LLM files remain pending #130, but the current result flow does not call them.

Repeated plans or extra accounts can still help someone infer others' preferences (#117 and #118). The chat's access controls do not solve those outcome-based risks.
