// Explicit durable-data allowlist. Schema drift fails closed until reviewed.
export const SERVICES = {
  "household": {
    "label": "家計簿",
    "binding": "HOUSEHOLD_DB",
    "database": "household-db",
    "migration": "0006_independent_households.sql",
    "tables": [
      {
        "name": "household_accounts",
        "columns": [
          "id",
          "display_name",
          "role",
          "is_active",
          "session_version",
          "household_id"
        ],
        "sourceColumns": "id,display_name,role,is_active,session_version,household_id"
      },
      {
        "name": "household_state",
        "columns": [
          "id",
          "revision",
          "active_dataset"
        ],
        "sourceColumns": "id,revision,active_dataset"
      },
      {
        "name": "household_records",
        "columns": [
          "dataset_id",
          "kind",
          "id",
          "payload"
        ],
        "sourceColumns": "dataset_id,kind,id,payload"
      },
      {
        "name": "household_requests",
        "columns": [
          "request_id",
          "fingerprint",
          "response_json",
          "created_at",
          "household_id"
        ],
        "sourceColumns": "request_id,fingerprint,response_json,created_at,household_id"
      },
      {
        "name": "household_datasets",
        "columns": [
          "id",
          "created_at",
          "activated_at",
          "retired_at",
          "lease_expires_at",
          "household_id"
        ],
        "sourceColumns": "id,created_at,activated_at,retired_at,lease_expires_at,household_id"
      }
    ],
    "knownTables": [
      "household_accounts",
      "household_state",
      "household_records",
      "household_requests",
      "household_datasets"
    ]
  },
  "cloud": {
    "label": "T-Cloud",
    "binding": "CLOUD_DB",
    "database": "cloud-db",
    "migration": "0012_favorites.sql",
    "tables": [
      {
        "name": "cloud_folders",
        "columns": [
          "id",
          "parent_id",
          "name",
          "created_by",
          "created_at",
          "updated_at",
          "deleted_at",
          "crypto_version",
          "encrypted_name",
          "name_iv",
          "password_salt",
          "password_wrapped_key",
          "password_wrap_iv",
          "admin_wrapped_key",
          "parent_wrapped_key",
          "parent_wrap_iv"
        ],
        "sourceColumns": "id,parent_id,name,created_by,created_at,updated_at,deleted_at,password_hash,crypto_version,encrypted_name,name_iv,password_salt,password_wrapped_key,password_wrap_iv,admin_wrapped_key,parent_wrapped_key,parent_wrap_iv"
      },
      {
        "name": "cloud_files",
        "columns": [
          "id",
          "folder_id",
          "object_key",
          "thumbnail_key",
          "stream_uid",
          "original_name",
          "mime_type",
          "media_kind",
          "size_bytes",
          "status",
          "created_by",
          "created_at",
          "updated_at",
          "deleted_at",
          "crypto_version",
          "encrypted_metadata",
          "metadata_iv",
          "wrapped_file_key",
          "file_key_iv",
          "encrypted_size_bytes",
          "chunk_size_bytes",
          "chunk_count",
          "display_metadata_version",
          "display_name",
          "display_mime_type",
          "display_media_kind",
          "display_last_modified",
          "display_duration_seconds",
          "display_thumbnail_key"
        ],
        "sourceColumns": "id,folder_id,object_key,thumbnail_key,stream_uid,original_name,mime_type,media_kind,size_bytes,status,multipart_upload_id,created_by,created_at,updated_at,deleted_at,crypto_version,encrypted_metadata,metadata_iv,wrapped_file_key,file_key_iv,encrypted_size_bytes,chunk_size_bytes,chunk_count,display_metadata_version,display_name,display_mime_type,display_media_kind,display_last_modified,display_duration_seconds,display_thumbnail_key"
      },
      {
        "name": "cloud_crypto_config",
        "columns": [
          "id",
          "crypto_version",
          "public_key_jwk",
          "admin_private_cipher",
          "admin_private_iv",
          "recovery_private_cipher",
          "recovery_private_iv",
          "created_at",
          "updated_at"
        ],
        "sourceColumns": "id,crypto_version,public_key_jwk,admin_private_cipher,admin_private_iv,recovery_private_cipher,recovery_private_iv,created_at,updated_at"
      },
      {
        "name": "cloud_deletion_requests",
        "columns": [
          "id",
          "file_id",
          "file_name",
          "requested_by",
          "status",
          "requested_at",
          "approved_at",
          "approved_by"
        ],
        "sourceColumns": "id,file_id,file_name,requested_by,status,requested_at,approved_at,approved_by"
      },
      {
        "name": "cloud_favorite_files",
        "columns": [
          "owner_id",
          "file_id",
          "created_at"
        ],
        "sourceColumns": "owner_id,file_id,created_at"
      },
      {
        "name": "cloud_favorite_folders",
        "columns": [
          "owner_id",
          "folder_id",
          "created_at"
        ],
        "sourceColumns": "owner_id,folder_id,created_at"
      },
      {
        "name": "cloud_audit_logs",
        "columns": [
          "id",
          "event_type",
          "actor_role",
          "target_type",
          "target_id",
          "details_json",
          "occurred_at"
        ],
        "sourceColumns": "id,event_type,actor_role,target_type,target_id,details_json,occurred_at"
      },
      {
        "name": "cloud_security_events",
        "columns": [
          "id",
          "event_type",
          "actor_role",
          "details_json",
          "occurred_at"
        ],
        "sourceColumns": "id,event_type,actor_role,details_json,occurred_at"
      }
    ],
    "knownTables": [
      "cloud_folders",
      "cloud_files",
      "cloud_audit_logs",
      "cloud_login_attempts",
      "cloud_folder_unlocks",
      "cloud_deletion_requests",
      "cloud_crypto_config",
      "cloud_security_events",
      "cloud_shares",
      "cloud_share_attempts",
      "cloud_share_events",
      "cloud_share_files",
      "cloud_usage_summary",
      "cloud_share_folders",
      "cloud_favorite_files",
      "cloud_favorite_folders"
    ]
  },
  "security": {
    "label": "Security Center",
    "binding": "SECURITY_DB",
    "database": "security-db",
    "migration": "0028_independent_household_accounts.sql",
    "tables": [
      {
        "name": "security_identities",
        "columns": [
          "id",
          "display_name",
          "status",
          "is_security_admin",
          "last_login_at",
          "created_at",
          "updated_at",
          "last_seen_at"
        ],
        "sourceColumns": "id,display_name,status,is_security_admin,last_login_at,created_at,updated_at,last_seen_at"
      },
      {
        "name": "security_invitations",
        "columns": [
          "id",
          "identity_id",
          "token_hash",
          "link_set_hash",
          "expires_at",
          "status",
          "created_by_identity_id",
          "created_at",
          "used_at",
          "revoked_at"
        ],
        "sourceColumns": "id,identity_id,token_hash,link_set_hash,expires_at,status,created_by_identity_id,created_at,used_at,revoked_at"
      },
      {
        "name": "security_credentials",
        "columns": [
          "credential_id",
          "identity_id",
          "public_key",
          "counter",
          "transports_json",
          "device_type",
          "backed_up",
          "prf_enabled",
          "prf_salt",
          "status",
          "label",
          "registered_at",
          "approved_at",
          "last_used_at",
          "revoked_at",
          "registered_via_invitation_id"
        ],
        "sourceColumns": "credential_id,identity_id,public_key,counter,transports_json,device_type,backed_up,prf_enabled,prf_salt,status,label,registered_at,approved_at,last_used_at,revoked_at,registered_via_invitation_id"
      },
      {
        "name": "security_service_links",
        "columns": [
          "id",
          "identity_id",
          "service",
          "service_account_id",
          "cloud_root_folder_id",
          "display_label",
          "status",
          "created_at",
          "updated_at"
        ],
        "sourceColumns": "id,identity_id,service,service_account_id,cloud_root_folder_id,display_label,status,created_at,updated_at"
      },
      {
        "name": "security_tcloud_client_vaults",
        "columns": [
          "credential_id",
          "identity_id",
          "public_key_jwk",
          "public_key_fingerprint",
          "encrypted_payload",
          "payload_iv",
          "created_at",
          "updated_at"
        ],
        "sourceColumns": "credential_id,identity_id,public_key_jwk,public_key_fingerprint,encrypted_payload,payload_iv,created_at,updated_at"
      },
      {
        "name": "security_tcloud_key_envelopes",
        "columns": [
          "id",
          "identity_id",
          "credential_id",
          "service_link_id",
          "envelope_type",
          "public_key_jwk",
          "encrypted_payload",
          "payload_iv",
          "wrapped_key",
          "created_at",
          "updated_at"
        ],
        "sourceColumns": "id,identity_id,credential_id,service_link_id,envelope_type,public_key_jwk,encrypted_payload,payload_iv,wrapped_key,created_at,updated_at"
      },
      {
        "name": "security_health_members",
        "columns": [
          "slot",
          "identity_id"
        ],
        "sourceColumns": "slot,identity_id"
      },
      {
        "name": "security_health_config",
        "columns": [
          "account_id",
          "recovery_wrapped_key",
          "recovery_public_key"
        ],
        "sourceColumns": "account_id,recovery_wrapped_key,recovery_public_key"
      },
      {
        "name": "security_health_vaults",
        "columns": [
          "credential_id",
          "identity_id",
          "public_key_json",
          "iv",
          "ciphertext"
        ],
        "sourceColumns": "credential_id,identity_id,public_key_json,iv,ciphertext"
      },
      {
        "name": "security_health_grants",
        "columns": [
          "identity_id",
          "credential_id",
          "service_link_id",
          "wrapped_key"
        ],
        "sourceColumns": "identity_id,credential_id,service_link_id,wrapped_key"
      },
      {
        "name": "security_ai_budget_policies",
        "columns": [
          "identity_id",
          "monthly_budget_jpy",
          "soft_stop_jpy",
          "hard_stop_jpy",
          "reserve_enabled",
          "reserve_period",
          "created_at",
          "updated_at"
        ],
        "sourceColumns": "identity_id,monthly_budget_jpy,soft_stop_jpy,hard_stop_jpy,reserve_enabled,reserve_period,created_at,updated_at"
      },
      {
        "name": "security_audit_events",
        "columns": [
          "event_id",
          "occurred_at",
          "received_at",
          "service",
          "event_type",
          "outcome",
          "identity_id",
          "service_account_id",
          "role",
          "auth_method",
          "session_id_hash",
          "source_hash",
          "user_agent",
          "target_type",
          "target_id",
          "details_json",
          "service_link_id",
          "service_account_label"
        ],
        "sourceColumns": "event_id,occurred_at,received_at,service,event_type,outcome,identity_id,service_account_id,role,auth_method,session_id_hash,source_hash,user_agent,target_type,target_id,details_json,service_link_id,service_account_label"
      }
    ],
    "knownTables": [
      "security_identities",
      "security_invitations",
      "security_credentials",
      "security_challenges",
      "security_tcloud_client_vaults",
      "security_setup_sessions",
      "security_runtime_state",
      "security_ai_budget_policies",
      "security_definition_updates",
      "security_definition_events",
      "security_audit_daily",
      "security_health_members",
      "security_health_config",
      "security_health_vaults",
      "security_service_links",
      "security_handoffs",
      "security_tcloud_key_envelopes",
      "security_health_grants",
      "security_audit_events",
      "security_active_sessions"
    ]
  },
  "billing": {
    "label": "請求書管理",
    "binding": "BILLING_DB",
    "database": "billing-db",
    "migration": "0008_password_auth_policy.sql",
    "tables": [
      {
        "name": "billing_accounts",
        "columns": [
          "id",
          "login_id",
          "display_name",
          "role",
          "session_version",
          "is_active",
          "created_at",
          "updated_at"
        ],
        "sourceColumns": "id,login_id,display_name,role,password_salt,password_hash,password_iterations,session_version,is_active,created_at,updated_at,failed_login_attempts,locked_until,password_pepper_version"
      },
      {
        "name": "billing_opening_balances",
        "columns": [
          "account_id",
          "effective_date",
          "balance_yen",
          "updated_by",
          "updated_at"
        ],
        "sourceColumns": "account_id,effective_date,balance_yen,updated_by,updated_at"
      },
      {
        "name": "billing_entries",
        "columns": [
          "id",
          "account_id",
          "document_type",
          "entry_date",
          "category",
          "amount_yen",
          "description",
          "note",
          "created_by",
          "created_at",
          "updated_at",
          "deleted_at"
        ],
        "sourceColumns": "id,account_id,document_type,entry_date,category,amount_yen,description,note,created_by,created_at,updated_at,deleted_at"
      },
      {
        "name": "billing_settlements",
        "columns": [
          "id",
          "account_id",
          "settlement_date",
          "direction",
          "method",
          "amount_yen",
          "note",
          "created_by",
          "legacy_entry_id",
          "created_at",
          "updated_at",
          "deleted_at"
        ],
        "sourceColumns": "id,account_id,settlement_date,direction,method,amount_yen,note,created_by,legacy_entry_id,created_at,updated_at,deleted_at"
      },
      {
        "name": "billing_audit_logs",
        "columns": [
          "id",
          "event_type",
          "actor_account_id",
          "target_account_id",
          "entry_id",
          "attempted_login_id",
          "details_json",
          "occurred_at"
        ],
        "sourceColumns": "id,event_type,actor_account_id,target_account_id,entry_id,attempted_login_id,details_json,occurred_at"
      },
      {
        "name": "password_auth_policy",
        "columns": [
          "service",
          "account_id",
          "password_auth_enabled",
          "password_session_epoch",
          "changed_by",
          "reason",
          "updated_at"
        ],
        "sourceColumns": "service,account_id,password_auth_enabled,password_session_epoch,changed_by,reason,updated_at"
      },
      {
        "name": "password_auth_policy_audit",
        "columns": [
          "id",
          "service",
          "account_id",
          "event_type",
          "password_session_epoch",
          "changed_by",
          "reason",
          "occurred_at"
        ],
        "sourceColumns": "id,service,account_id,event_type,password_session_epoch,changed_by,reason,occurred_at"
      }
    ],
    "knownTables": [
      "billing_accounts",
      "billing_opening_balances",
      "billing_audit_logs",
      "billing_entries",
      "billing_settlements",
      "billing_login_attempts",
      "password_auth_policy",
      "password_auth_policy_audit"
    ]
  },
  "payments": {
    "label": "支払明細",
    "binding": "PAYMENTS_DB",
    "database": "payments-db",
    "migration": "0002_monthly_ledger.sql",
    "tables": [
      {
        "name": "payments_accounts",
        "columns": [
          "id",
          "display_name",
          "is_active",
          "session_version"
        ],
        "sourceColumns": "id,display_name,is_active,session_version"
      },
      {
        "name": "payments_entries",
        "columns": [
          "id",
          "account_id",
          "paid_on",
          "payee",
          "description",
          "amount",
          "start_month",
          "months",
          "notes",
          "version",
          "created_at",
          "updated_at",
          "deleted_at"
        ],
        "sourceColumns": "id,account_id,paid_on,payee,description,amount,start_month,months,notes,version,created_at,updated_at,deleted_at"
      },
      {
        "name": "payments_monthly_marks",
        "columns": [
          "entry_id",
          "target_month",
          "amount",
          "completed_at"
        ],
        "sourceColumns": "entry_id,target_month,amount,completed_at"
      },
      {
        "name": "payments_operation_audit",
        "columns": [
          "request_id",
          "entry_id",
          "target_month",
          "action",
          "occurred_at",
          "identity_id",
          "account_id",
          "entry_version",
          "amount",
          "previous_amount",
          "start_month",
          "previous_start_month",
          "months",
          "previous_months"
        ],
        "sourceColumns": "request_id,entry_id,target_month,action,occurred_at,identity_id,account_id,entry_version,amount,previous_amount,start_month,previous_start_month,months,previous_months"
      },
      {
        "name": "payments_requests",
        "columns": [
          "request_id",
          "fingerprint",
          "response_json",
          "created_at"
        ],
        "sourceColumns": "request_id,fingerprint,response_json,created_at"
      }
    ],
    "knownTables": [
      "payments_accounts",
      "payments_entries",
      "payments_requests",
      "payments_monthly_marks",
      "payments_operation_audit"
    ]
  },
  "health": {
    "label": "体調管理",
    "binding": "HEALTH_DB",
    "database": "health-db",
    "migration": "0001_init.sql",
    "tables": [
      {
        "name": "health_records",
        "columns": [
          "record_id",
          "account_id",
          "iv",
          "ciphertext",
          "revision",
          "updated_at"
        ],
        "sourceColumns": "record_id,account_id,iv,ciphertext,revision,updated_at"
      }
    ],
    "knownTables": [
      "health_records"
    ]
  },
  "inventory": {
    "label": "在庫照会",
    "binding": "INVENTORY_DB",
    "database": "inventory-db",
    "migration": "0002_item_deletion.sql",
    "tables": [
      {
        "name": "inventory_accounts",
        "columns": [
          "id",
          "display_name",
          "is_active",
          "session_version"
        ],
        "sourceColumns": "id,display_name,is_active,session_version"
      },
      {
        "name": "inventory_items",
        "columns": [
          "id",
          "account_id",
          "name",
          "unit",
          "stock",
          "version",
          "created_at",
          "archived_at",
          "deleted_at"
        ],
        "sourceColumns": "id,account_id,name,unit,stock,version,created_at,archived_at,deleted_at"
      },
      {
        "name": "inventory_movements",
        "columns": [
          "id",
          "account_id",
          "item_id",
          "kind",
          "quantity_delta",
          "expected_version",
          "occurred_at",
          "created_at",
          "voided_at"
        ],
        "sourceColumns": "id,account_id,item_id,kind,quantity_delta,expected_version,occurred_at,created_at,voided_at"
      },
      {
        "name": "inventory_requests",
        "columns": [
          "account_id",
          "request_id",
          "fingerprint",
          "response_json",
          "created_at"
        ],
        "sourceColumns": "account_id,request_id,fingerprint,response_json,created_at"
      }
    ],
    "knownTables": [
      "inventory_accounts",
      "inventory_items",
      "inventory_movements",
      "inventory_requests"
    ]
  },
  "ai": {
    "label": "AI Chat",
    "binding": "AI_DB",
    "database": "ai-db",
    "migration": "0003_tlain_brand.sql",
    "tables": [
      {
        "name": "ai_accounts",
        "columns": [
          "identity_id",
          "display_name",
          "role",
          "status",
          "created_at",
          "updated_at"
        ],
        "sourceColumns": "identity_id,display_name,role,status,created_at,updated_at"
      },
      {
        "name": "ai_characters",
        "columns": [
          "id",
          "display_name",
          "persona_instructions",
          "speaking_style",
          "first_person",
          "user_address",
          "voice_engine",
          "voice_id",
          "live2d_model_id",
          "active",
          "created_at",
          "updated_at"
        ],
        "sourceColumns": "id,display_name,persona_instructions,speaking_style,first_person,user_address,voice_engine,voice_id,live2d_model_id,active,created_at,updated_at"
      },
      {
        "name": "ai_character_settings",
        "columns": [
          "identity_id",
          "character_id",
          "memory_namespace",
          "settings_json",
          "created_at",
          "updated_at"
        ],
        "sourceColumns": "identity_id,character_id,memory_namespace,settings_json,created_at,updated_at"
      },
      {
        "name": "ai_conversations",
        "columns": [
          "id",
          "identity_id",
          "character_id",
          "title",
          "current_mode",
          "status",
          "created_at",
          "updated_at"
        ],
        "sourceColumns": "id,identity_id,character_id,title,current_mode,status,created_at,updated_at"
      },
      {
        "name": "ai_messages",
        "columns": [
          "id",
          "conversation_id",
          "identity_id",
          "character_id",
          "role",
          "content",
          "content_format",
          "source_mode",
          "client_message_id",
          "model",
          "input_tokens",
          "cached_input_tokens",
          "output_tokens",
          "audio_input_tokens",
          "audio_output_tokens",
          "created_at"
        ],
        "sourceColumns": "id,conversation_id,identity_id,character_id,role,content,content_format,source_mode,client_message_id,model,input_tokens,cached_input_tokens,output_tokens,audio_input_tokens,audio_output_tokens,created_at"
      },
      {
        "name": "ai_memories",
        "columns": [
          "id",
          "identity_id",
          "character_id",
          "kind",
          "content",
          "source_conversation_id",
          "importance",
          "retrieval_key",
          "active",
          "created_at",
          "updated_at"
        ],
        "sourceColumns": "id,identity_id,character_id,kind,content,source_conversation_id,importance,retrieval_key,active,created_at,updated_at"
      },
      {
        "name": "ai_usage_events",
        "columns": [
          "request_id",
          "identity_id",
          "character_id",
          "conversation_id",
          "model",
          "input_tokens",
          "cached_input_tokens",
          "output_tokens",
          "audio_input_tokens",
          "audio_output_tokens",
          "estimated_cost_micros_jpy",
          "usage_period",
          "occurred_at"
        ],
        "sourceColumns": "request_id,identity_id,character_id,conversation_id,model,input_tokens,cached_input_tokens,output_tokens,audio_input_tokens,audio_output_tokens,estimated_cost_micros_jpy,usage_period,occurred_at"
      },
      {
        "name": "ai_budget_guards",
        "columns": [
          "identity_id",
          "usage_period",
          "spent_micros_jpy",
          "reserved_micros_jpy",
          "updated_at"
        ],
        "sourceColumns": "identity_id,usage_period,spent_micros_jpy,reserved_micros_jpy,updated_at"
      },
      {
        "name": "ai_request_claims",
        "columns": [
          "client_request_id",
          "identity_id",
          "conversation_id",
          "character_id",
          "status",
          "model",
          "reserved_micros_jpy",
          "user_message_id",
          "assistant_message_id",
          "attempt_count",
          "error_code",
          "created_at",
          "updated_at"
        ],
        "sourceColumns": "client_request_id,identity_id,conversation_id,character_id,status,model,reserved_micros_jpy,user_message_id,assistant_message_id,attempt_count,error_code,created_at,updated_at"
      }
    ],
    "knownTables": [
      "ai_accounts",
      "ai_characters",
      "ai_character_settings",
      "ai_conversations",
      "ai_messages",
      "ai_memories",
      "ai_usage_events",
      "ai_budget_guards",
      "ai_request_claims"
    ]
  },
  "downloader": {
    "label": "Downloader利用集計",
    "binding": "DOWNLOADER_DB",
    "database": "downloader-db",
    "migration": "0005_downloader_analysis_cancel.sql",
    "tables": [
      {
        "name": "downloader_usage_daily",
        "columns": [
          "day_jst",
          "identity_id",
          "metric",
          "dimension",
          "event_count",
          "byte_count",
          "value_sum",
          "value_max",
          "updated_at"
        ],
        "sourceColumns": "day_jst,identity_id,metric,dimension,event_count,byte_count,value_sum,value_max,updated_at"
      }
    ],
    "knownTables": [
      "downloader_rate_events",
      "downloader_usage_daily",
      "downloader_jobs",
      "downloader_file_delivery_attempts"
    ]
  },
  "calendar": {
    "label": "カレンダー",
    "binding": "CALENDAR_DB",
    "database": "calendar-db",
    "migration": "0001_calendar.sql",
    "tables": [
      {
        "name": "calendar_accounts",
        "columns": [
          "id",
          "display_name",
          "is_active",
          "session_version",
          "created_at"
        ],
        "sourceColumns": "id,display_name,is_active,session_version,created_at"
      },
      {
        "name": "calendar_clock",
        "columns": [
          "id",
          "value"
        ],
        "sourceColumns": "id,value"
      },
      {
        "name": "calendar_entities",
        "columns": [
          "account_id",
          "owner_identity",
          "kind",
          "id",
          "payload",
          "version",
          "purged",
          "updated_seq",
          "updated_at"
        ],
        "sourceColumns": "account_id,owner_identity,kind,id,payload,version,purged,updated_seq,updated_at"
      },
      {
        "name": "calendar_requests",
        "columns": [
          "account_id",
          "owner_identity",
          "request_id",
          "payload_hash",
          "kind",
          "entity_id",
          "response_json",
          "created_at"
        ],
        "sourceColumns": "account_id,owner_identity,request_id,payload_hash,kind,entity_id,response_json,created_at"
      }
    ],
    "knownTables": [
      "calendar_accounts",
      "calendar_clock",
      "calendar_entities",
      "calendar_requests"
    ]
  }
};
