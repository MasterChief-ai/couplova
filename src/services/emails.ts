import nodemailer from 'nodemailer';
import { OTP_TTL_MINUTES } from './security';

export interface EmailTemplatePayload {
  subject: string;
  html: string;
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sanitizeHeaderText(input: string): string {
  return input.replace(/[\r\n\0\u2028\u2029]+/g, ' ').trim();
}

function renderCouplovaEmailShell(params: {
  headingLine1: string;
  headingLine2: string;
  bodyHtml: string;
  ctaLabel?: string;
  ctaUrl?: string;
  otpBlockHtml?: string;
  ignoreLine: string;
}): string {
  const buttonHtml =
    params.ctaLabel && params.ctaUrl
      ? `<div style="margin:26px 0 24px;">
          <a href="${escapeHtml(params.ctaUrl)}" style="display:inline-block;background-color:#1A1113;color:#FAF8F5;font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:15px;font-weight:700;line-height:1;text-decoration:none;padding:15px 26px;border-radius:8px;letter-spacing:-0.01em;">
            ${escapeHtml(params.ctaLabel)}
          </a>
        </div>`
      : '';

  const otpHtml = params.otpBlockHtml ? params.otpBlockHtml : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  </head>
  <body style="margin:0;padding:0;background-color:#ffffff;color:#1A1113;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#ffffff;">
      <tr>
        <td align="left" style="padding:40px 24px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:540px;margin:0 auto;">
            <tr>
              <td style="padding-bottom:24px;">
                <div style="width:42px;height:42px;border-radius:10px;background-color:#FAF8F5;border:1px solid #EAE4DB;text-align:center;line-height:40px;font-family:Georgia,'Times New Roman',serif;font-style:italic;font-weight:700;font-size:24px;color:#1A1113;">
                  c
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding-bottom:18px;">
                <h1 style="margin:0;font-size:24px;line-height:1.28;font-weight:700;letter-spacing:-0.025em;color:#1A1113;">
                  ${escapeHtml(params.headingLine1)}<br />
                  ${escapeHtml(params.headingLine2)}
                </h1>
              </td>
            </tr>
            <tr>
              <td style="font-size:15px;line-height:1.65;color:#3D3235;">
                ${params.bodyHtml}
                ${buttonHtml}
                ${otpHtml}
                <p style="margin:22px 0 0;font-size:14px;line-height:1.6;color:#5B4E52;">
                  ${escapeHtml(params.ignoreLine)}
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding-top:32px;">
                <div style="height:1px;background-color:#EAE6DF;margin-bottom:20px;"></div>
                <div style="font-family:Georgia,'Times New Roman',serif;font-style:italic;font-weight:700;font-size:17px;color:#B8AEB0;margin-bottom:6px;">
                  couplova
                </div>
                <p style="margin:0;font-size:12px;line-height:1.5;color:#9A8F92;">
                  Couplova: For Romeo &amp; Juliet couples deepening love beyond Friday dinner dates.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function buildConfirmEmailTemplate(params: {
  email: string;
  partnerName: string;
  code: string;
  confirmUrl: string;
  expiryMinutes?: number;
}): EmailTemplatePayload {
  const expiry = params.expiryMinutes ?? OTP_TTL_MINUTES;
  const safeEmail = escapeHtml(params.email);
  const safePartner = escapeHtml(params.partnerName || 'your partner');
  const safeCode = escapeHtml(params.code);

  const bodyHtml = `
    <p style="margin:0 0 12px;">
      Real intimacy begins long after the five-star Friday dinner bill is paid. Confirm that
      <a href="mailto:${safeEmail}" style="color:#9E472A;text-decoration:underline;">${safeEmail}</a>
      belongs to you to unlock Couplova for you and ${safePartner}.
    </p>
    <p style="margin:0;">
      Tap the button below to confirm right away, or enter your 6-digit code in the app.
    </p>
  `;

  const otpBlockHtml = `
    <div style="margin:20px 0 4px;padding:18px 20px;background-color:#FAF8F5;border-radius:10px;">
      <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#7A6B6F;margin-bottom:8px;">
        6-Digit Confirmation Code
      </div>
      <div style="font-size:30px;font-weight:700;letter-spacing:0.24em;color:#1A1113;font-variant-numeric:tabular-nums;">
        ${safeCode}
      </div>
      <div style="margin-top:8px;font-size:12px;color:#7A6B6F;">
        Expires in ${expiry} minutes &middot; Single-use, max 3 attempts
      </div>
    </div>
  `;

  return {
    subject: sanitizeHeaderText(`Confirm your email address for Couplova`),
    html: renderCouplovaEmailShell({
      headingLine1: 'Confirm your email address',
      headingLine2: 'to begin your story on Couplova',
      bodyHtml,
      ctaLabel: 'Confirm Email Address',
      ctaUrl: params.confirmUrl,
      otpBlockHtml,
      ignoreLine: "If you didn't request this, you can safely ignore this email.",
    }),
  };
}

export function buildWelcomeEmailTemplate(params: {
  fullName: string;
  partnerName: string;
  appUrl: string;
}): EmailTemplatePayload {
  const firstName = params.fullName.trim().split(/\s+/)[0] || 'there';
  const safeFirst = escapeHtml(firstName);
  const safePartner = escapeHtml(params.partnerName || 'your partner');

  const bodyHtml = `
    <p style="margin:0 0 14px;">
      Welcome, ${safeFirst}. Most nights end with tired small talk across a table or scrolling side by side on the couch.
    </p>
    <p style="margin:0;">
      Couplova is built for the two of you, for Romeo &amp; Juliet nights when the restaurant clears out and you want to ask the questions you never usually say out loud. Put one phone between you and ${safePartner}; all six moods are ready whenever the room gets quiet.
    </p>
  `;

  return {
    subject: sanitizeHeaderText(`Welcome to Couplova: save the small talk for Friday`),
    html: renderCouplovaEmailShell({
      headingLine1: `You and ${params.partnerName || 'your partner'} are in.`,
      headingLine2: 'One shared phone, six intimate moods.',
      bodyHtml,
      ctaLabel: 'Open Couplova',
      ctaUrl: params.appUrl,
      ignoreLine: 'Here is to conversations worth staying up late for.',
    }),
  };
}

export function buildLoginOtpEmailTemplate(params: {
  email: string;
  partnerName: string;
  code: string;
  expiryMinutes?: number;
}): EmailTemplatePayload {
  const expiry = params.expiryMinutes ?? OTP_TTL_MINUTES;
  const safeEmail = escapeHtml(params.email);
  const safePartner = escapeHtml(params.partnerName || 'your partner');
  const safeCode = escapeHtml(params.code);

  const bodyHtml = `
    <p style="margin:0 0 14px;">
      Someone just entered your password to step back into Couplova as
      <span style="font-weight:600;color:#1A1113;">${safeEmail}</span>, ready to pick up where you and ${safePartner} left off after dinner.
    </p>
    <p style="margin:0;">
      If that was you, confirm your sign-in by entering this 6-digit code within ${expiry} minutes:
    </p>
  `;

  const otpBlockHtml = `
    <div style="margin:22px 0 4px;padding:18px 20px;background-color:#FAF8F5;border-radius:10px;">
      <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#7A6B6F;margin-bottom:8px;">
        Sign-In Verification Code
      </div>
      <div style="font-size:30px;font-weight:700;letter-spacing:0.24em;color:#1A1113;font-variant-numeric:tabular-nums;">
        ${safeCode}
      </div>
      <div style="margin-top:8px;font-size:12px;color:#7A6B6F;">
        Expires in ${expiry} minutes &middot; Single-use, max 3 attempts
      </div>
    </div>
  `;

  return {
    subject: sanitizeHeaderText(`Confirm your Couplova sign-in`),
    html: renderCouplovaEmailShell({
      headingLine1: "Confirm it's you",
      headingLine2: 'trying to sign in to Couplova',
      bodyHtml,
      otpBlockHtml,
      ignoreLine:
        "If you're not trying to log in right now, you can safely ignore this email. Your account stays locked without this code.",
    }),
  };
}

export function buildAdminOtpEmailTemplate(params: {
  email: string;
  code: string;
  expiryMinutes?: number;
}): EmailTemplatePayload {
  const expiry = params.expiryMinutes ?? OTP_TTL_MINUTES;
  const safeEmail = escapeHtml(params.email);
  const safeCode = escapeHtml(params.code);

  const bodyHtml = `
    <p style="margin:0 0 14px;">
      An owner sign-in was requested for the Couplova Admin Console under
      <span style="font-weight:600;color:#1A1113;">${safeEmail}</span>.
    </p>
    <p style="margin:0;">
      Enter this single-use verification code within ${expiry} minutes to open live telemetry and account monitoring:
    </p>
  `;

  const otpBlockHtml = `
    <div style="margin:22px 0 4px;padding:18px 20px;background-color:#FAF8F5;border-radius:10px;">
      <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#7A6B6F;margin-bottom:8px;">
        Owner Admin Verification Code
      </div>
      <div style="font-size:30px;font-weight:700;letter-spacing:0.24em;color:#1A1113;font-variant-numeric:tabular-nums;">
        ${safeCode}
      </div>
      <div style="margin-top:8px;font-size:12px;color:#7A6B6F;">
        Expires in ${expiry} minutes &middot; Single-use, max 3 attempts
      </div>
    </div>
  `;

  return {
    subject: sanitizeHeaderText(`Couplova Owner Admin Console Sign-In`),
    html: renderCouplovaEmailShell({
      headingLine1: 'Owner Console Sign-In',
      headingLine2: 'Couplova Telemetry & Audit',
      bodyHtml,
      otpBlockHtml,
      ignoreLine:
        "If you did not request owner console access, ignore this email immediately.",
    }),
  };
}

async function sendViaGmailSmtp(params: {
  to: string;
  subject: string;
  html: string;
}): Promise<{ ok: boolean; errorMessage?: string }> {
  const gmailUser = process.env.GMAIL_SMTP_USER?.trim();
  const gmailAppPassword = process.env.GMAIL_SMTP_APP_PASSWORD?.replace(/\s+/g, '');
  if (!gmailUser || !gmailAppPassword) {
    return { ok: false };
  }

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: gmailUser,
      pass: gmailAppPassword,
    },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 10000,
  });

  try {
    await transporter.sendMail({
      from: `Couplova <${sanitizeHeaderText(gmailUser)}>`,
      to: sanitizeHeaderText(params.to),
      subject: sanitizeHeaderText(params.subject),
      html: params.html,
    });

    return { ok: true };
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message.slice(0, 180) : 'Gmail SMTP send failed';
    console.warn('[Couplova Email] Gmail SMTP failed:', errorMessage);
    return { ok: false, errorMessage };
  } finally {
    transporter.close();
  }
}

