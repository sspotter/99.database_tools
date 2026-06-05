ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_renewed_at TIMESTAMP;
