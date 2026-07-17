-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "auth";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "account_role_enum" AS ENUM ('owner', 'admin', 'agent', 'viewer');

-- CreateEnum
CREATE TYPE "auth"."aal_level" AS ENUM ('aal1', 'aal2', 'aal3');

-- CreateEnum
CREATE TYPE "auth"."code_challenge_method" AS ENUM ('s256', 'plain');

-- CreateEnum
CREATE TYPE "auth"."factor_status" AS ENUM ('unverified', 'verified');

-- CreateEnum
CREATE TYPE "auth"."factor_type" AS ENUM ('totp', 'webauthn', 'phone');

-- CreateEnum
CREATE TYPE "auth"."oauth_authorization_status" AS ENUM ('pending', 'approved', 'denied', 'expired');

-- CreateEnum
CREATE TYPE "auth"."oauth_client_type" AS ENUM ('public', 'confidential');

-- CreateEnum
CREATE TYPE "auth"."oauth_registration_type" AS ENUM ('dynamic', 'manual');

-- CreateEnum
CREATE TYPE "auth"."oauth_response_type" AS ENUM ('code');

-- CreateEnum
CREATE TYPE "auth"."one_time_token_type" AS ENUM ('confirmation_token', 'reauthentication_token', 'recovery_token', 'email_change_token_new', 'email_change_token_current', 'phone_change_token');

-- CreateEnum
CREATE TYPE "billing_cycle_enum" AS ENUM ('monthly', 'yearly');

-- CreateEnum
CREATE TYPE "payment_method_enum" AS ENUM ('stripe', 'razorpay', 'manual');

