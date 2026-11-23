/**
 * One place that sends transactional email (Resend), with a dev fallback that
 * logs to the console when no RESEND_API_KEY is set. Throws on a Resend error so
 * callers can surface a failure. Returns true if actually emailed.
 */
import { config, emailEnabled } from "../config";

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  devLine?: string,
): Promise<boolean> {
  if (!emailEnabled()) {
    console.log(`[email:dev no RESEND] to=${to} :: ${devLine ?? subject}`);
    return false;
  }
  const { Resend } = await import("resend");
  const resend = new Resend(config.resendApiKey);
  const { error } = await resend.emails.send({ from: config.magicFrom, to, subject, html });
  if (error) throw new Error(`Resend failed: ${JSON.stringify(error)}`);
  return true;
}
