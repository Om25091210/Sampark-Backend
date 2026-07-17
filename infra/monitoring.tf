# ---------------------------------------------------------------------------
# Readiness monitoring (ADR-035, Backend#18)
#
# On 2026-07-17 staging could not reach its database for 40 minutes and every
# signal reported healthy: `ecs wait services-stable` said STABLE, the ALB target
# was `healthy`, and /healthz returned 200 -- because /healthz is LIVENESS and a
# process with a dead database passes it forever. /readyz returned a correct 503
# the entire time, and nothing was asking. It was found by a person, by accident.
#
# The gap is not "the wrong metric". It is that NOTHING PROBES READINESS:
#   - a logs metric filter cannot fire   -> no request, no log line
#   - an ALB 5XX alarm cannot fire       -> no traffic at 05:30, no 5XX
# Both are traffic-dependent, and the next failure (Backend#17's rotation) was
# scheduled for 05:30 when nobody is awake.
#
# So: an active prober, in-region, plus somewhere loud for it to shout.
# ---------------------------------------------------------------------------

# Canary artifacts (screenshots, HAR, logs). Separate from the media bucket: this
# is operational exhaust, it is not user data, and it must not share a lifecycle
# or a blast radius with cadre photos.
resource "aws_s3_bucket" "canary_artifacts" {
  bucket        = "${local.name_prefix}-canary-artifacts-${data.aws_caller_identity.current.account_id}"
  force_destroy = true # staging: nothing here is worth blocking a teardown

  tags = { Name = "${local.name_prefix}-canary-artifacts" }
}

resource "aws_s3_bucket_public_access_block" "canary_artifacts" {
  bucket                  = aws_s3_bucket.canary_artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "canary_artifacts" {
  bucket = aws_s3_bucket.canary_artifacts.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Canary runs cost storage forever otherwise. 31 days matches the failure retention
# below -- an artifact outliving the run it belongs to helps nobody.
resource "aws_s3_bucket_lifecycle_configuration" "canary_artifacts" {
  bucket = aws_s3_bucket.canary_artifacts.id
  rule {
    id     = "expire-canary-artifacts"
    status = "Enabled"
    filter {}
    expiration { days = 31 }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}

# ---------------------------------------------------------------------------
# Canary execution role
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "canary_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"] # Synthetics canaries run as Lambda
    }
  }
}

resource "aws_iam_role" "canary" {
  name               = "${local.name_prefix}-canary-role"
  assume_role_policy = data.aws_iam_policy_document.canary_assume.json
  tags               = { Name = "${local.name_prefix}-canary-role" }
}

