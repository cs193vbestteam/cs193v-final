# AI Consent

Settle uses Anthropic's Claude API to read private meal-planning chats. We use the standard API without a zero-data-retention agreement. Code chooses the final restaurant and time. 

## Anthropic's policies

We reviewed the following official pages on November 17:

- API inputs and outputs are not used for training by default. Explicit feedback or opting in can allow training use. Settle has no feedback-sharing feature. [Training policy](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training)
- The commercial policy says API inputs and outputs are deleted within 30 days, with exceptions including policy enforcement and legal requirements. Flagged content can be kept for up to two years; safety classification scores for up to seven years. [Retention policy](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)
- The API documentation uses different wording: conversation content is not retained by default, except for certain models. For our standard API setup, we do not promise immediate deletion or zero retention. [API data handling](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)

## What we send

Claude receives up to 20 recent messages, the person's recorded meal preferences, and our assistant instructions. This can include budget, availability, diet, allergy notes, and named restaurants.

We do not add account names, emails, account IDs, invite codes, or other members' records. Personal details typed into the chat can still be sent. Stored starting-point coordinates are not added to the prompt.

Code can separately send starting-location text to Google Places for geocoding. This is not another AI call.

## How we tell users

Before the user types, the assistant's opening message explains that their group sees the result rather than the chat. It also says: “This chat is processed by Anthropic's Claude.” The chat header says “hidden from your group.”

We put this explanation where users enter information instead of behind a checkbox. It identifies the provider and explains the group-facing boundary. It does not mean the server or Anthropic cannot process their messages.

A notice under the message box also explains training and retention (added in #111). It reads:

Your messages and meal preferences are sent to Anthropic's Claude. Anthropic does not use API chats for training by default. Its standard retention policy is up to 30 days, with longer retention for flagged content or legal requirements. Your group sees the plan, not your chat.

It ends with a link, “How your data is used”, to a privacy page (`/privacy`) that links to the three policies above. Users cannot currently choose a non-AI mode; automatic fallback after an error or spending limit is not an opt-out.

Settle's own storage is separate: chats and preferences are encrypted in our database, and the server can decrypt them. Users can delete their account, leave a plan, or delete a plan they created. Records do not currently expire automatically.
