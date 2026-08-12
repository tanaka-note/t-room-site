UPDATE billing_accounts
SET login_id = 'contact@a-tanaka.jp', updated_at = CURRENT_TIMESTAMP
WHERE id = 'owner' AND login_id = 'sub@a-tanaka.jp' COLLATE NOCASE;
