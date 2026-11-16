{\rtf1\ansi\ansicpg1252\cocoartf2867
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fswiss\fcharset0 Helvetica;}
{\colortbl;\red255\green255\blue255;}
{\*\expandedcolortbl;;}
\margl1440\margr1440\vieww11520\viewh8400\viewkind0
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0

\f0\fs24 \cf0 The Algorithm we are using is AES-256-GCM, whcih is a Node\'92s built-in crypto.\
\
Keys:\
1. master secret, encryption_key which is stored in vercel environment, different per tier. \
2. Each field\'92s key derives from the master with HKDF-SHA256, making each field\'92s encrypted with a label name. for example, for Per user, per field:  \'93user/<id>/email\'94, \'93user/<id>/display_name\'94\
\
This design helps avoid decryption of other user\'92s data. Bug or prompt injection would only lead to an error instead of a leak. In fact, prompt injection will not cause the server to load another user\'92s data, because reading data is determined by the code, and if a bug causes the load of wrong row, it will fail to decrypt instead of leaking.\
\
what we encrypt: user email, display name; user\'92s constraints and private chat; title of the plans, location, date, restaurant pool, and the result\
\
what we don\'92t encrypt: ids, invite codes, timestamps, the ready mark, the scenario type\
\
encryption in transit:\
1. the flow of user data: browser \uc0\u8594  server \u8594  browser over HTTPS (Vercel), users never connect to each other direclty. Only the server talks to Neon under encryption.\
2. Neon encrypts its disks, and on top of that we encrypt each field before it reaches Neon\
\
Related protections (hashing):\
1. passwords are bcrypt, they are salted and cost 12\
2. login cookies use SHA-256, so they are hashed. Can\'92t be used to log in even when database is stolen. \
3. email lookup: using HMAC blind index, hash mixed with a secret key}