// ADR-035 / Backend#18. Probes /readyz on a schedule so a broken backend is
// discovered by a machine instead of by a person happening to try something.
//
// Why this exists at all
// ----------------------
// On 2026-07-17 staging could not authenticate to its database for 40 minutes.
// Every DB-backed route returned 500. Every signal said healthy:
//
//   ecs wait services-stable  -> SERVICE STABLE
//   ALB target health         -> healthy
//   GET /healthz              -> 200 {"status":"ok"}
//   GET /readyz               -> 503 {"status":"not_ready"}   <- correct, unread
//
// `/healthz` is LIVENESS: a process with a dead database passes it forever, so the
// ALB kept routing traffic to a task that could not answer any of it. `/readyz` was
// right the whole time and nothing was asking.
//
// A log metric filter cannot fix that (no request, no log line) and an ALB 5XX
// alarm cannot either (no traffic at 05:30, no 5XX, no alarm). The gap is that
// nothing PROBES readiness. This does.

const synthetics = require('Synthetics');
const log = require('SyntheticsLogger');

const READYZ_URL = process.env.READYZ_URL;
// The body must say this. A 200 is necessary but NOT sufficient — see below.
const EXPECTED = '"status":"ready"';

const checkReadyz = async function () {
  if (!READYZ_URL) {
    throw new Error('READYZ_URL is not set — the canary has nothing to probe');
  }

  // `false` = do not follow redirects. A redirect to a login page returning 200
  // would otherwise read as healthy.
  const requestOptionsStep = {
    hostname: new URL(READYZ_URL).hostname,
    method: 'GET',
    path: new URL(READYZ_URL).pathname,
    port: new URL(READYZ_URL).port || 80,
    protocol: new URL(READYZ_URL).protocol,
  };

  const stepConfig = {
    includeRequestHeaders: false,
    includeResponseHeaders: false,
    restrictedHeaders: [],
    includeRequestBody: false,
    includeResponseBody: true,
    continueOnHttpStepFailure: false,
  };

  await synthetics.executeHttpStep(
    'readyz',
    requestOptionsStep,
    async function (res) {
      return new Promise((resolve, reject) => {
        if (res.statusCode !== 200) {
          // This is the 2026-07-17 signature: readiness correctly reporting 503.
          reject(new Error(`/readyz returned ${res.statusCode} — the backend is not ready`));
          return;
        }

        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          // Assert the BODY, not just the status. `/readyz` is the endpoint that is
          // supposed to tell the truth; if it ever regresses into answering 200 with
          // `not_ready`, a status-only check would call that healthy and we would be
          // back to trusting a signal that cannot fail.
          if (!body.includes(EXPECTED)) {
            reject(new Error(`/readyz returned 200 but body was ${body} — expected ${EXPECTED}`));
            return;
          }
          log.info('readyz OK: ' + body);
          resolve();
        });
        res.on('error', reject);
      });
    },
    stepConfig,
  );
};

exports.handler = async () => {
  return await checkReadyz();
};
