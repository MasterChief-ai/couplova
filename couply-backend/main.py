"""Couplova v1 FastAPI Backend for Render + Supabase PostgreSQL."""
from __future__ import annotations

import asyncio
import hashlib
import html
import os
import re
import secrets
import smtplib
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from email.mime.text import MIMEText
from typing import Literal, Optional

import httpx
import jwt
import psycopg
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from pydantic import BaseModel, EmailStr

DATABASE_URL = os.environ["DATABASE_URL"]
JWT_SECRET = os.environ["JWT_SECRET"]
if len(JWT_SECRET) < 16:
    raise RuntimeError("JWT_SECRET must be at least 16 characters")

ADMIN_EMAIL = os.getenv("ADMIN_EMAIL", "daveking248@gmail.com").strip().lower()
RESEND_API_KEY = os.getenv("RESEND_API_KEY", "")
OTP_FROM_EMAIL = os.getenv("OTP_FROM_EMAIL", "Couplova <onboarding@resend.dev>")
GMAIL_SMTP_USER = os.getenv("GMAIL_SMTP_USER", "")
GMAIL_SMTP_APP_PASSWORD = os.getenv("GMAIL_SMTP_APP_PASSWORD", "").replace(" ", "")
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",")
    if origin.strip()
]

USERNAME_RE = re.compile(r"^[a-zA-Z0-9_]{3,24}$")
OTP_CODE_RE = re.compile(r"^\d{6}$")

# Simple in-memory brute-force and IP flood guards (per worker instance)
_rate_buckets: dict[str, list[float]] = defaultdict(list)
_login_failures: dict[str, tuple[int, float]] = {}

ph = PasswordHasher()
app = FastAPI(title="Couplova v1 API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


def get_conn():
    return psycopg.connect(DATABASE_URL)


def enforce_rate_limit(key: str, limit: int, window_sec: float) -> None:
    now = time.monotonic()
    bucket = [t for t in _rate_buckets[key] if (now - t) < window_sec]
    if len(bucket) >= limit:
        raise HTTPException(status_code=429, detail="Too many requests. Please try again shortly.")
    bucket.append(now)
    _rate_buckets[key] = bucket


def check_login_lockout(email: str) -> None:
    entry = _login_failures.get(email)
    if entry and entry[1] > time.monotonic():
        raise HTTPException(status_code=429, detail="Too many failed attempts. Please wait 15 minutes.")
    if entry and entry[1] <= time.monotonic():
        _login_failures.pop(email, None)


def record_login_failure(email: str) -> None:
    count, locked_until = _login_failures.get(email, (0, 0.0))
    now = time.monotonic()
    if locked_until and locked_until <= now:
        count = 0
    count += 1
    _login_failures[email] = (count, now + 900.0 if count >= 5 else 0.0)


def clear_login_failures(email: str) -> None:
    _login_failures.pop(email, None)


def sanitize_header_text(value: str) -> str:
    return re.sub(r"[\x00-\x1f\x7f\u2028\u2029]", "", value).strip()


def sanitize_plain_text(value: str) -> str:
    return re.sub(r"[\x00-\x1f\x7f]", " ", value).strip()


def hash_refresh(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_access_token(user_id: str, session_id: str, email: str) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {
            "sub": user_id,
            "session_id": session_id,
            "email": email,
            "iat": now,
            "exp": now + timedelta(minutes=15),
        },
        JWT_SECRET,
        algorithm="HS256",
    )


def _send_smtp_sync(email: str, subject: str, html_body: str) -> None:
    msg = MIMEText(html_body, "html")
    msg["Subject"] = sanitize_header_text(subject)
    msg["From"] = f"Couplova <{sanitize_header_text(GMAIL_SMTP_USER)}>"
    msg["To"] = sanitize_header_text(email)
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=8) as server:
        server.login(GMAIL_SMTP_USER, GMAIL_SMTP_APP_PASSWORD)
        server.sendmail(GMAIL_SMTP_USER, [email], msg.as_string())