data "aws_iam_policy_document" "canary" {
  statement {
    sid       = "WriteArtifacts"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.canary_artifacts.arn}/*"]
  }

  # Synthetics resolves the bucket's region before writing. Without this the canary
  # fails at upload with an opaque error, AFTER the check itself passed.
  statement {
    sid       = "LocateArtifactBucket"
    effect    = "Allow"
    actions   = ["s3:GetBucketLocation"]
    resources = [aws_s3_bucket.canary_artifacts.arn]
  }

  statement {
    sid       = "WriteCanaryLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:CreateLogGroup"]
    resources = ["arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/cwsyn-*"]
  }

  # The metric this whole file exists to produce. Scoped by namespace: the canary
  # has no business writing anywhere else.
  statement {
    sid       = "PublishCanaryMetrics"
    effect    = "Allow"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["CloudWatchSynthetics"]
    }
  }

  # Required for the canary to enumerate its own artifact location.
  statement {
    sid       = "ListArtifactBucket"
    effect    = "Allow"
    actions   = ["s3:ListAllMyBuckets"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "canary" {
  name   = "${local.name_prefix}-canary"
  role   = aws_iam_role.canary.id
  policy = data.aws_iam_policy_document.canary.json
}

# ---------------------------------------------------------------------------
# The canary
# ---------------------------------------------------------------------------

# Synthetics expects the handler at nodejs/node_modules/<file>.js inside the zip.
# Getting this path wrong fails at canary start with "cannot find module", not at
# plan time.
data "archive_file" "readyz_canary" {
  type        = "zip"
  output_path = "${path.module}/.canary-build/readyz.zip"

  source {
    content  = file("${path.module}/canary/readyz.js")
    filename = "nodejs/node_modules/readyz.js"
  }
}

resource "aws_synthetics_canary" "readyz" {
  # Max 21 chars, lowercase. Not name_prefix'd for that reason.
  name                 = "sampark-stg-readyz"
  artifact_s3_location = "s3://${aws_s3_bucket.canary_artifacts.bucket}/canary/"
  execution_role_arn   = aws_iam_role.canary.arn
  handler              = "readyz.handler"
  zip_file             = data.archive_file.readyz_canary.output_path
  runtime_version      = "syn-nodejs-puppeteer-9.1"
  start_canary         = true

  # Every 15 min = ~2,880 runs/month ~= Rs 300/month, against the Rs 10k budget.
  # 1-minute resolution would cost ~15x for no benefit: nobody acts on a 60-second
  # notice for a staging environment.
  schedule {
    expression = "rate(15 minutes)"
  }

  run_config {
    timeout_in_seconds = 60
    memory_in_mb       = 960
    active_tracing     = false

    environment_variables = {
      # Not a secret: this hostname is in every mobile build.
      #
      # WARNING: the Synthetics API does NOT return environment_variables on read, so
      # Terraform cannot see drift here. If someone repoints READYZ_URL out-of-band
      # (a console edit, a manual `update-canary` during a test), `terraform apply`
      # will report no change and silently leave the drift in place. To force it,
      # taint the canary: `terraform taint aws_synthetics_canary.readyz`.
      READYZ_URL = "http://${aws_lb.main.dns_name}/readyz"
    }
  }

  # No vpc_config: the ALB is internet-facing (alb.tf, internal = false), and a
  # canary inside the VPC would prove the app answers ITSELF rather than that it
  # answers the internet.

  success_retention_period = 7
  failure_retention_period = 31

  tags = { Name = "${local.name_prefix}-readyz-canary" }
}

# ---------------------------------------------------------------------------
# Somewhere loud
# ---------------------------------------------------------------------------

resource "aws_sns_topic" "alerts" {
  name = "${local.name_prefix}-alerts"
  tags = { Name = "${local.name_prefix}-alerts" }
}

# Email needs a one-time click on the AWS confirmation mail. Until that happens the
# subscription sits `PendingConfirmation` and delivers NOTHING -- an alarm wired to
# an unconfirmed topic is the same silence this file exists to end.
resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# SMS is deliberately absent. SNS SMS to Indian numbers is subject to the same
# TRAI/DLT registration (entity + sender ID + template) that Design-Docs#2 needs for
# MSG91 -- unregistered traffic is dropped by the operator, which would be a
# notification channel that silently does not notify. It joins the DLT work, not
# this file.

# ---------------------------------------------------------------------------
# The alarm
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "readyz_failed" {
  alarm_name        = "${local.name_prefix}-readyz-failed"
  alarm_description = <<-EOT
    /readyz is failing: the backend is running but cannot serve requests.

    This is the alarm that did not exist on 2026-07-17, when the RDS master password
    rotated (Backend#17), every DB-backed route returned 500 for 40 minutes, and
    /healthz kept answering 200 so nothing noticed.

    Check, in order:
      1. GET /readyz               -- what is actually failing
      2. CloudWatch /ecs/sampark-backend, filter "err"
      3. Did the RDS password rotate? ADR-034 should make that a non-event.
  EOT

  namespace   = "CloudWatchSynthetics"
  metric_name = "Failed"
  dimensions  = { CanaryName = aws_synthetics_canary.readyz.name }

  statistic           = "Sum"
  period              = 900 # matches the 15-minute schedule: one run per period
  evaluation_periods  = 2   # ~30 min. Two consecutive failures, not one blip.
  datapoints_to_alarm = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"

  # A canary that stops reporting is ALSO a failure. The default ("missing") would
  # treat a dead prober as fine -- rebuilding, exactly, the blind spot this replaces.
  treat_missing_data = "breaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  # Recovery is news too: it says whether a fix worked without watching the console.
  ok_actions = [aws_sns_topic.alerts.arn]

  tags = { Name = "${local.name_prefix}-readyz-failed" }
}
