ALTER TABLE billing_accounts ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE billing_accounts ADD COLUMN locked_until TEXT;