async def dispatch_otp_email(email: str, code: str, purpose: str = "signup") -> None:
    safe_email = html.escape(email)
    safe_code = html.escape(code)
    if purpose == "login":
        subject = "Confirm your Couplova sign-in"
        heading = "Confirm it's you<br/>trying to sign in to Couplova"
        body = (
            f"Someone just entered your password to step back into Couplova as {safe_email}. "
            "Enter this 6-digit code within 10 minutes to continue."
        )
        ignore = "If you're not trying to log in right now, you can safely ignore this email."
    else:
        subject = "Confirm your email address for Couplova"
        heading = "Confirm your email address<br/>to begin your story on Couplova"
        body = (
            "Real intimacy begins long after the five-star Friday dinner bill is paid. "
            f"Confirm {safe_email} with this 6-digit code within 10 minutes."
        )
        ignore = "If you didn't request this, you can safely ignore this email."

    html_body = (
        "<div style='font-family:sans-serif;padding:32px 24px;max-width:540px;color:#1A1113;background:#fff;'>"
        f"<h1 style='font-size:24px;margin:0 0 16px;'>{heading}</h1>"
        f"<p style='font-size:15px;line-height:1.6;'>{body}</p>"
        f"<div style='font-size:30px;font-weight:700;letter-spacing:6px;margin:20px 0;'>{safe_code}</div>"
        f"<p style='font-size:13px;color:#666;'>Expires in 10 minutes. {ignore}</p></div>"
    )

    if GMAIL_SMTP_USER and GMAIL_SMTP_APP_PASSWORD and (not RESEND_API_KEY or "onboarding@resend.dev" in OTP_FROM_EMAIL):
        try:
            await asyncio.to_thread(_send_smtp_sync, email, subject, html_body)
            return
        except Exception as exc:
            raise HTTPException(status_code=502, detail="Unable to send verification email via Gmail SMTP") from exc

    if not RESEND_API_KEY:
        raise HTTPException(status_code=503, detail="Email delivery is not configured")

    async with httpx.AsyncClient(timeout=8.0) as client:
        resp = await client.post(
            "https://api.resend.com/emails",
            headers={"Authorization": f"Bearer {RESEND_API_KEY}"},
            json={
                "from": OTP_FROM_EMAIL,
                "to": [email],
                "subject": sanitize_header_text(subject),
                "html": html_body,
            },
        )
        if not resp.is_success:
            raise HTTPException(status_code=502, detail="Unable to send verification email right now")


def require_session(authorization: str = Header(...)):
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    if len(token) > 4096:
        raise HTTPException(status_code=401, detail="Invalid token")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired token") from exc

    with get_conn() as conn, conn.transaction(), conn.cursor() as cur:
        cur.execute(
            "SELECT last_active_at, expires_at, revoked FROM sessions WHERE id = %s",
            (payload["session_id"],),
        )
        row = cur.fetchone()
        if not row or row[2]:
            raise HTTPException(status_code=401, detail="Session revoked")
        now = datetime.now(timezone.utc)
        if (now - row[0]) > timedelta(days=30) or row[1] <= now:
            cur.execute("UPDATE sessions SET revoked = TRUE WHERE id = %s", (payload["session_id"],))
            raise HTTPException(status_code=401, detail="Session expired due to 30 days inactivity")
    return payload


class SignupBody(BaseModel):
    full_name: str
    username: str
    country: Optional[str] = ""
    date_of_birth: Optional[str] = None
    email: EmailStr
    password: str
    confirm_password: str
    gender_theme: Literal["female", "male"]
    accepted_terms: bool


class LoginBody(BaseModel):
    email: EmailStr
    password: str


class VerifyOtpBody(BaseModel):
    email: EmailStr
    code: str
    purpose: Optional[Literal["signup", "login"]] = None


class GoogleAuthBody(BaseModel):
    id_token: str
    gender_theme: Literal["female", "male"] = "female"


