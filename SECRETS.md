{\rtf1\ansi\ansicpg1252\cocoartf2867
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fswiss\fcharset0 Helvetica;}
{\colortbl;\red255\green255\blue255;}
{\*\expandedcolortbl;;}
\margl1440\margr1440\vieww11520\viewh8400\viewkind0
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0

\f0\fs24 \cf0 project requires four secretes, all of them are stored in vercel environment variables as secrete so no one can ever access them once entered (production and preview keys are different and stored in vercel env, dev keys are stored in .env.local):\
\
1. Claude API: backup stored in my notes on mac\
2. Encryption key: the encryption key for database, also backup stored in my notes on mac\
3. database key: backup stored in Neon\
4. google_places_api: backupstored by mark on his end\
\
plan for rotate:\
1. Except the encryption key, for all other keys, if leaked, firstly generate a new one. Put the new key in vercel, deploy and see if it works. If it does, old keys will be revoked.\
2. for encryption key, generate a new one. Then we need to firstly decrypt row by row of the existing dataand writes them back to the database encrypted with new key. Put the new key in vercel, redeploy and check that old datas still opens. Then delete the old keys.\
}