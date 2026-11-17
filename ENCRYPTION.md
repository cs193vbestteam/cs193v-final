The Algorithm we are using is AES-256-GCM, whcih is a Node’s built-in crypto.

Keys:
1. master secret, encryption_key which is stored in vercel environment, different per tier. 
2. Each field’s key derives from the master with HKDF-SHA256, making each field’s encrypted with a label name. for example, for Per user, per field:  “user/<id>/email”, “user/<id>/display_name”

This design helps avoid decryption of other user’s data. Bug or prompt injection would only lead to an error instead of a leak. In fact, prompt injection will not cause the server to load another user’s data, because reading data is determined by the code, and if a bug causes the load of wrong row, it will fail to decrypt instead of leaking.

what we encrypt: user email, display name; user’s constraints and private chat; title of the plans, location, date, restaurant pool, where the restaurant search was made from (pool_meta), and the result

what we don’t encrypt: ids, invite codes, timestamps (including when someone was done and when they last changed an answer), the ready mark, the scenario type, the member cap of each plan, and the spending records (llm_spend: user id, month, amount)

encryption in transit:
1. the flow of user data: browser → server → browser over HTTPS (Vercel), users never connect to each other direclty. Only the server talks to Neon under encryption.
2. Neon encrypts its disks, and on top of that we encrypt each field before it reaches Neon

Related protections (hashing):
1. passwords are bcrypt, they are salted and cost 12
2. login cookies use SHA-256, so they are hashed. Can’t be used to log in even when database is stolen. 
3. email lookup: using HMAC blind index, hash mixed with a secret key