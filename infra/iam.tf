# Three roles, three jobs:
#
#   ecs_task_execution -- assumed by the ECS *agent* before the container starts.
#                         Pulls the image, resolves secrets[], ships logs.
#   ecs_task           -- assumed by the *application process* itself. Touches S3.
#   github_actions     -- assumed by CI via OIDC. Builds, pushes, deploys.
#
# The execution/task split is the whole point: the app process can read and write
# media, but cannot read its own database credentials back out of Secrets Manager.

data "aws_iam_policy_document" "ecs_tasks_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# ---------------------------------------------------------------------------
# ECS task execution role
# ---------------------------------------------------------------------------

resource "aws_iam_role" "ecs_task_execution" {
  name               = "${local.name_prefix}-ecs-task-execution-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json

  tags = { Name = "${local.name_prefix}-ecs-task-execution-role" }
}

# ECR pull + CloudWatch Logs write. AWS-managed; tracks new ECS requirements.
resource "aws_iam_role_policy_attachment" "ecs_task_execution_managed" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Resolving `secrets[]` in the task definition happens here, in the execution role,
# before the container process exists. The task role deliberately has no such grant.
#
# No kms:Decrypt statement: the secret is encrypted with the AWS-managed key
# `aws/secretsmanager`, whose key policy already authorises Secrets Manager to
# decrypt for an authorised GetSecretValue caller. A kms:Decrypt grant here would be
# unscopeable (AWS-managed key policies cannot be edited) and would buy nothing.
# It becomes necessary only if the secret moves to a customer-managed key.
data "aws_iam_policy_document" "ecs_task_execution_secrets" {
  statement {
    sid       = "ReadRuntimeSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.app.arn]
  }
}

resource "aws_iam_role_policy" "ecs_task_execution_secrets" {
  name   = "${local.name_prefix}-read-runtime-secret"
  role   = aws_iam_role.ecs_task_execution.id
  policy = data.aws_iam_policy_document.ecs_task_execution_secrets.json
}

# ---------------------------------------------------------------------------
# ECS task role -- the application process
# ---------------------------------------------------------------------------

resource "aws_iam_role" "ecs_task" {
  name               = "${local.name_prefix}-ecs-task-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json

  tags = { Name = "${local.name_prefix}-ecs-task-role" }
}

# Object-level media access only. src/lib/storage.ts calls PutObject (upload,
# export) and presigns GetObject; it never enumerates the bucket, so s3:ListBucket
# is withheld. A presigned GET is signed locally and needs no extra permission.
#
# This role has NO Secrets Manager grant. The app reads config from process.env,
# already injected by the execution role. Granting it here would let a compromised
# application process read back its own DATABASE_URL and JWT_SECRET.
data "aws_iam_policy_document" "ecs_task_media" {
  statement {
    sid    = "ReadWriteMediaObjects"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    resources = ["${aws_s3_bucket.media.arn}/*"]
  }
}

resource "aws_iam_role_policy" "ecs_task_media" {
  name   = "${local.name_prefix}-media-object-access"
  role   = aws_iam_role.ecs_task.id
  policy = data.aws_iam_policy_document.ecs_task_media.json
}

# Backs `enable_execute_command = true` on the ECS service (ecs.tf). Without these
# four actions the flag is accepted, the service starts, and `aws ecs
# execute-command` fails later with an opaque error.
#
# Resource must be "*": the ssmmessages actions establish a session channel and do
# not support resource-level ARNs. The blast radius is bounded elsewhere -- the
# session lands inside this task's container, and reaching it at all requires
# ecs:ExecuteCommand on the cluster, which only an admin principal holds.
#
# This grant has nothing to do with Secrets Manager. The task role still has NO
# secretsmanager:GetSecretValue -- see the comment on ecs_task_media above.
data "aws_iam_policy_document" "ecs_task_exec" {
  statement {
    sid    = "SsmSessionChannelForExecuteCommand"
    effect = "Allow"
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "ecs_task_exec" {
  name   = "${local.name_prefix}-execute-command"
  role   = aws_iam_role.ecs_task.id
  policy = data.aws_iam_policy_document.ecs_task_exec.json
}

# ---------------------------------------------------------------------------
# GitHub Actions deploy role -- assumed via OIDC (trust policy in github_oidc.tf)
# ---------------------------------------------------------------------------

resource "aws_iam_role" "github_actions" {
  name               = "${local.name_prefix}-github-actions-role"
  description        = "CI: build and push to ECR, register task definitions, roll the ECS service"
  assume_role_policy = data.aws_iam_policy_document.github_actions_assume_role.json

  tags = { Name = "${local.name_prefix}-github-actions-role" }
}

# An allow-list. There is no Deny statement because nothing else is granted:
# RDS, VPC, Secrets Manager values, IAM users, and every Delete* action are absent,
# so they are denied by default.
data "aws_iam_policy_document" "github_actions" {
  # GetAuthorizationToken issues the short-lived `docker login` credential. The API
  # takes no resource, so AWS requires "*". Scoping it is not possible.
  statement {
    sid       = "EcrLogin"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "EcrPushToBackendRepoOnly"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
      "ecr:BatchGetImage",
      "ecr:DescribeImages",
    ]
    resources = [aws_ecr_repository.backend.arn]
  }

  # Both APIs are account-scoped and reject a resource ARN -- AWS requires "*".
  # RegisterTaskDefinition is bounded by the PassRole statement below: CI can only
  # register a definition that references the two roles named there.
  statement {
    sid    = "RegisterTaskDefinitions"
    effect = "Allow"
    actions = [
      "ecs:RegisterTaskDefinition",
      "ecs:DescribeTaskDefinition",
    ]
    resources = ["*"]
  }

  # Scoped to the one service. `ecs wait services-stable` needs DescribeServices.
  statement {
    sid    = "RollTheBackendService"
    effect = "Allow"
    actions = [
      "ecs:UpdateService",
      "ecs:DescribeServices",
    ]
    resources = [local.ecs_service_arn]
  }

  # The real containment boundary on RegisterTaskDefinition. Without PassRole, CI
  # could register a task definition assuming any role in the account. Restricted to
  # the two ECS roles, and only when handed to the ECS tasks service.
  statement {
    sid     = "PassOnlyTheTwoEcsRoles"
    effect  = "Allow"
    actions = ["iam:PassRole"]
    resources = [
      aws_iam_role.ecs_task_execution.arn,
      aws_iam_role.ecs_task.arn,
    ]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "github_actions" {
  name   = "${local.name_prefix}-github-actions-deploy"
  role   = aws_iam_role.github_actions.id
  policy = data.aws_iam_policy_document.github_actions.json
}
