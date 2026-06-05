INSERT INTO subscriptions (email, plan, status)
VALUES
  ('demo@example.com', 'pro', 'active'),
  ('hello@example.com', 'free', 'active')
ON CONFLICT(email) DO NOTHING;