export async function dispatchTransactionalEmail(params: {
  to: string;
  subject: string;
  html: string;
}): Promise<{
  deliveredVia: 'resend' | 'gmail' | 'preview';
  providerFailed?: boolean;
  providerStatus?: number;
  providerMessage?: string;
  isSandboxSender?: boolean;
}> {
  const resendKey = process.env.RESEND_API_KEY?.trim();
  const hasValidResendKey = Boolean(
    resendKey && resendKey.startsWith('re_') && !resendKey.includes('xxxx'),
  );
  const fromEmail = process.env.OTP_FROM_EMAIL?.trim() || 'Couplova <onboarding@resend.dev>';
  const isSandboxSender = fromEmail.toLowerCase().includes('onboarding@resend.dev');
  const hasGmailSmtp = Boolean(
    process.env.GMAIL_SMTP_USER?.trim() && process.env.GMAIL_SMTP_APP_PASSWORD?.trim(),
  );

  // If Gmail SMTP is configured and Resend has no custom verified domain sender,
  // send via Gmail SMTP directly without failing on Resend's sandbox restriction.
  if (hasGmailSmtp && (!hasValidResendKey || isSandboxSender)) {
    const gmailResult = await sendViaGmailSmtp(params);
    if (gmailResult.ok) {
      return { deliveredVia: 'gmail', isSandboxSender };
    }
    return {
      deliveredVia: 'preview',
      providerFailed: true,
      providerStatus: 502,
      providerMessage: gmailResult.errorMessage,
      isSandboxSender,
    };
  }

  let resendFailure: { status: number; message: string } | null = null;

  if (hasValidResendKey) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
        headers: {
          Authorization: `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: sanitizeHeaderText(fromEmail),
          to: [sanitizeHeaderText(params.to)],
          subject: sanitizeHeaderText(params.subject),
          html: params.html,
        }),
      });

      if (response.ok) {
        return { deliveredVia: 'resend', isSandboxSender };
      }

      let providerMessage = `Resend returned HTTP ${response.status}`;
      try {
        const errBody = (await response.json()) as { message?: string; name?: string };
        if (errBody?.message) {
          providerMessage = String(errBody.message).slice(0, 220);
        }
      } catch {
        // Ignore parse failures
      }
      console.warn('[Couplova Email] Resend rejected send:', response.status, providerMessage);
      resendFailure = { status: response.status, message: providerMessage };
    } catch (err) {
      const providerMessage =
        err instanceof Error ? err.message.slice(0, 160) : 'Network error reaching Resend';
      console.warn('[Couplova Email] Resend request failed:', providerMessage);
      resendFailure = { status: 502, message: providerMessage };
    }
  }

  // Fallback or primary delivery via Gmail SMTP (works without a custom domain)
  if (hasGmailSmtp) {
    const gmailResult = await sendViaGmailSmtp(params);
    if (gmailResult.ok) {
      return { deliveredVia: 'gmail', isSandboxSender };
    }
    return {
      deliveredVia: 'preview',
      providerFailed: true,
      providerStatus: 502,
      providerMessage: gmailResult.errorMessage || resendFailure?.message,
      isSandboxSender,
    };
  }

  if (resendFailure) {
    return {
      deliveredVia: 'preview',
      providerFailed: true,
      providerStatus: resendFailure.status,
      providerMessage: resendFailure.message,
      isSandboxSender,
    };
  }

  return { deliveredVia: 'preview', providerFailed: false, isSandboxSender };
}