@app.post("/api/auth/signup")
async def signup(body: SignupBody, request: Request):
    client_ip = request.client.host if request.client else "unknown"
    enforce_rate_limit(f"signup:{client_ip}", 10, 900.0)

    full_name = sanitize_plain_text(body.full_name)
    username = body.username.strip()
    country = sanitize_plain_text(body.country or "")[:64]

    if len(full_name) < 2 or len(full_name) > 80:
        raise HTTPException(status_code=400, detail="Full name must be between 2 and 80 characters")
    if not USERNAME_RE.match(username):
        raise HTTPException(status_code=400, detail="Username must be 3-24 letters, numbers, or underscores")
    if body.date_of_birth:
        try:
            dob = date.fromisoformat(body.date_of_birth)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid date of birth") from exc
        today = date.today()
        age = today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))
        if age < 13 or age > 120:
            raise HTTPException(status_code=400, detail="Valid date of birth (13+) is required")

    if body.password != body.confirm_password or not body.accepted_terms:
        raise HTTPException(status_code=400, detail="Passwords must match and Terms must be accepted")
    if (
        len(body.password) < 8
        or len(body.password) > 128
        or not re.search(r"[A-Z]", body.password)
        or not re.search(r"[a-z]", body.password)
        or not re.search(r"[0-9]", body.password)
        or not re.search(r"[^A-Za-z0-9\s]", body.password)
    ):
        raise HTTPException(
            status_code=400,
            detail="Password needs 8+ characters, 1 uppercase, 1 lowercase, 1 number, and 1 special character",
        )

    email = body.email.lower()
    pw_hash = ph.hash(body.password)
    code = f"{secrets.randbelow(1_000_000):06d}"

    with get_conn() as conn, conn.transaction(), conn.cursor() as cur:
        cur.execute("SELECT id, is_verified FROM users WHERE LOWER(email) = %s", (email,))
        email_row = cur.fetchone()
        if email_row and email_row[1]:
            raise HTTPException(status_code=409, detail="An account with this email already exists")

        cur.execute("SELECT id, is_verified FROM users WHERE LOWER(username) = %s", (username.lower(),))
        user_row = cur.fetchone()
        if user_row and user_row[1]:
            raise HTTPException(status_code=409, detail="Username is already taken")

        cur.execute(
            """SELECT created_at FROM otp_codes
               WHERE email = %s AND purpose = 'signup' AND used = FALSE
               ORDER BY created_at DESC LIMIT 1""",
            (email,),
        )
        recent_otp = cur.fetchone()
        if recent_otp and (datetime.now(timezone.utc) - recent_otp[0]).total_seconds() < 60:
            raise HTTPException(status_code=429, detail="Please wait 60 seconds before requesting another OTP")

        if user_row and (not email_row or user_row[0] != email_row[0]) and not user_row[1]:
            cur.execute("DELETE FROM users WHERE id = %s", (user_row[0],))
        if email_row and not email_row[1]:
            cur.execute("DELETE FROM users WHERE id = %s", (email_row[0],))

        cur.execute(
            """INSERT INTO users (full_name, username, email, country, date_of_birth, password_hash, gender_theme, is_verified)
               VALUES (%s, %s, %s, %s, %s, %s, %s, FALSE)""",
            (full_name, username, email, country, body.date_of_birth or None, pw_hash, body.gender_theme),
        )

        cur.execute("UPDATE otp_codes SET used = TRUE WHERE email = %s AND purpose = 'signup' AND used = FALSE", (email,))
        cur.execute(
            """INSERT INTO otp_codes (email, code_hash, purpose, expires_at)
               VALUES (%s, %s, 'signup', %s)""",
            (email, ph.hash(code), datetime.now(timezone.utc) + timedelta(minutes=10)),
        )
    await dispatch_otp_email(email, code, "signup")
    return {"message": "OTP sent", "email": email}


