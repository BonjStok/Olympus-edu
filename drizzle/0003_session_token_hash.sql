-- Data migration (runs once): session tokens are stored as their SHA-256 (hex), so a database dump
-- or backup cannot be used to take over sessions. Clients keep their raw tokens; the server hashes
-- the presented token (lib/server/session.ts, sessionKey). No schema change.
UPDATE sessions SET token = encode(sha256(convert_to(token, 'UTF8')), 'hex');
