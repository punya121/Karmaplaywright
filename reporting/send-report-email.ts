import fs from 'fs';
import path from 'path';
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import type { ReportPayload } from './types';

/**
 * Emails Test-Execution-Report.xlsx through Amazon SES after a run.
 *
 * Skips quietly when From/To are not set, so local runs without mail config
 * keep working. A send failure is logged and never fails the test suite.
 *
 * Credentials (any of these, in order):
 *   AWS_SES_ACCESS_KEY_ID / AWS_SES_SECRET_ACCESS_KEY
 *   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
 *   default AWS credential chain (shared config, IAM role, etc.)
 *
 * Required:
 *   E2E_REPORT_EMAIL_FROM   verified SES identity
 *   E2E_REPORT_EMAIL_TO     comma-separated recipients (verified if SES is in sandbox)
 *
 * Optional:
 *   E2E_REPORT_EMAIL=false  skip even when From/To are set
 *   AWS_SES_REGION          default AWS_REGION, then ap-south-1
 *   E2E_REPORT_EMAIL_CC     comma-separated CC
 */

function envFlag(name: string): boolean | undefined {
    const raw = process.env[name]?.trim().toLowerCase();
    if (!raw) return undefined;
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    return undefined;
}

function splitAddresses(value: string | undefined): string[] {
    if (!value) return [];
    return value
        .split(/[,;]/)
        .map((part) => part.trim())
        .filter(Boolean);
}

function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms} ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)} sec`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${(seconds % 60).toFixed(0)}s`;
}

function percent(rate: number): string {
    return `${(rate * 100).toFixed(1)}%`;
}

