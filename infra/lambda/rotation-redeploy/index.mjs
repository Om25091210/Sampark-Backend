// ADR-061 (2026-09-01). Auto-recover from the 7-day RDS master-password rotation.
//
// The failure it closes
// ---------------------
// RDS owns and rotates the `sampark_app` master password every 7 days
// (manage_master_user_password = true, rds.tf). docker-entrypoint.sh composes
// DATABASE_URL from DB_PASSWORD ONCE, at container start, and never again. A task
// that is still running when the rotation lands keeps the old password in memory;
// from that moment every Prisma query fails with P1000 and every DB-backed route
// (login included) returns 500. It happened on 2026-07-17 (Backend#17, a stale
// COPY in Terraform state -- fixed by ADR-034) and again on 2026-09-01 (a stale
// value in a LONG-RUNNING PROCESS -- not covered by ADR-034, closed here).
//
// What this does
// --------------
// Runs on a schedule (EventBridge rule, every 15 min -- see db_rotation_redeploy.tf).
// Compares the RDS secret's LastRotatedDate against the PRIMARY ECS deployment's
// createdAt. If the running tasks started BEFORE the last rotation, they are holding
// a dead credential: force a new deployment. A fresh task re-runs the entrypoint and
// resolves the secret's AWSCURRENT value, which rotation has already advanced to the
// new password. Then it is a no-op until the next rotation.
//
// Idempotent by construction: after the redeploy the new deployment's createdAt is
// newer than LastRotatedDate, so the next tick does nothing. A rollout already in
// flight is left alone.
//
// AWS SDK v3 is bundled in the nodejs22.x Lambda runtime -- no node_modules, no
// bundler, nothing to `npm ci`. This file IS the deployment package.

import { ECSClient, DescribeServicesCommand, UpdateServiceCommand } from '@aws-sdk/client-ecs';
import { SecretsManagerClient, DescribeSecretCommand } from '@aws-sdk/client-secrets-manager';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

const REGION = process.env.AWS_REGION;
const CLUSTER = requireEnv('CLUSTER_NAME');
const SERVICE = requireEnv('SERVICE_NAME');
const DB_SECRET_ARN = requireEnv('DB_SECRET_ARN');
const ALERTS_TOPIC_ARN = requireEnv('ALERTS_TOPIC_ARN');

const ecs = new ECSClient({ region: REGION });
const secrets = new SecretsManagerClient({ region: REGION });
const sns = new SNSClient({ region: REGION });

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set on the Lambda -- check db_rotation_redeploy.tf`);
  return v;
}

export const handler = async () => {
  const secret = await secrets.send(new DescribeSecretCommand({ SecretId: DB_SECRET_ARN }));
  // LastRotatedDate is set only by an actual rotation. It is absent until the first
  // one; nothing to react to before then.
  const rotatedAt = secret.LastRotatedDate ? new Date(secret.LastRotatedDate) : null;
  if (rotatedAt === null) {
    console.log('secret has never rotated; nothing to do');
    return { redeployed: false, reason: 'never-rotated' };
  }

  const { services } = await ecs.send(
    new DescribeServicesCommand({ cluster: CLUSTER, services: [SERVICE] }),
  );
  const service = services?.[0];
  if (!service) throw new Error(`ECS service ${SERVICE} not found on cluster ${CLUSTER}`);

  const primary = (service.deployments ?? []).find((d) => d.status === 'PRIMARY');
  if (!primary) throw new Error('no PRIMARY deployment on the service');

  // Don't stack a redeploy on top of one already rolling out -- let it settle and
  // re-check next tick. The in-flight deployment is new enough by definition.
  if (primary.rolloutState === 'IN_PROGRESS') {
    console.log('a deployment is already in progress; skipping this tick');
    return { redeployed: false, reason: 'rollout-in-progress' };
  }

  const deployStartedAt = new Date(primary.createdAt);

  if (deployStartedAt >= rotatedAt) {
    console.log(
      `deployment started ${deployStartedAt.toISOString()} >= last rotation ` +
        `${rotatedAt.toISOString()}; credential is current`,
    );
    return { redeployed: false, reason: 'up-to-date' };
  }

  // The running tasks predate the current password. Force a fresh rollout.
  console.warn(
    `STALE CREDENTIAL: deployment started ${deployStartedAt.toISOString()}, ` +
      `password rotated ${rotatedAt.toISOString()} -- forcing new deployment`,
  );

  await ecs.send(
    new UpdateServiceCommand({
      cluster: CLUSTER,
      service: SERVICE,
      forceNewDeployment: true,
    }),
  );

  const message =
    `SAMPARK ${CLUSTER}: forced an ECS redeploy of ${SERVICE}.\n\n` +
    `The RDS master password rotated at ${rotatedAt.toISOString()} but the running ` +
    `tasks started at ${deployStartedAt.toISOString()} and were still holding the ` +
    `old credential (Prisma P1000). A fresh task will pick up the new password.\n\n` +
    `This is automatic recovery (ADR-061). No action needed unless /readyz is ` +
    `still failing ~5 minutes from now.`;

  await sns.send(
    new PublishCommand({
      TopicArn: ALERTS_TOPIC_ARN,
      Subject: `SAMPARK: auto-redeploy after DB password rotation`,
      Message: message,
    }),
  );

  return { redeployed: true, rotatedAt: rotatedAt.toISOString() };
};
