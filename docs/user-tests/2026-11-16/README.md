# User test: November 16, 2026

## Setup

- **When:** the evening of November 16, 2026.
- **Who:** two MSE students, both outside the project team. The first is called "the tester" below. The second joined the tester's plan through the invite link, to test the group flow, and is called "the second participant".
- **Version:** the version of Settle that was current that evening.
- **Tasks:** none. We gave the tester no tasks and no instructions; they explored the site on their own.
- **Observer:** a member of the team watched and took notes.

The tester completed the main flow without being asked to: creating a plan, entering preferences, inviting another person, and finding a restaurant recommendation. They also opened a recommended restaurant in Google Maps.

The quotes below are from the observer's notes, with Chinese responses translated into English.

## Notes, one file per feature

- [Homepage and registration](01-homepage-and-registration.md)
- [Creating a plan](02-creating-a-plan.md)
- [The private assistant](03-private-assistant.md)
- [Finishing and inviting](04-finishing-and-inviting.md)
- [The result](05-the-result.md)
- [Exit interview](06-exit-interview.md)

## Main findings

The tester liked the homepage animation, the assistant's response speed, and the working Google Maps link. The second participant liked seeing the restaurant they had asked for near the top.

The biggest difficulty was knowing what to focus on and what to do next. The chat page had too much competing text, the completion button was hard to find, and the final recommendation was not prominent enough.

The tester understood that the recommendation used both participants' preferences. Their explanation did not mention the scoring process or the priority of excluding fewer people.

Their willingness to enter an honest budget depended on believing that only the AI could see it. Their answer did not distinguish between other group members and the service processing the information.

The tester saw the website as something to use when a group chat could not reach a decision. Registration and a long conversation made it feel like extra work for simpler plans.

## Changes to prioritize

1. **Make the chat page easier to follow.** Reduce competing text and make the next action obvious. ([#152](https://github.com/cs193vbestteam/cs193v-final/issues/152))
2. **Clarify completion and waiting states.** Replace the confusing "Not done yet" presentation with clearer feedback about what has finished and what happens next. ([#153](https://github.com/cs193vbestteam/cs193v-final/issues/153))
3. **Make the result more prominent.** Give it a dedicated view or a stronger transition when it becomes available. ([#154](https://github.com/cs193vbestteam/cs193v-final/issues/154))
4. **Shorten the conversation.** Avoid repeating every answer and asking questions that have already been answered. ([#156](https://github.com/cs193vbestteam/cs193v-final/issues/156), [#157](https://github.com/cs193vbestteam/cs193v-final/issues/157), [#158](https://github.com/cs193vbestteam/cs193v-final/issues/158))
5. **Explain the participant limit.** Make it clear that "Up to" is a capacity limit. ([#155](https://github.com/cs193vbestteam/cs193v-final/issues/155))
6. **Review guest access and privacy wording.** Registration was a repeated concern, and the tester's privacy expectations need closer attention. ([#160](https://github.com/cs193vbestteam/cs193v-final/issues/160), [#159](https://github.com/cs193vbestteam/cs193v-final/issues/159))
7. **Improve the restaurant list visually.** Pictures or small icons could make the options easier to scan. ([#161](https://github.com/cs193vbestteam/cs193v-final/issues/161))