@app.post("/api/auth/login")
async def login(body: LoginBody, request: Request):
    client_ip = request.client.host if request.client else "unknown"
    enforce_rate_limit(f"login:{client_ip}", 25, 900.0)

    email = body.email.lower()
    check_login_lockout(email)

    with get_conn() as conn, conn.transaction(), conn.cursor() as cur:
        cur.execute("SELECT id, password_hash, is_verified FROM users WHERE LOWER(email) = %s", (email,))
        row = cur.fetchone()
        if not row:
            record_login_failure(email)
            raise HTTPException(status_code=404, detail="USER_NOT_FOUND")
        if not row[1]:
            raise HTTPException(status_code=400, detail="GOOGLE_ONLY_ACCOUNT")
        try:
            ph.verify(row[1], body.password)
        except VerifyMismatchError as exc:
            record_login_failure(email)
            raise HTTPException(status_code=401, detail="Incorrect password") from exc

        clear_login_failures(email)
        purpose = "login" if row[2] else "signup"

        cur.execute(
            """SELECT created_at, expires_at FROM otp_codes
               WHERE email = %s AND purpose = %s AND used = FALSE
               ORDER BY created_at DESC LIMIT 1""",
            (email, purpose),
        )
        recent_otp = cur.fetchone()
        now = datetime.now(timezone.utc)
        if recent_otp and recent_otp[1] > now and (now - recent_otp[0]).total_seconds() < 60:
            return {"message": "OTP already sent", "email": email, "purpose": purpose}

        code = f"{secrets.randbelow(1_000_000):06d}"
        cur.execute("UPDATE otp_codes SET used = TRUE WHERE email = %s AND purpose = %s AND used = FALSE", (email, purpose))
        cur.execute(
            """INSERT INTO otp_codes (email, code_hash, purpose, expires_at)
               VALUES (%s, %s, %s, %s)""",
            (email, ph.hash(code), purpose, now + timedelta(minutes=10)),
        )
    await dispatch_otp_email(email, code, purpose)
    return {"message": "OTP sent", "email": email, "purpose": purpose}


@app.post("/api/auth/verify-otp")
def verify_otp(body: VerifyOtpBody, request: Request):
    client_ip = request.client.host if request.client else "unknown"
    enforce_rate_limit(f"verify:{client_ip}", 25, 900.0)

    email = body.email.lower()
    code = body.code.strip()
    if not OTP_CODE_RE.match(code):
        raise HTTPException(status_code=400, detail="Enter a valid 6-digit verification code")

    with get_conn() as conn, conn.transaction(), conn.cursor() as cur:
        cur.execute("SELECT id, is_verified FROM users WHERE LOWER(email) = %s", (email,))
        user_row = cur.fetchone()
        if not user_row:
            raise HTTPException(status_code=404, detail="USER_NOT_FOUND")

        expected_purpose = "signup" if not user_row[1] else "login"
        if body.purpose and body.purpose != expected_purpose:
            raise HTTPException(status_code=400, detail="Verification purpose mismatch")

        cur.execute(
            """SELECT id, code_hash, attempts, expires_at FROM otp_codes
               WHERE email = %s AND purpose = %s AND used = FALSE
               ORDER BY created_at DESC LIMIT 1""",
            (email, expected_purpose),
        )
        row = cur.fetchone()
        now = datetime.now(timezone.utc)
        if not row or row[3] <= now or row[2] >= 3:
            if row:
                cur.execute("UPDATE otp_codes SET used = TRUE WHERE id = %s", (row[0],))
            raise HTTPException(status_code=400, detail="OTP invalid or expired")

        try:
            ph.verify(row[1], code)
        except VerifyMismatchError as exc:
            attempts = row[2] + 1
            cur.execute("UPDATE otp_codes SET attempts = %s, used = %s WHERE id = %s", (attempts, attempts >= 3, row[0]))
            raise HTTPException(status_code=400, detail="Incorrect code") from exc

        cur.execute("UPDATE otp_codes SET used = TRUE WHERE id = %s", (row[0],))
        cur.execute("UPDATE users SET is_verified = TRUE, last_seen_at = NOW() WHERE id = %s", (user_row[0],))
        user_id = str(user_row[0])

        refresh_raw = secrets.token_urlsafe(32)
        cur.execute(
            """INSERT INTO sessions (user_id, refresh_token_hash, expires_at)
               VALUES (%s, %s, %s) RETURNING id""",
            (user_id, hash_refresh(refresh_raw), now + timedelta(days=30)),
        )
        session_id = str(cur.fetchone()[0])

    return {
        "accessToken": create_access_token(user_id, session_id, email),
        "refreshToken": refresh_raw,
    }


