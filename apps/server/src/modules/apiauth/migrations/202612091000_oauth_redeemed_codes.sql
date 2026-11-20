-- An authorization code is single use, and its row is deleted when it is exchanged. This keeps what
-- the exchange needs to recognise the same code shown again, until the code would have expired
-- anyway: within a short window an app that never got its response may repeat the request (and gets
-- a fresh pair); later, or after the app already used what it was given, a repeat means someone
-- else holds the code and the consent ends (RFC 6749 §4.1.2, OAuth security BCP).
CREATE TABLE oauth_redeemed_codes (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  scopes text NOT NULL,
  resource text NOT NULL,
  code_challenge text NOT NULL,
  issued_via text NOT NULL,
  redeemed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX oauth_redeemed_codes_expiry ON oauth_redeemed_codes (expires_at);