function encodeSubject(subject: string): string {
    if (/^[\x20-\x7E]*$/.test(subject)) return subject;
    return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

function foldBase64(value: string): string {
    return value.replace(/(.{76})/g, '$1\r\n');
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function buildBodies(payload: ReportPayload): { text: string; html: string } {
    const { totals, modules, runId, baseURL } = payload;
    const when = new Date(payload.startedAt).toLocaleString();

    const moduleLines = modules
        .map(
            (m) =>
                `  ${m.module}: ${m.passed} passed, ${m.failed} failed, ${m.skipped} skipped (${percent(m.passRate)})`,
        )
        .join('\n');

    const text = [
        'Test Execution Report',
        '',
        `Run: ${runId}`,
        `Executed: ${when}`,
        `Duration: ${formatDuration(payload.durationMs)}`,
        `Environment: ${baseURL}`,
        `Playwright: ${payload.playwrightStatus}`,
        '',
        `Total: ${totals.total}  Passed: ${totals.passed}  Failed: ${totals.failed}  Skipped: ${totals.skipped}  Pass: ${percent(totals.passRate)}`,
        '',
        'Module-wise:',
        moduleLines || '  (no tests recorded)',
        '',
        'The Excel workbook is attached.',
    ].join('\n');

    const moduleRows = modules
        .map(
            (m) =>
                `<tr><td>${escapeHtml(m.module)}</td><td>${m.total}</td><td>${m.passed}</td><td>${m.failed}</td><td>${m.skipped}</td><td>${percent(m.passRate)}</td></tr>`,
        )
        .join('');

    const html = `<!DOCTYPE html>
<html><body style="font-family:Segoe UI,Arial,sans-serif;color:#1f2933;line-height:1.4">
  <h2 style="margin:0 0 12px">Test Execution Report</h2>
  <p style="margin:0 0 16px;color:#52606d">
    Run <strong>${escapeHtml(runId)}</strong><br>
    Executed ${escapeHtml(when)} &nbsp;|&nbsp; ${escapeHtml(formatDuration(payload.durationMs))}<br>
    Environment: ${escapeHtml(baseURL)}
  </p>
  <table cellpadding="8" cellspacing="0" style="border-collapse:collapse;margin-bottom:16px">
    <tr style="background:#1f3864;color:#fff">
      <th>Total</th><th>Passed</th><th>Failed</th><th>Skipped</th><th>Pass %</th>
    </tr>
    <tr>
      <td align="center">${totals.total}</td>
      <td align="center" style="color:#006100;font-weight:bold">${totals.passed}</td>
      <td align="center" style="color:#9c0006;font-weight:bold">${totals.failed}</td>
      <td align="center">${totals.skipped}</td>
      <td align="center">${percent(totals.passRate)}</td>
    </tr>
  </table>
  <h3 style="margin:0 0 8px">Module-wise</h3>
  <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;border:1px solid #d9e2ec">
    <tr style="background:#d9e1f2"><th align="left">Module</th><th>Total</th><th>Passed</th><th>Failed</th><th>Skipped</th><th>Pass %</th></tr>
    ${moduleRows || '<tr><td colspan="6">(no tests recorded)</td></tr>'}
  </table>
  <p style="margin-top:16px;color:#52606d">The Excel workbook is attached.</p>
</body></html>`;

    return { text, html };
}

function buildRawMime(options: {
    from: string;
    to: string[];
    cc: string[];
    subject: string;
    text: string;
    html: string;
    attachmentPath: string;
}): Buffer {
    const boundaryMixed = `mixed_${Date.now().toString(16)}`;
    const boundaryAlt = `alt_${Date.now().toString(16)}`;
    const filename = path.basename(options.attachmentPath);
    const fileBytes = fs.readFileSync(options.attachmentPath);
    const fileB64 = foldBase64(fileBytes.toString('base64'));

    const headers = [
        `From: ${options.from}`,
        `To: ${options.to.join(', ')}`,
        ...(options.cc.length ? [`Cc: ${options.cc.join(', ')}`] : []),
        `Subject: ${encodeSubject(options.subject)}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/mixed; boundary="${boundaryMixed}"`,
    ];

    const body = [
        `--${boundaryMixed}`,
        `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`,
        '',
        `--${boundaryAlt}`,
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: 7bit',
        '',
        options.text,
        `--${boundaryAlt}`,
        'Content-Type: text/html; charset="UTF-8"',
        'Content-Transfer-Encoding: 7bit',
        '',
        options.html,
        `--${boundaryAlt}--`,
        `--${boundaryMixed}`,
        'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        `Content-Disposition: attachment; filename="${filename}"`,
        'Content-Transfer-Encoding: base64',
        '',
        fileB64,
        `--${boundaryMixed}--`,
        '',
    ];

    return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body.join('\r\n')}`, 'utf8');
}

function createSesClient(): SESClient {
    const region =
        process.env.AWS_SES_REGION?.trim() || process.env.AWS_REGION?.trim() || 'ap-south-1';

    const accessKeyId =
        process.env.AWS_SES_ACCESS_KEY_ID?.trim() || process.env.AWS_ACCESS_KEY_ID?.trim();
    const secretAccessKey =
        process.env.AWS_SES_SECRET_ACCESS_KEY?.trim() || process.env.AWS_SECRET_ACCESS_KEY?.trim();

    if (accessKeyId && secretAccessKey) {
        return new SESClient({
            region,
            credentials: { accessKeyId, secretAccessKey },
        });
    }

    return new SESClient({ region });
}

export async function sendExcelReportEmail(
    payload: ReportPayload,
    excelFile: string,
): Promise<void> {
    if (envFlag('E2E_REPORT_EMAIL') === false) {
        console.log('[report-email] Skipped — E2E_REPORT_EMAIL is off.');
        return;
    }

    const from = process.env.E2E_REPORT_EMAIL_FROM?.trim();
    const to = splitAddresses(process.env.E2E_REPORT_EMAIL_TO);
    const cc = splitAddresses(process.env.E2E_REPORT_EMAIL_CC);

    if (!from || to.length === 0) {
        console.log(
            '[report-email] Skipped — set E2E_REPORT_EMAIL_FROM and E2E_REPORT_EMAIL_TO to email the Excel report.',
        );
        return;
    }

    if (!fs.existsSync(excelFile)) {
        console.warn(`[report-email] Excel file not found: ${excelFile}`);
        return;
    }

    const { totals, runId } = payload;
    const subject =
        process.env.E2E_REPORT_EMAIL_SUBJECT?.trim() ||
        `Test Execution Report ${runId} — ${totals.passed} passed, ${totals.failed} failed`;

    const { text, html } = buildBodies(payload);
    const raw = buildRawMime({ from, to, cc, subject, text, html, attachmentPath: excelFile });

    const client = createSesClient();
    const result = await client.send(
        new SendRawEmailCommand({
            RawMessage: { Data: raw },
            Source: from,
            Destinations: [...to, ...cc],
        }),
    );

    console.log(`    Email  : sent via SES (${result.MessageId ?? 'ok'}) → ${to.join(', ')}`);
}
