INSERT INTO diary_accounts (
  id, household_id, display_name, login_id, role,
  must_change_password, can_view_trash, can_permanently_delete,
  can_view_investment, session_version, active
) VALUES (
  'main-user', 'tanaka-household', '田中宏知',
  'sub@a-tanaka.jp', 'admin',
  1, 0, 0, 1, 1, 1
);
