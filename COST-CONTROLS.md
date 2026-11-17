Three APIs we are paying for:
1. Claude api
2. Google Places: a geocode and nearby searches
3. Neon: for storage and compute

Limits:
Whole app:
1. 10 dollars for the whole app per month to avoid over cost.

Claude:
1. chat limitation: 30 messages per person per 10 mins, messages limited to 500 characters, replies at 400 characters, 512 tokens output per chat call
2. 300 chat calls per plan per day, everyone's chat is accumulated
3. each person is given 1 dollar per month for Claude, reset every calendar month. 1 dollar is about a thousand messages. It is 1/10 of the app total, so one person can't use up everyone's month.
4. Finding the plan is done by the optimizer in code, hard-coded,  so it calls no model and costs nothing. The app reuses rule-based code when a cap is hit.

Google places:
1. each plan makes 1 geocode and 1 general nearby search call when it is created. Then once everyone finishes submitting their requirements, 7 more searches max per plan. 20 places each, so 160 places max. 

Accounts and logins (Neon):
1. 10 new accounts per IP per hour, 10 login attempts for each email, 50 for each IP per 15 minutes

Plan limits:
1. each person can only create 10 plans a day
2. each plan can be decided at most 6 times a day, and only after someone changes an answer. This doesn't cost model calls, but it limits re-runs
3. each plan has a member cap set by the creator 12cap.