-- CreateEnum
CREATE TYPE "subscription_status_enum" AS ENUM ('active', 'trial', 'past_due', 'cancelled', 'expired');

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "default_currency" TEXT NOT NULL DEFAULT 'USD',

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "avatar_url" TEXT,
    "role" TEXT DEFAULT 'user',
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "beta_features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "account_id" UUID NOT NULL,
    "account_role" "account_role_enum" NOT NULL,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "created_by" UUID,
    "name" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_used_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."audit_log_entries" (
    "instance_id" UUID,
    "id" UUID NOT NULL,
    "payload" JSON,
    "created_at" TIMESTAMPTZ(6),
    "ip_address" VARCHAR(64) NOT NULL DEFAULT '',

    CONSTRAINT "audit_log_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."custom_oauth_providers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider_type" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret" TEXT NOT NULL,
    "acceptable_client_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pkce_enabled" BOOLEAN NOT NULL DEFAULT true,
    "attribute_mapping" JSONB NOT NULL DEFAULT '{}',
    "authorization_params" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "email_optional" BOOLEAN NOT NULL DEFAULT false,
    "issuer" TEXT,
    "discovery_url" TEXT,
    "skip_nonce_check" BOOLEAN NOT NULL DEFAULT false,
    "cached_discovery" JSONB,
    "discovery_cached_at" TIMESTAMPTZ(6),
    "authorization_url" TEXT,
    "token_url" TEXT,
    "userinfo_url" TEXT,
    "jwks_uri" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "custom_claims_allowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "custom_oauth_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."flow_state" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "auth_code" TEXT,
    "code_challenge_method" "auth"."code_challenge_method",
    "code_challenge" TEXT,
    "provider_type" TEXT NOT NULL,
    "provider_access_token" TEXT,
    "provider_refresh_token" TEXT,
    "created_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6),
    "authentication_method" TEXT NOT NULL,
    "auth_code_issued_at" TIMESTAMPTZ(6),
    "invite_token" TEXT,
    "referrer" TEXT,
    "oauth_client_state_id" UUID,
    "linking_target_id" UUID,
    "email_optional" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "flow_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."identities" (
    "provider_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "identity_data" JSONB NOT NULL,
    "provider" TEXT NOT NULL,
    "last_sign_in_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6),
    "email" TEXT DEFAULT lower((identity_data ->> 'email'::text)),
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),

    CONSTRAINT "identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."instances" (
    "id" UUID NOT NULL,
    "uuid" UUID,
    "raw_base_config" TEXT,
    "created_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."mfa_amr_claims" (
    "session_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "authentication_method" TEXT NOT NULL,
    "id" UUID NOT NULL,

    CONSTRAINT "amr_id_pk" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."mfa_challenges" (
    "id" UUID NOT NULL,
    "factor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "verified_at" TIMESTAMPTZ(6),
    "ip_address" INET NOT NULL,
    "otp_code" TEXT,
    "web_authn_session_data" JSONB,

    CONSTRAINT "mfa_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."mfa_factors" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "friendly_name" TEXT,
    "factor_type" "auth"."factor_type" NOT NULL,
    "status" "auth"."factor_status" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "secret" TEXT,
    "phone" TEXT,
    "last_challenged_at" TIMESTAMPTZ(6),
    "web_authn_credential" JSONB,
    "web_authn_aaguid" UUID,
    "last_webauthn_challenge_data" JSONB,

    CONSTRAINT "mfa_factors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."oauth_authorizations" (
    "id" UUID NOT NULL,
    "authorization_id" TEXT NOT NULL,
    "client_id" UUID NOT NULL,
    "user_id" UUID,
    "redirect_uri" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "state" TEXT,
    "resource" TEXT,
    "code_challenge" TEXT,
    "code_challenge_method" "auth"."code_challenge_method",
    "response_type" "auth"."oauth_response_type" NOT NULL DEFAULT 'code',
    "status" "auth"."oauth_authorization_status" NOT NULL DEFAULT 'pending',
    "authorization_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL DEFAULT (now() + '00:03:00'::interval),
    "approved_at" TIMESTAMPTZ(6),
    "nonce" TEXT,

    CONSTRAINT "oauth_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."oauth_client_states" (
    "id" UUID NOT NULL,
    "provider_type" TEXT NOT NULL,
    "code_verifier" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "oauth_client_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."oauth_clients" (
    "id" UUID NOT NULL,
    "client_secret_hash" TEXT,
    "registration_type" "auth"."oauth_registration_type" NOT NULL,
    "redirect_uris" TEXT NOT NULL,
    "grant_types" TEXT NOT NULL,
    "client_name" TEXT,
    "client_uri" TEXT,
    "logo_uri" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "client_type" "auth"."oauth_client_type" NOT NULL DEFAULT 'confidential',
    "token_endpoint_auth_method" TEXT NOT NULL,

    CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."oauth_consents" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "scopes" TEXT NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "oauth_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."one_time_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_type" "auth"."one_time_token_type" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "relates_to" TEXT NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "one_time_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."refresh_tokens" (
    "instance_id" UUID,
    "id" BIGSERIAL NOT NULL,
    "token" VARCHAR(255),
    "user_id" VARCHAR(255),
    "revoked" BOOLEAN,
    "created_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6),
    "parent" VARCHAR(255),
    "session_id" UUID,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."saml_providers" (
    "id" UUID NOT NULL,
    "sso_provider_id" UUID NOT NULL,
    "entity_id" TEXT NOT NULL,
    "metadata_xml" TEXT NOT NULL,
    "metadata_url" TEXT,
    "attribute_mapping" JSONB,
    "created_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6),
    "name_id_format" TEXT,

    CONSTRAINT "saml_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."saml_relay_states" (
    "id" UUID NOT NULL,
    "sso_provider_id" UUID NOT NULL,
    "request_id" TEXT NOT NULL,
    "for_email" TEXT,
    "redirect_to" TEXT,
    "created_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6),
    "flow_state_id" UUID,

    CONSTRAINT "saml_relay_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."schema_migrations" (
    "version" VARCHAR(255) NOT NULL,

    CONSTRAINT "schema_migrations_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "auth"."sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6),
    "factor_id" UUID,
    "aal" "auth"."aal_level",
    "not_after" TIMESTAMPTZ(6),
    "refreshed_at" TIMESTAMP(6),
    "user_agent" TEXT,
    "ip" INET,
    "tag" TEXT,
    "oauth_client_id" UUID,
    "refresh_token_hmac_key" TEXT,
    "refresh_token_counter" BIGINT,
    "scopes" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."sso_domains" (
    "id" UUID NOT NULL,
    "sso_provider_id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "sso_domains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."sso_providers" (
    "id" UUID NOT NULL,
    "resource_id" TEXT,
    "created_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6),
    "disabled" BOOLEAN,

    CONSTRAINT "sso_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."users" (
    "instance_id" UUID,
    "id" UUID NOT NULL,
    "aud" VARCHAR(255),
    "role" VARCHAR(255),
    "email" VARCHAR(255),
    "encrypted_password" VARCHAR(255),
    "email_confirmed_at" TIMESTAMPTZ(6),
    "invited_at" TIMESTAMPTZ(6),
    "confirmation_token" VARCHAR(255),
    "confirmation_sent_at" TIMESTAMPTZ(6),
    "recovery_token" VARCHAR(255),
    "recovery_sent_at" TIMESTAMPTZ(6),
    "email_change_token_new" VARCHAR(255),
    "email_change" VARCHAR(255),
    "email_change_sent_at" TIMESTAMPTZ(6),
    "last_sign_in_at" TIMESTAMPTZ(6),
    "raw_app_meta_data" JSONB,
    "raw_user_meta_data" JSONB,
    "is_super_admin" BOOLEAN,
    "created_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6),
    "phone" TEXT,
    "phone_confirmed_at" TIMESTAMPTZ(6),
    "phone_change" TEXT DEFAULT '',
    "phone_change_token" VARCHAR(255) DEFAULT '',
    "phone_change_sent_at" TIMESTAMPTZ(6),
    "confirmed_at" TIMESTAMPTZ(6) DEFAULT LEAST(email_confirmed_at, phone_confirmed_at),
    "email_change_token_current" VARCHAR(255) DEFAULT '',
    "email_change_confirm_status" SMALLINT DEFAULT 0,
    "banned_until" TIMESTAMPTZ(6),
    "reauthentication_token" VARCHAR(255) DEFAULT '',
    "reauthentication_sent_at" TIMESTAMPTZ(6),
    "is_sso_user" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMPTZ(6),
    "is_anonymous" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."webauthn_challenges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID,
    "challenge_type" TEXT NOT NULL,
    "session_data" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "webauthn_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."webauthn_credentials" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "credential_id" BYTEA NOT NULL,
    "public_key" BYTEA NOT NULL,
    "attestation_type" TEXT NOT NULL DEFAULT '',
    "aaguid" UUID,
    "sign_count" BIGINT NOT NULL DEFAULT 0,
    "transports" JSONB NOT NULL DEFAULT '[]',
    "backup_eligible" BOOLEAN NOT NULL DEFAULT false,
    "backed_up" BOOLEAN NOT NULL DEFAULT false,
    "friendly_name" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6),

    CONSTRAINT "webauthn_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_invitations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "role" "account_role_enum" NOT NULL,
    "created_by_user_id" UUID,
    "label" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "accepted_by_user_id" UUID,

    CONSTRAINT "account_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "created_by" UUID,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "api_key" TEXT NOT NULL,
    "system_prompt" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "auto_reply_enabled" BOOLEAN NOT NULL DEFAULT false,
    "auto_reply_max_per_conversation" INTEGER NOT NULL DEFAULT 3,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "embeddings_api_key" TEXT,

    CONSTRAINT "ai_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_knowledge_chunks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "chunk_index" INTEGER NOT NULL DEFAULT 0,
    "content" TEXT NOT NULL,
    "fts" tsvector DEFAULT to_tsvector('simple'::regconfig, content),
    "embedding" vector,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_knowledge_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_knowledge_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "created_by" UUID,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_knowledge_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "automation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "contact_id" UUID,
    "trigger_event" TEXT NOT NULL,
    "steps_executed" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "account_id" UUID NOT NULL,

    CONSTRAINT "automation_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_pending_executions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "automation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "contact_id" UUID,
    "log_id" UUID,
    "parent_step_id" UUID,
    "branch" TEXT,
    "next_step_position" INTEGER NOT NULL,
    "context" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "run_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "account_id" UUID NOT NULL,

    CONSTRAINT "automation_pending_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_steps" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "automation_id" UUID NOT NULL,
    "parent_step_id" UUID,
    "branch" TEXT,
    "step_type" TEXT NOT NULL,
    "step_config" JSONB NOT NULL DEFAULT '{}',
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "trigger_type" TEXT NOT NULL,
    "trigger_config" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "execution_count" INTEGER NOT NULL DEFAULT 0,
    "last_executed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "account_id" UUID NOT NULL,

    CONSTRAINT "automations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcast_recipients" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "broadcast_id" UUID NOT NULL,
    "contact_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sent_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "read_at" TIMESTAMPTZ(6),
    "replied_at" TIMESTAMPTZ(6),
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "whatsapp_message_id" TEXT,

    CONSTRAINT "broadcast_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcasts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "template_name" TEXT NOT NULL,
    "template_language" TEXT NOT NULL DEFAULT 'en_US',
    "template_variables" JSONB,
    "audience_filter" JSONB,
    "scheduled_at" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL DEFAULT 'draft',
    "total_recipients" INTEGER DEFAULT 0,
    "sent_count" INTEGER DEFAULT 0,
    "delivered_count" INTEGER DEFAULT 0,
    "read_count" INTEGER DEFAULT 0,
    "replied_count" INTEGER DEFAULT 0,
    "failed_count" INTEGER DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "account_id" UUID NOT NULL,

    CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_schedules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "broadcast_id" UUID,
    "retargeting_config" JSONB,
    "schedule_type" TEXT NOT NULL,
    "scheduled_at" TIMESTAMPTZ(6) NOT NULL,
    "recurring_pattern" TEXT,
    "timezone" TEXT DEFAULT 'UTC',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "last_run_at" TIMESTAMPTZ(6),
    "next_run_at" TIMESTAMPTZ(6),
    "run_count" INTEGER DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_custom_values" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "contact_id" UUID NOT NULL,
    "custom_field_id" UUID NOT NULL,
    "value" TEXT,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_custom_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_notes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "contact_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "note_text" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "account_id" UUID NOT NULL,

    CONSTRAINT "contact_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_tags" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "contact_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "company" TEXT,
    "avatar_url" TEXT,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "account_id" UUID NOT NULL,
    "phone_normalized" TEXT DEFAULT regexp_replace(phone, '\D'::text, ''::text, 'g'::text),

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "assigned_agent_id" UUID,
    "last_message_text" TEXT,
    "last_message_at" TIMESTAMPTZ(6),
    "unread_count" INTEGER DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "account_id" UUID NOT NULL,
    "ai_autoreply_disabled" BOOLEAN NOT NULL DEFAULT false,
    "ai_reply_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ctwa_campaigns" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "meta_ad_id" TEXT,
    "meta_campaign_id" TEXT,
    "pre_filled_message" TEXT,
    "deep_link_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "click_count" INTEGER DEFAULT 0,
    "conversation_count" INTEGER DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ctwa_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ctwa_clicks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "campaign_id" UUID NOT NULL,
    "contact_id" UUID,
    "conversation_id" UUID,
    "click_timestamp" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "user_agent" TEXT,
    "referrer" TEXT,
    "ip_address" TEXT,
    "converted" BOOLEAN DEFAULT false,
    "converted_at" TIMESTAMPTZ(6),

    CONSTRAINT "ctwa_clicks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_fields" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "field_name" TEXT NOT NULL,
    "field_type" TEXT NOT NULL DEFAULT 'text',
    "field_options" JSONB,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "account_id" UUID NOT NULL,

    CONSTRAINT "custom_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "pipeline_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "contact_id" UUID,
    "conversation_id" UUID,
    "title" TEXT NOT NULL,
    "value" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" TEXT DEFAULT 'USD',
    "notes" TEXT,
    "expected_close_date" DATE,
    "status" TEXT DEFAULT 'open',
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "assigned_to" UUID,
    "account_id" UUID NOT NULL,

    CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ecommerce_integrations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "store_url" TEXT NOT NULL,
    "api_key" TEXT,
    "api_secret" TEXT,
    "access_token" TEXT,
    "status" TEXT NOT NULL DEFAULT 'disconnected',
    "last_sync_at" TIMESTAMPTZ(6),
    "sync_error" TEXT,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ecommerce_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ecommerce_orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "integration_id" UUID NOT NULL,
    "external_order_id" TEXT NOT NULL,
    "contact_id" UUID,
    "total_amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL,
    "order_url" TEXT NOT NULL,
    "sync_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ecommerce_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ecommerce_products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "integration_id" UUID NOT NULL,
    "external_product_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "image_url" TEXT,
    "product_url" TEXT NOT NULL,
    "inventory_count" INTEGER DEFAULT 0,
    "sync_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ecommerce_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facebook_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "fb_user_id" TEXT NOT NULL,
    "fb_user_name" TEXT,
    "access_token" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "facebook_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facebook_pages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "connection_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "page_id" TEXT NOT NULL,
    "page_name" TEXT NOT NULL,
    "page_access_token" TEXT NOT NULL,
    "is_syncing" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "facebook_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flow_nodes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "flow_id" UUID NOT NULL,
    "node_key" TEXT NOT NULL,
    "node_type" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "position_x" INTEGER NOT NULL DEFAULT 0,
    "position_y" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flow_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flow_run_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "flow_run_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "node_key" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flow_run_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flow_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "flow_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "contact_id" UUID,
    "conversation_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'active',
    "current_node_key" TEXT,
    "last_prompt_message_id" UUID,
    "vars" JSONB NOT NULL DEFAULT '{}',
    "reprompt_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_advanced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(6),
    "end_reason" TEXT,
    "account_id" UUID NOT NULL,

    CONSTRAINT "flow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flows" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "trigger_type" TEXT NOT NULL,
    "trigger_config" JSONB NOT NULL DEFAULT '{}',
    "entry_node_id" TEXT,
    "fallback_policy" JSONB NOT NULL DEFAULT '{"on_exhaust": "handoff", "max_reprompts": 2, "on_timeout_hours": 24, "on_unknown_reply": "reprompt"}',
    "execution_count" INTEGER NOT NULL DEFAULT 0,
    "last_executed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "account_id" UUID NOT NULL,

    CONSTRAINT "flows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_presence" (
    "user_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'online',
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_presence_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "message_reactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "message_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "emoji" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'Marketing',
    "language" TEXT DEFAULT 'en_US',
    "header_type" TEXT,
    "header_content" TEXT,
    "body_text" TEXT NOT NULL,
    "footer_text" TEXT,
    "buttons" JSONB,
    "status" TEXT DEFAULT 'DRAFT',
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "sample_values" JSONB,
    "meta_template_id" TEXT,
    "rejection_reason" TEXT,
    "quality_score" TEXT,
    "header_handle" TEXT,
    "header_media_url" TEXT,
    "submission_error" TEXT,
    "last_submitted_at" TIMESTAMPTZ(6),
    "account_id" UUID NOT NULL,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID NOT NULL,
    "sender_type" TEXT NOT NULL,
    "sender_id" UUID,
    "content_type" TEXT NOT NULL DEFAULT 'text',
    "content_text" TEXT,
    "media_url" TEXT,
    "template_name" TEXT,
    "message_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "reply_to_message_id" UUID,
    "interactive_reply_id" TEXT,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'conversation_assigned',
    "conversation_id" UUID,
    "contact_id" UUID,
    "actor_user_id" UUID,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipeline_stages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pipeline_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "color" TEXT NOT NULL DEFAULT '#3b82f6',
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pipeline_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipelines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "account_id" UUID NOT NULL,

    CONSTRAINT "pipelines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retargeting_audiences" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schedule_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "filter_criteria" JSONB NOT NULL,
    "contact_count" INTEGER DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retargeting_audiences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "description" TEXT,
    "price_monthly" DECIMAL(10,2) DEFAULT 0,
    "price_yearly" DECIMAL(10,2) DEFAULT 0,
    "stripe_price_id_monthly" TEXT,
    "stripe_price_id_yearly" TEXT,
    "razorpay_plan_id" TEXT,
    "max_contacts" INTEGER NOT NULL DEFAULT 0,
    "max_messages_monthly" INTEGER NOT NULL DEFAULT 0,
    "max_broadcasts_monthly" INTEGER NOT NULL DEFAULT 0,
    "max_flows" INTEGER,
    "max_team_members" INTEGER NOT NULL DEFAULT 0,
    "max_storage_mb" INTEGER NOT NULL DEFAULT 0,
    "trial_days" INTEGER,
    "features" JSONB DEFAULT '[]',
    "is_active" BOOLEAN DEFAULT true,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#3b82f6',
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "account_id" UUID NOT NULL,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_tracking" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "period_end" TIMESTAMPTZ(6) NOT NULL,
    "contacts_count" INTEGER DEFAULT 0,
    "messages_sent" INTEGER DEFAULT 0,
    "broadcasts_sent" INTEGER DEFAULT 0,
    "flows_active" INTEGER DEFAULT 0,
    "storage_used_mb" INTEGER DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_tracking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" "subscription_status_enum" NOT NULL DEFAULT 'active',
    "billing_cycle" "billing_cycle_enum",
    "trial_start_at" TIMESTAMPTZ(6),
    "trial_end_at" TIMESTAMPTZ(6),
    "current_period_start" TIMESTAMPTZ(6),
    "current_period_end" TIMESTAMPTZ(6),
    "cancel_at_period_end" BOOLEAN DEFAULT false,
    "stripe_subscription_id" TEXT,
    "razorpay_subscription_id" TEXT,
    "payment_method" "payment_method_enum" DEFAULT 'manual',
    "manually_assigned_by" UUID,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "created_by" UUID,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_delivery_at" TIMESTAMPTZ(6),
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_config" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "phone_number_id" TEXT NOT NULL,
    "waba_id" TEXT,
    "access_token" TEXT NOT NULL,
    "verify_token" TEXT,
    "status" TEXT NOT NULL DEFAULT 'disconnected',
    "connected_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "registered_at" TIMESTAMPTZ(6),
    "subscribed_apps_at" TIMESTAMPTZ(6),
    "last_registration_error" TEXT,
    "account_id" UUID NOT NULL,
    "connection_method" TEXT NOT NULL DEFAULT 'manual',
    "business_id" TEXT,
    "coexistence" BOOLEAN NOT NULL DEFAULT false,
    "token_expires_at" TIMESTAMPTZ(6),

    CONSTRAINT "whatsapp_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "contact_id" UUID,
    "whatsapp_message_id" TEXT,
    "total_amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "notes" TEXT,
    "items" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "retailer_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "image_url" TEXT,
    "is_active" BOOLEAN DEFAULT true,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_products_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "idx_accounts_one_per_owner" ON "accounts"("owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "profiles_user_id_key" ON "profiles"("user_id");

-- CreateIndex
CREATE INDEX "idx_profiles_account_role" ON "profiles"("account_id", "account_role");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "api_keys_account_id_idx" ON "api_keys"("account_id");

-- CreateIndex
CREATE INDEX "api_keys_key_hash_idx" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "audit_logs_instance_id_idx" ON "auth"."audit_log_entries"("instance_id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_oauth_providers_identifier_key" ON "auth"."custom_oauth_providers"("identifier");

-- CreateIndex
CREATE INDEX "custom_oauth_providers_created_at_idx" ON "auth"."custom_oauth_providers"("created_at");

-- CreateIndex
CREATE INDEX "custom_oauth_providers_enabled_idx" ON "auth"."custom_oauth_providers"("enabled");

-- CreateIndex
CREATE INDEX "custom_oauth_providers_identifier_idx" ON "auth"."custom_oauth_providers"("identifier");

-- CreateIndex
CREATE INDEX "custom_oauth_providers_provider_type_idx" ON "auth"."custom_oauth_providers"("provider_type");

-- CreateIndex
CREATE INDEX "flow_state_created_at_idx" ON "auth"."flow_state"("created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_auth_code" ON "auth"."flow_state"("auth_code");

-- CreateIndex
CREATE INDEX "idx_user_id_auth_method" ON "auth"."flow_state"("user_id", "authentication_method");

-- CreateIndex
CREATE INDEX "identities_email_idx" ON "auth"."identities"("email");

-- CreateIndex
CREATE INDEX "identities_user_id_idx" ON "auth"."identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "identities_provider_id_provider_unique" ON "auth"."identities"("provider_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_amr_claims_session_id_authentication_method_pkey" ON "auth"."mfa_amr_claims"("session_id", "authentication_method");

-- CreateIndex
CREATE INDEX "mfa_challenge_created_at_idx" ON "auth"."mfa_challenges"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "mfa_factors_last_challenged_at_key" ON "auth"."mfa_factors"("last_challenged_at");

-- CreateIndex
CREATE INDEX "factor_id_created_at_idx" ON "auth"."mfa_factors"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "mfa_factors_user_id_idx" ON "auth"."mfa_factors"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_factors_user_friendly_name_unique" ON "auth"."mfa_factors"("friendly_name", "user_id") WHERE (TRIM(BOTH FROM friendly_name) <> ''::text);

-- CreateIndex
CREATE UNIQUE INDEX "unique_phone_factor_per_user" ON "auth"."mfa_factors"("user_id", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_authorizations_authorization_id_key" ON "auth"."oauth_authorizations"("authorization_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_authorizations_authorization_code_key" ON "auth"."oauth_authorizations"("authorization_code");

-- CreateIndex
CREATE INDEX "oauth_auth_pending_exp_idx" ON "auth"."oauth_authorizations"("expires_at") WHERE (status = 'pending'::auth.oauth_authorization_status);

-- CreateIndex
CREATE INDEX "idx_oauth_client_states_created_at" ON "auth"."oauth_client_states"("created_at");

-- CreateIndex
CREATE INDEX "oauth_clients_deleted_at_idx" ON "auth"."oauth_clients"("deleted_at");

-- CreateIndex
CREATE INDEX "oauth_consents_active_client_idx" ON "auth"."oauth_consents"("client_id") WHERE (revoked_at IS NULL);

-- CreateIndex
CREATE INDEX "oauth_consents_active_user_client_idx" ON "auth"."oauth_consents"("user_id", "client_id") WHERE (revoked_at IS NULL);

-- CreateIndex
CREATE INDEX "oauth_consents_user_order_idx" ON "auth"."oauth_consents"("user_id", "granted_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_consents_user_client_unique" ON "auth"."oauth_consents"("user_id", "client_id");

-- CreateIndex
CREATE INDEX "one_time_tokens_relates_to_hash_idx" ON "auth"."one_time_tokens" USING HASH ("relates_to");

-- CreateIndex
CREATE INDEX "one_time_tokens_token_hash_hash_idx" ON "auth"."one_time_tokens" USING HASH ("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "one_time_tokens_user_id_token_type_key" ON "auth"."one_time_tokens"("user_id", "token_type");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_unique" ON "auth"."refresh_tokens"("token");

-- CreateIndex
CREATE INDEX "refresh_tokens_instance_id_idx" ON "auth"."refresh_tokens"("instance_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_instance_id_user_id_idx" ON "auth"."refresh_tokens"("instance_id", "user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_parent_idx" ON "auth"."refresh_tokens"("parent");

-- CreateIndex
CREATE INDEX "refresh_tokens_session_id_revoked_idx" ON "auth"."refresh_tokens"("session_id", "revoked");

-- CreateIndex
CREATE INDEX "refresh_tokens_updated_at_idx" ON "auth"."refresh_tokens"("updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "saml_providers_entity_id_key" ON "auth"."saml_providers"("entity_id");

-- CreateIndex
CREATE INDEX "saml_providers_sso_provider_id_idx" ON "auth"."saml_providers"("sso_provider_id");

-- CreateIndex
CREATE INDEX "saml_relay_states_created_at_idx" ON "auth"."saml_relay_states"("created_at" DESC);

-- CreateIndex
CREATE INDEX "saml_relay_states_for_email_idx" ON "auth"."saml_relay_states"("for_email");

-- CreateIndex
CREATE INDEX "saml_relay_states_sso_provider_id_idx" ON "auth"."saml_relay_states"("sso_provider_id");

-- CreateIndex
CREATE INDEX "sessions_not_after_idx" ON "auth"."sessions"("not_after" DESC);

-- CreateIndex
CREATE INDEX "sessions_oauth_client_id_idx" ON "auth"."sessions"("oauth_client_id");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "auth"."sessions"("user_id");

-- CreateIndex
CREATE INDEX "user_id_created_at_idx" ON "auth"."sessions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "sso_domains_sso_provider_id_idx" ON "auth"."sso_domains"("sso_provider_id");

-- CreateIndex
CREATE INDEX "sso_providers_resource_id_pattern_idx" ON "auth"."sso_providers"("resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_partial_key" ON "auth"."users"("email") WHERE (is_sso_user = false);

-- CreateIndex
CREATE UNIQUE INDEX "confirmation_token_idx" ON "auth"."users"("confirmation_token") WHERE ((confirmation_token)::text !~ '^[0-9 ]*$'::text);

-- CreateIndex
CREATE UNIQUE INDEX "recovery_token_idx" ON "auth"."users"("recovery_token") WHERE ((recovery_token)::text !~ '^[0-9 ]*$'::text);

-- CreateIndex
CREATE UNIQUE INDEX "email_change_token_new_idx" ON "auth"."users"("email_change_token_new") WHERE ((email_change_token_new)::text !~ '^[0-9 ]*$'::text);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "auth"."users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "email_change_token_current_idx" ON "auth"."users"("email_change_token_current") WHERE ((email_change_token_current)::text !~ '^[0-9 ]*$'::text);

-- CreateIndex
CREATE UNIQUE INDEX "reauthentication_token_idx" ON "auth"."users"("reauthentication_token") WHERE ((reauthentication_token)::text !~ '^[0-9 ]*$'::text);

-- CreateIndex
CREATE INDEX "idx_users_created_at_desc" ON "auth"."users"("created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_users_email" ON "auth"."users"("email");

-- CreateIndex
CREATE INDEX "idx_users_last_sign_in_at_desc" ON "auth"."users"("last_sign_in_at" DESC);

-- CreateIndex
CREATE INDEX "users_instance_id_idx" ON "auth"."users"("instance_id");

-- CreateIndex
CREATE INDEX "users_is_anonymous_idx" ON "auth"."users"("is_anonymous");

-- CreateIndex
CREATE INDEX "webauthn_challenges_expires_at_idx" ON "auth"."webauthn_challenges"("expires_at");

-- CreateIndex
CREATE INDEX "webauthn_challenges_user_id_idx" ON "auth"."webauthn_challenges"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "webauthn_credentials_credential_id_key" ON "auth"."webauthn_credentials"("credential_id");

-- CreateIndex
CREATE INDEX "webauthn_credentials_user_id_idx" ON "auth"."webauthn_credentials"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_invitations_token_hash_key" ON "account_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "idx_account_invitations_account_pending" ON "account_invitations"("account_id", "expires_at") WHERE (accepted_at IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "ai_configs_account_id_key" ON "ai_configs"("account_id");

-- CreateIndex
CREATE INDEX "ai_knowledge_chunks_account_id_idx" ON "ai_knowledge_chunks"("account_id");

-- CreateIndex
CREATE INDEX "ai_knowledge_chunks_document_id_idx" ON "ai_knowledge_chunks"("document_id");

-- CreateIndex
CREATE INDEX "ai_knowledge_chunks_embedding_idx" ON "ai_knowledge_chunks"("embedding");

-- CreateIndex
CREATE INDEX "ai_knowledge_chunks_fts_idx" ON "ai_knowledge_chunks" USING GIN ("fts");

-- CreateIndex
CREATE INDEX "ai_knowledge_documents_account_id_idx" ON "ai_knowledge_documents"("account_id");

-- CreateIndex
CREATE INDEX "idx_automation_logs_account" ON "automation_logs"("account_id");

-- CreateIndex
CREATE INDEX "idx_automation_logs_account_time" ON "automation_logs"("account_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_automation_logs_automation" ON "automation_logs"("automation_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_automation_logs_user" ON "automation_logs"("user_id");

-- CreateIndex
CREATE INDEX "idx_automation_pending_account" ON "automation_pending_executions"("account_id");

-- CreateIndex
CREATE INDEX "idx_automation_pending_due" ON "automation_pending_executions"("run_at") WHERE (status = 'pending'::text);

-- CreateIndex
CREATE INDEX "idx_automation_steps_automation_id" ON "automation_steps"("automation_id", "position");

-- CreateIndex
CREATE INDEX "idx_automation_steps_parent" ON "automation_steps"("parent_step_id") WHERE (parent_step_id IS NOT NULL);

-- CreateIndex
CREATE INDEX "idx_automations_account" ON "automations"("account_id");

-- CreateIndex
CREATE INDEX "idx_automations_account_active_trigger" ON "automations"("account_id", "trigger_type") WHERE (is_active = true);

-- CreateIndex
CREATE INDEX "idx_automations_active_trigger" ON "automations"("trigger_type") WHERE (is_active = true);

-- CreateIndex
CREATE INDEX "idx_automations_user_id" ON "automations"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "idx_broadcast_recipients_wamid" ON "broadcast_recipients"("whatsapp_message_id") WHERE (whatsapp_message_id IS NOT NULL);

-- CreateIndex
CREATE INDEX "idx_broadcast_recipients_broadcast" ON "broadcast_recipients"("broadcast_id");

-- CreateIndex
CREATE INDEX "idx_broadcast_recipients_broadcast_status" ON "broadcast_recipients"("broadcast_id", "status");

-- CreateIndex
CREATE INDEX "idx_broadcast_recipients_contact_status" ON "broadcast_recipients"("contact_id", "status");

-- CreateIndex
CREATE INDEX "idx_broadcasts_account" ON "broadcasts"("account_id");

-- CreateIndex
CREATE INDEX "idx_campaign_schedules_account" ON "campaign_schedules"("account_id");

-- CreateIndex
CREATE INDEX "idx_campaign_schedules_broadcast" ON "campaign_schedules"("broadcast_id");

-- CreateIndex
CREATE INDEX "idx_campaign_schedules_next_run" ON "campaign_schedules"("next_run_at") WHERE (next_run_at IS NOT NULL);

-- CreateIndex
CREATE INDEX "idx_campaign_schedules_status" ON "campaign_schedules"("status");

-- CreateIndex
CREATE UNIQUE INDEX "contact_custom_values_contact_id_custom_field_id_key" ON "contact_custom_values"("contact_id", "custom_field_id");

-- CreateIndex
CREATE INDEX "idx_contact_notes_account" ON "contact_notes"("account_id");

-- CreateIndex
CREATE INDEX "idx_contact_tags_contact" ON "contact_tags"("contact_id");

-- CreateIndex
CREATE INDEX "idx_contact_tags_tag" ON "contact_tags"("tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_tags_contact_id_tag_id_key" ON "contact_tags"("contact_id", "tag_id");

-- CreateIndex
CREATE INDEX "idx_contacts_account" ON "contacts"("account_id");

-- CreateIndex
CREATE INDEX "idx_contacts_phone" ON "contacts"("phone");

-- CreateIndex
CREATE INDEX "idx_contacts_user_id" ON "contacts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "idx_contacts_account_phone_normalized" ON "contacts"("account_id", "phone_normalized") WHERE (phone_normalized <> ''::text);

-- CreateIndex
CREATE INDEX "idx_conversations_account" ON "conversations"("account_id");

-- CreateIndex
CREATE INDEX "idx_conversations_account_contact" ON "conversations"("account_id", "contact_id");

-- CreateIndex
CREATE INDEX "idx_conversations_account_status_time" ON "conversations"("account_id", "status", "last_message_at" DESC);

-- CreateIndex
CREATE INDEX "idx_conversations_contact_id" ON "conversations"("contact_id");

-- CreateIndex
CREATE INDEX "idx_conversations_user_id" ON "conversations"("user_id");

-- CreateIndex
CREATE INDEX "idx_ctwa_campaigns_account" ON "ctwa_campaigns"("account_id");

-- CreateIndex
CREATE INDEX "idx_ctwa_campaigns_meta_ad" ON "ctwa_campaigns"("meta_ad_id");

-- CreateIndex
CREATE INDEX "idx_ctwa_clicks_campaign" ON "ctwa_clicks"("campaign_id");

-- CreateIndex
CREATE INDEX "idx_ctwa_clicks_contact" ON "ctwa_clicks"("contact_id");

-- CreateIndex
CREATE INDEX "idx_ctwa_clicks_conversation" ON "ctwa_clicks"("conversation_id");

-- CreateIndex
CREATE INDEX "idx_custom_fields_account" ON "custom_fields"("account_id");

-- CreateIndex
CREATE INDEX "idx_deals_account" ON "deals"("account_id");

-- CreateIndex
CREATE INDEX "idx_deals_assigned_to" ON "deals"("assigned_to");

-- CreateIndex
CREATE INDEX "idx_deals_pipeline" ON "deals"("pipeline_id");

-- CreateIndex
CREATE INDEX "idx_deals_stage" ON "deals"("stage_id");

-- CreateIndex
CREATE INDEX "idx_ecommerce_integrations_account" ON "ecommerce_integrations"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "ecommerce_integrations_account_id_platform_key" ON "ecommerce_integrations"("account_id", "platform");

-- CreateIndex
CREATE INDEX "idx_ecommerce_orders_contact" ON "ecommerce_orders"("contact_id");

-- CreateIndex
CREATE INDEX "idx_ecommerce_orders_external" ON "ecommerce_orders"("external_order_id");

-- CreateIndex
CREATE INDEX "idx_ecommerce_orders_integration" ON "ecommerce_orders"("integration_id");

-- CreateIndex
CREATE UNIQUE INDEX "ecommerce_orders_integration_id_external_order_id_key" ON "ecommerce_orders"("integration_id", "external_order_id");

-- CreateIndex
CREATE INDEX "idx_ecommerce_products_external" ON "ecommerce_products"("external_product_id");

-- CreateIndex
CREATE INDEX "idx_ecommerce_products_integration" ON "ecommerce_products"("integration_id");

-- CreateIndex
CREATE UNIQUE INDEX "ecommerce_products_integration_id_external_product_id_key" ON "ecommerce_products"("integration_id", "external_product_id");

-- CreateIndex
CREATE INDEX "idx_facebook_connections_user" ON "facebook_connections"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "facebook_connections_user_id_fb_user_id_key" ON "facebook_connections"("user_id", "fb_user_id");

-- CreateIndex
CREATE INDEX "idx_facebook_pages_connection" ON "facebook_pages"("connection_id");

-- CreateIndex
CREATE INDEX "idx_facebook_pages_user" ON "facebook_pages"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "facebook_pages_user_id_page_id_key" ON "facebook_pages"("user_id", "page_id");

-- CreateIndex
CREATE INDEX "idx_flow_nodes_flow" ON "flow_nodes"("flow_id");

-- CreateIndex
CREATE UNIQUE INDEX "flow_nodes_flow_id_node_key_key" ON "flow_nodes"("flow_id", "node_key");

-- CreateIndex
CREATE INDEX "idx_flow_run_events_run_time" ON "flow_run_events"("flow_run_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_flow_run_events_run_type" ON "flow_run_events"("flow_run_id", "event_type");

-- CreateIndex
CREATE INDEX "idx_flow_runs_account" ON "flow_runs"("account_id");

-- CreateIndex
CREATE INDEX "idx_flow_runs_account_contact_status" ON "flow_runs"("account_id", "contact_id", "status") WHERE (status = 'active'::text);

-- CreateIndex
CREATE INDEX "idx_flow_runs_active_advanced" ON "flow_runs"("last_advanced_at") WHERE (status = 'active'::text);

-- CreateIndex
CREATE INDEX "idx_flow_runs_flow_started" ON "flow_runs"("flow_id", "started_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "idx_one_active_run_per_contact" ON "flow_runs"("account_id", "contact_id") WHERE (status = 'active'::text);

-- CreateIndex
CREATE INDEX "idx_flows_account" ON "flows"("account_id");

-- CreateIndex
CREATE INDEX "idx_flows_account_active" ON "flows"("account_id") WHERE (status = 'active'::text);

-- CreateIndex
CREATE INDEX "idx_flows_active_trigger" ON "flows"("user_id", "trigger_type") WHERE (status = 'active'::text);

-- CreateIndex
CREATE INDEX "member_presence_account_idx" ON "member_presence"("account_id");

-- CreateIndex
CREATE INDEX "idx_message_reactions_conversation" ON "message_reactions"("conversation_id");

-- CreateIndex
CREATE INDEX "idx_message_reactions_message" ON "message_reactions"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_reactions_message_id_actor_type_actor_id_key" ON "message_reactions"("message_id", "actor_type", "actor_id");

-- CreateIndex
CREATE INDEX "idx_message_templates_account" ON "message_templates"("account_id");

-- CreateIndex
CREATE INDEX "idx_message_templates_meta_template_id" ON "message_templates"("meta_template_id") WHERE (meta_template_id IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_user_name_language_key" ON "message_templates"("user_id", "name", "language");

-- CreateIndex
CREATE INDEX "idx_messages_conv_sender" ON "messages"("conversation_id", "sender_type");

-- CreateIndex
CREATE INDEX "idx_messages_conv_time" ON "messages"("conversation_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_messages_conversation" ON "messages"("conversation_id");

-- CreateIndex
CREATE INDEX "idx_messages_message_id" ON "messages"("message_id");

-- CreateIndex
CREATE INDEX "idx_messages_reply_to" ON "messages"("reply_to_message_id") WHERE (reply_to_message_id IS NOT NULL);

-- CreateIndex
CREATE INDEX "idx_messages_time_sender" ON "messages"("created_at", "sender_type");

-- CreateIndex
CREATE INDEX "idx_notifications_user_created" ON "notifications"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_notifications_user_unread" ON "notifications"("user_id") WHERE (read_at IS NULL);

-- CreateIndex
CREATE INDEX "idx_pipeline_stages_pipeline" ON "pipeline_stages"("pipeline_id");

-- CreateIndex
CREATE INDEX "idx_pipelines_account" ON "pipelines"("account_id");

-- CreateIndex
CREATE INDEX "idx_retargeting_audiences_schedule" ON "retargeting_audiences"("schedule_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_plans_name_key" ON "subscription_plans"("name");

-- CreateIndex
CREATE INDEX "idx_subscription_plans_active" ON "subscription_plans"("is_active");

-- CreateIndex
CREATE INDEX "idx_subscription_plans_name" ON "subscription_plans"("name");

-- CreateIndex
CREATE INDEX "idx_tags_account" ON "tags"("account_id");

-- CreateIndex
CREATE INDEX "idx_usage_tracking_period" ON "usage_tracking"("period_end");

-- CreateIndex
CREATE INDEX "idx_usage_tracking_user_period" ON "usage_tracking"("user_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "usage_tracking_user_id_period_start_key" ON "usage_tracking"("user_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "user_subscriptions_user_id_key" ON "user_subscriptions"("user_id");

-- CreateIndex
CREATE INDEX "idx_user_subscriptions_plan_id" ON "user_subscriptions"("plan_id");

-- CreateIndex
CREATE INDEX "idx_user_subscriptions_status" ON "user_subscriptions"("status");

-- CreateIndex
CREATE INDEX "idx_user_subscriptions_trial_end" ON "user_subscriptions"("trial_end_at") WHERE (trial_end_at IS NOT NULL);

-- CreateIndex
CREATE INDEX "idx_user_subscriptions_user_id" ON "user_subscriptions"("user_id");

-- CreateIndex
CREATE INDEX "webhook_endpoints_account_id_idx" ON "webhook_endpoints"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_config_phone_number_id_key" ON "whatsapp_config"("phone_number_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_config_account_id_key" ON "whatsapp_config"("account_id");

-- CreateIndex
CREATE INDEX "idx_whatsapp_config_account" ON "whatsapp_config"("account_id");

-- CreateIndex
CREATE INDEX "idx_whatsapp_config_registered_at" ON "whatsapp_config"("registered_at") WHERE (registered_at IS NULL);

-- CreateIndex
CREATE INDEX "idx_whatsapp_config_token_expires_at" ON "whatsapp_config"("token_expires_at") WHERE (token_expires_at IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_orders_whatsapp_message_id_key" ON "whatsapp_orders"("whatsapp_message_id");

-- CreateIndex
CREATE INDEX "idx_whatsapp_orders_account" ON "whatsapp_orders"("account_id");

-- CreateIndex
CREATE INDEX "idx_whatsapp_orders_contact" ON "whatsapp_orders"("contact_id");

-- CreateIndex
CREATE INDEX "idx_whatsapp_products_account" ON "whatsapp_products"("account_id");

-- CreateIndex
CREATE INDEX "idx_whatsapp_products_retailer" ON "whatsapp_products"("retailer_id");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_products_account_id_retailer_id_key" ON "whatsapp_products"("account_id", "retailer_id");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth"."identities" ADD CONSTRAINT "identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth"."mfa_amr_claims" ADD CONSTRAINT "mfa_amr_claims_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "auth"."sessions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth"."mfa_challenges" ADD CONSTRAINT "mfa_challenges_auth_factor_id_fkey" FOREIGN KEY ("factor_id") REFERENCES "auth"."mfa_factors"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth"."mfa_factors" ADD CONSTRAINT "mfa_factors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth"."oauth_authorizations" ADD CONSTRAINT "oauth_authorizations_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "auth"."oauth_clients"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth"."oauth_authorizations" ADD CONSTRAINT "oauth_authorizations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth"."oauth_consents" ADD CONSTRAINT "oauth_consents_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "auth"."oauth_clients"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth"."oauth_consents" ADD CONSTRAINT "oauth_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth"."one_time_tokens" ADD CONSTRAINT "one_time_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "auth"."sessions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth"."saml_providers" ADD CONSTRAINT "saml_providers_sso_provider_id_fkey" FOREIGN KEY ("sso_provider_id") REFERENCES "auth"."sso_providers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth"."saml_relay_states" ADD CONSTRAINT "saml_relay_states_flow_state_id_fkey" FOREIGN KEY ("flow_state_id") REFERENCES "auth"."flow_state"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth"."saml_relay_states" ADD CONSTRAINT "saml_relay_states_sso_provider_id_fkey" FOREIGN KEY ("sso_provider_id") REFERENCES "auth"."sso_providers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth"."sessions" ADD CONSTRAINT "sessions_oauth_client_id_fkey" FOREIGN KEY ("oauth_client_id") REFERENCES "auth"."oauth_clients"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth"."sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth"."sso_domains" ADD CONSTRAINT "sso_domains_sso_provider_id_fkey" FOREIGN KEY ("sso_provider_id") REFERENCES "auth"."sso_providers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth"."webauthn_challenges" ADD CONSTRAINT "webauthn_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "auth"."webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "account_invitations" ADD CONSTRAINT "account_invitations_accepted_by_user_id_fkey" FOREIGN KEY ("accepted_by_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "account_invitations" ADD CONSTRAINT "account_invitations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "account_invitations" ADD CONSTRAINT "account_invitations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ai_configs" ADD CONSTRAINT "ai_configs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ai_configs" ADD CONSTRAINT "ai_configs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ai_knowledge_chunks" ADD CONSTRAINT "ai_knowledge_chunks_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ai_knowledge_chunks" ADD CONSTRAINT "ai_knowledge_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "ai_knowledge_documents"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ai_knowledge_documents" ADD CONSTRAINT "ai_knowledge_documents_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ai_knowledge_documents" ADD CONSTRAINT "ai_knowledge_documents_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "automation_logs" ADD CONSTRAINT "automation_logs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "automation_logs" ADD CONSTRAINT "automation_logs_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "automations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "automation_logs" ADD CONSTRAINT "automation_logs_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "automation_logs" ADD CONSTRAINT "automation_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "automation_pending_executions" ADD CONSTRAINT "automation_pending_executions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "automation_pending_executions" ADD CONSTRAINT "automation_pending_executions_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "automations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "automation_pending_executions" ADD CONSTRAINT "automation_pending_executions_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "automation_pending_executions" ADD CONSTRAINT "automation_pending_executions_log_id_fkey" FOREIGN KEY ("log_id") REFERENCES "automation_logs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "automation_pending_executions" ADD CONSTRAINT "automation_pending_executions_parent_step_id_fkey" FOREIGN KEY ("parent_step_id") REFERENCES "automation_steps"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "automation_pending_executions" ADD CONSTRAINT "automation_pending_executions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "automation_steps" ADD CONSTRAINT "automation_steps_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "automations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "automation_steps" ADD CONSTRAINT "automation_steps_parent_step_id_fkey" FOREIGN KEY ("parent_step_id") REFERENCES "automation_steps"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "automations" ADD CONSTRAINT "automations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "automations" ADD CONSTRAINT "automations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_broadcast_id_fkey" FOREIGN KEY ("broadcast_id") REFERENCES "broadcasts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "campaign_schedules" ADD CONSTRAINT "campaign_schedules_broadcast_id_fkey" FOREIGN KEY ("broadcast_id") REFERENCES "broadcasts"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "contact_custom_values" ADD CONSTRAINT "contact_custom_values_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "contact_custom_values" ADD CONSTRAINT "contact_custom_values_custom_field_id_fkey" FOREIGN KEY ("custom_field_id") REFERENCES "custom_fields"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "contact_tags" ADD CONSTRAINT "contact_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ctwa_clicks" ADD CONSTRAINT "ctwa_clicks_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "ctwa_campaigns"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ctwa_clicks" ADD CONSTRAINT "ctwa_clicks_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ctwa_clicks" ADD CONSTRAINT "ctwa_clicks_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "custom_fields" ADD CONSTRAINT "custom_fields_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "custom_fields" ADD CONSTRAINT "custom_fields_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "pipelines"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "pipeline_stages"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ecommerce_orders" ADD CONSTRAINT "ecommerce_orders_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ecommerce_orders" ADD CONSTRAINT "ecommerce_orders_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "ecommerce_integrations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ecommerce_products" ADD CONSTRAINT "ecommerce_products_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "ecommerce_integrations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "facebook_connections" ADD CONSTRAINT "facebook_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "facebook_pages" ADD CONSTRAINT "facebook_pages_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "facebook_connections"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "facebook_pages" ADD CONSTRAINT "facebook_pages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "flow_nodes" ADD CONSTRAINT "flow_nodes_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "flows"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "flow_run_events" ADD CONSTRAINT "flow_run_events_flow_run_id_fkey" FOREIGN KEY ("flow_run_id") REFERENCES "flow_runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_flow_id_fkey" FOREIGN KEY ("flow_id") REFERENCES "flows"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_last_prompt_message_id_fkey" FOREIGN KEY ("last_prompt_message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "flows" ADD CONSTRAINT "flows_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "flows" ADD CONSTRAINT "flows_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "member_presence" ADD CONSTRAINT "member_presence_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "member_presence" ADD CONSTRAINT "member_presence_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_message_id_fkey" FOREIGN KEY ("reply_to_message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "pipelines"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "retargeting_audiences" ADD CONSTRAINT "retargeting_audiences_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "campaign_schedules"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "usage_tracking" ADD CONSTRAINT "usage_tracking_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_manually_assigned_by_fkey" FOREIGN KEY ("manually_assigned_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "whatsapp_config" ADD CONSTRAINT "whatsapp_config_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "whatsapp_config" ADD CONSTRAINT "whatsapp_config_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "whatsapp_orders" ADD CONSTRAINT "whatsapp_orders_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "whatsapp_orders" ADD CONSTRAINT "whatsapp_orders_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "whatsapp_products" ADD CONSTRAINT "whatsapp_products_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

