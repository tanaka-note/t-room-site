UPDATE diary_accounts
SET login_id = 'giantz3031@gmail.com',
    password_hash = NULL,
    must_change_password = 1,
    session_version = session_version + 1,
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'chiharu-admin'
  AND active = 1;
