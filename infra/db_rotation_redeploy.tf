# ---------------------------------------------------------------------------
# Auto-redeploy the backend when the RDS master password rotates (ADR-061)
#
# rds.tf sets manage_master_user_password = true: RDS generates the `sampark_app`
# password, stores it in a secret it owns, and ROTATES IT EVERY 7 DAYS.
# docker-entrypoint.sh composes DATABASE_URL from DB_PASSWORD exactly once, at
# container start (ADR-034). So a task still running when a rotation lands is stuck
# with a dead credential -- every Prisma call returns P1000, every DB-backed route
# (login included) returns 500.
#
#   2026-07-17  Backend#17  a stale COPY of the password in Terraform state.
#                           Fixed by ADR-034: the task now reads DB_PASSWORD straight
#                           from the RDS-owned secret at start.
#   2026-09-01  ADR-061  ADR-034 removed the stale copy but not the stale VALUE
#                           in a long-running process. The task from 2026-08-26 was
#                           still alive when the password rotated at 05:39 IST;
#                           staging login was down ~5 hours until a human forced a
#                           redeploy. THIS FILE closes that gap.
#
# Mechanism: a scheduled Lambda compares the secret's LastRotatedDate with the
# running ECS deployment's createdAt. Tasks older than the last rotation are holding
# a dead password -> force a new deployment (the fresh task resolves the secret's
# AWSCURRENT value, which rotation has already advanced). Worst-case exposure drops
# from "until someone notices" to <= the 15-minute tick, with an SNS note each time
# it acts.
#
# NOT RDS Proxy: Proxy would make rotation genuinely seamless, but it is ~Rs 1,800/mo
# of always-on managed infrastructure against a Rs 10k/mo budget and the
# solo-maintainer simplicity rule. Revisit at the production flip (DESIGN.md Phase 2
# checklist); a 15-minute self-heal is the right cost/robustness point for staging.
# ---------------------------------------------------------------------------

data "archive_file" "rotation_redeploy" {
  type        = "zip"
  source_file = "${path.module}/lambda/rotation-redeploy/index.mjs"
  output_path = "${path.module}/.lambda-build/rotation-redeploy.zip"
}

# ---------------------------------------------------------------------------
# Execution role -- deliberately tiny
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "rotation_redeploy_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "rotation_redeploy" {
  name               = "${local.name_prefix}-rotation-redeploy-role"
  assume_role_policy = data.aws_iam_policy_document.rotation_redeploy_assume.json
  tags               = { Name = "${local.name_prefix}-rotation-redeploy-role" }
}

data "aws_iam_policy_document" "rotation_redeploy" {
  # Metadata only. NOT secretsmanager:GetSecretValue -- the Lambda never reads the
  # password, only LastRotatedDate. This role cannot exfiltrate the credential.
  statement {
    sid       = "ReadRotationTimestamp"
    effect    = "Allow"
    actions   = ["secretsmanager:DescribeSecret"]
    resources = [aws_db_instance.main.master_user_secret[0].secret_arn]
  }

  # Read the deployment's age, then roll it. Scoped to the one service -- same ARN
  # the GitHub Actions deploy role is scoped to (iam.tf / locals.tf).
  statement {
    sid       = "InspectAndRollTheBackendService"
    effect    = "Allow"
    actions   = ["ecs:DescribeServices", "ecs:UpdateService"]
    resources = [local.ecs_service_arn]
  }

  # forceNewDeployment restarts the task under the SAME task-definition revision, so
  # the Lambda never calls RegisterTaskDefinition and needs no iam:PassRole. CI still
  # owns the image; this only recycles what is already deployed.

  statement {
    sid       = "AnnounceOnTheAlertsTopic"
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
  }
}

resource "aws_iam_role_policy" "rotation_redeploy" {
  name   = "${local.name_prefix}-rotation-redeploy"
  role   = aws_iam_role.rotation_redeploy.id
  policy = data.aws_iam_policy_document.rotation_redeploy.json
}

# CreateLogGroup / CreateLogStream / PutLogEvents. The log group is declared
# explicitly below so retention is enforced, but the managed policy is the simplest
# correct grant for the stream writes.
resource "aws_iam_role_policy_attachment" "rotation_redeploy_logs" {
  role       = aws_iam_role.rotation_redeploy.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# ---------------------------------------------------------------------------
# The function
# ---------------------------------------------------------------------------

# Declared, not auto-created, so 30-day retention actually applies (same reasoning
# as logs.tf for the ECS group). Name must match /aws/lambda/<function-name>.
resource "aws_cloudwatch_log_group" "rotation_redeploy" {
  name              = "/aws/lambda/${local.name_prefix}-rotation-redeploy"
  retention_in_days = 30
  tags              = { Name = "/aws/lambda/${local.name_prefix}-rotation-redeploy" }
}

resource "aws_lambda_function" "rotation_redeploy" {
  function_name = "${local.name_prefix}-rotation-redeploy"
  description   = "Force an ECS redeploy when the RDS master password has rotated under a running task (ADR-061)"

  role    = aws_iam_role.rotation_redeploy.arn
  runtime = "nodejs22.x"
  handler = "index.handler"
  # AWS SDK v3 ships in the runtime; the zip is just index.mjs.
  filename         = data.archive_file.rotation_redeploy.output_path
  source_code_hash = data.archive_file.rotation_redeploy.output_base64sha256

  # DescribeSecret + DescribeServices + (maybe) UpdateService + Publish. Comfortably
  # sub-second; 30s is slack for a cold start plus API latency.
  timeout     = 30
  memory_size = 128

  environment {
    variables = {
      CLUSTER_NAME     = aws_ecs_cluster.main.name
      SERVICE_NAME     = aws_ecs_service.backend.name
      DB_SECRET_ARN    = aws_db_instance.main.master_user_secret[0].secret_arn
      ALERTS_TOPIC_ARN = aws_sns_topic.alerts.arn
    }
  }

  depends_on = [
    aws_iam_role_policy.rotation_redeploy,
    aws_iam_role_policy_attachment.rotation_redeploy_logs,
    aws_cloudwatch_log_group.rotation_redeploy,
  ]

  tags = { Name = "${local.name_prefix}-rotation-redeploy" }
}

# ---------------------------------------------------------------------------
# The schedule
# ---------------------------------------------------------------------------

# 15 minutes matches the readyz canary cadence: the two defences converge on the
# same worst-case detection window. ~2,880 invocations/month, all of them a couple
# of describe calls -- effectively free.
resource "aws_cloudwatch_event_rule" "rotation_redeploy" {
  name                = "${local.name_prefix}-rotation-redeploy"
  description         = "Tick the rotation-redeploy check (ADR-061)"
  schedule_expression = "rate(15 minutes)"
  tags                = { Name = "${local.name_prefix}-rotation-redeploy" }
}

resource "aws_cloudwatch_event_target" "rotation_redeploy" {
  rule = aws_cloudwatch_event_rule.rotation_redeploy.name
  arn  = aws_lambda_function.rotation_redeploy.arn
}

resource "aws_lambda_permission" "rotation_redeploy_events" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.rotation_redeploy.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.rotation_redeploy.arn
}

output "rotation_redeploy_lambda" {
  description = "ADR-061 self-heal. Tail it after a rotation: aws logs tail /aws/lambda/<this> --follow"
  value       = aws_lambda_function.rotation_redeploy.function_name
}
