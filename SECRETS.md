project requires four secretes, all of them are stored in vercel environment variables as secrete so no one can ever access them once entered (production and preview keys are different and stored in vercel env, dev keys are stored in .env.local):

1. Claude API: backup stored in my notes on mac
2. Encryption key: the encryption key for database, also backup stored in my notes on mac
3. database key: backup stored in Neon
4. google_places_api: backupstored by mark on his end

plan for rotate:
1. Except the encryption key, for all other keys, if leaked, firstly generate a new one. Put the new key in vercel, deploy and see if it works. If it does, old keys will be revoked.
2. for encryption key, generate a new one. Then we need to firstly decrypt row by row of the existing dataand writes them back to the database encrypted with new key. Put the new key in vercel, redeploy and check that old datas still opens. Then delete the old keys.