def _build_unique_username(cur, email: str) -> str:
    raw = re.sub(r"[^a-zA-Z0-9_]", "_", email.split("@", 1)[0]).strip("_")
    base = raw[:20] if len(raw) >= 3 else "couplova"
    candidate = base
    suffix = 1
    while True:
        cur.execute("SELECT 1 FROM users WHERE LOWER(username) = %s", (candidate.lower(),))
        if not cur.fetchone():
            return candidate
        candidate = f"{base[:18]}_{suffix}"
        suffix += 1


@app.post("/api/auth/google")
def google_signin(body: GoogleAuthBody, request: Request):
    client_ip = request.client.host if request.client else "unknown"
    enforce_rate_limit(f"google:{client_ip}", 20, 900.0)

    if not GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=503, detail="GOOGLE_CLIENT_ID not configured")
    try:
        info = google_id_token.verify_oauth2_token(
            body.id_token, google_requests.Request(), GOOGLE_CLIENT_ID
        )
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Invalid Google ID token") from exc

    if info.get("iss") not in ("accounts.google.com", "https://accounts.google.com"):
        raise HTTPException(status_code=401, detail="Invalid Google token issuer")
    if not info.get("email_verified") or not info.get("email"):
        raise HTTPException(status_code=401, detail="Verified Google email required")

    email = info["email"].lower()
    sub = info["sub"]
    with get_conn() as conn, conn.transaction(), conn.cursor() as cur:
        cur.execute("SELECT id, google_sub FROM users WHERE google_sub = %s OR LOWER(email) = %s", (sub, email))
        row = cur.fetchone()
        if row:
            if row[1] and row[1] != sub:
                raise HTTPException(status_code=409, detail="Account linked to a different Google identity")
            user_id = str(row[0])
            cur.execute("UPDATE users SET google_sub = %s, is_verified = TRUE, last_seen_at = NOW() WHERE id = %s", (sub, user_id))
        else:
            unique_username = _build_unique_username(cur, email)
            full_name = sanitize_plain_text(info.get("name") or unique_username)[:80] or unique_username
            cur.execute(
                """INSERT INTO users (full_name, username, email, country, google_sub, gender_theme, is_verified)
                   VALUES (%s, %s, %s, '', %s, %s, TRUE) RETURNING id""",
                (full_name, unique_username, email, sub, body.gender_theme),
            )
            user_id = str(cur.fetchone()[0])

        refresh_raw = secrets.token_urlsafe(32)
        cur.execute(
            "INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES (%s, %s, %s) RETURNING id",
            (user_id, hash_refresh(refresh_raw), datetime.now(timezone.utc) + timedelta(days=30)),
        )
        session_id = str(cur.fetchone()[0])
    return {"accessToken": create_access_token(user_id, session_id, email), "refreshToken": refresh_raw}


@app.post("/api/telemetry/heartbeat")
def heartbeat(session=Depends(require_session)):
    with get_conn() as conn, conn.transaction(), conn.cursor() as cur:
        cur.execute("UPDATE users SET last_seen_at = NOW() WHERE id = %s", (session["sub"],))
        cur.execute("UPDATE sessions SET last_active_at = NOW() WHERE id = %s", (session["session_id"],))
    return {"ok": True}


@app.get("/api/telemetry/stats")
def stats(session=Depends(require_session)):
    if session.get("email", "").lower() != ADMIN_EMAIL:
        raise HTTPException(status_code=403, detail="Admin access required")
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM users WHERE is_verified = TRUE AND last_seen_at >= NOW() - INTERVAL '2 minutes'")
        online = cur.fetchone()[0]
        cur.execute(
            "SELECT COUNT(DISTINCT user_id) FROM sessions WHERE revoked = FALSE AND last_active_at >= NOW() - INTERVAL '30 days'"
        )
        active_30d = cur.fetchone()[0]
    return {"currentlyOnline": online, "totalActiveUsers": active_30d}
