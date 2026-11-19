-- Couply v1 Supabase PostgreSQL Schema
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name TEXT NOT NULL,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    country TEXT NOT NULL,
    date_of_birth DATE,
    partner_name TEXT DEFAULT 'Partner',
    password_hash TEXT,
    google_sub TEXT UNIQUE,
    gender_theme TEXT CHECK (gender_theme IN ('female', 'male')) NOT NULL,
    active_deck_theme TEXT DEFAULT 'default',
    is_verified BOOLEAN DEFAULT FALSE,
    last_seen_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS otp_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    purpose TEXT CHECK (purpose IN ('signup', 'login', 'admin')) NOT NULL,
    attempts INTEGER DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    used BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash TEXT NOT NULL,
    last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS saved_cards (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    card_id TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, card_id)
);

CREATE TABLE IF NOT EXISTS ious (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    card_id TEXT NOT NULL,
    deck_id TEXT NOT NULL,
    deck_title TEXT NOT NULL,
    title TEXT NOT NULL,
    owed_by TEXT CHECK (owed_by IN ('me', 'partner')) NOT NULL DEFAULT 'partner',
    redeemed BOOLEAN DEFAULT FALSE,
    redeemed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_otp_codes_email_created ON otp_codes (email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user_active ON sessions (user_id, last_active_at DESC);
CREATE INDEX IF NOT EXISTS idx_ious_user_created ON ious (user_id, created_at DESC);
