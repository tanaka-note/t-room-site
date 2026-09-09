-- Display-only, repeatable correction. Do not update audit originals, role,
-- status, folder labels/paths, link targets, author names or activity timestamps.
UPDATE security_identities SET display_name = '田中宏知（オーナー）'
WHERE id = 'primary-admin'
  AND display_name IN ('第一管理者', '田中宏知', '田中宏知（管理者）');

UPDATE security_identities SET display_name = '田中宏知（一般ユーザー）'
WHERE id = '2545327a-96e6-4b38-ad24-a8fe85de292a'
  AND display_name = '田中宏知一般'
  AND EXISTS (SELECT 1 FROM security_service_links
    WHERE identity_id = security_identities.id AND service = 'diary'
      AND service_account_id = 'main-user');

UPDATE security_service_links SET display_label = '田中宏知（オーナー）'
WHERE identity_id = 'primary-admin' AND cloud_root_folder_id IS NULL AND (
  (service = 'cloud' AND service_account_id = 'admin'
    AND display_label IN ('T-Cloud 管理者', '田中宏知（管理者）')) OR
  (service = 'diary' AND service_account_id = 'main-admin'
    AND display_label IN ('日記 管理者', '田中宏知（管理者）', '田中宏知（管理者・全体管理）')) OR
  (service = 'billing' AND service_account_id = 'owner'
    AND display_label IN ('請求書 owner', '田中宏知（管理者）')) OR
  (service = 'ai' AND service_account_id = 'owner' AND display_label = 'AI Chat By T-lain') OR
  (service = 'downloader' AND service_account_id = 'owner' AND display_label = 'T-lain Downloader 管理者')
);
