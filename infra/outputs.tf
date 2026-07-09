output "vpc_id" {
  description = "SAMPARK VPC."
  value       = aws_vpc.main.id
}

output "public_subnet_ids" {
  description = "ALB and Fargate task subnets."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "RDS subnets. No route to the internet."
  value       = aws_subnet.private[*].id
}

output "ecr_repository_url" {
  description = "Push target for CI. Set as the ECR_REGISTRY workflow input."
  value       = aws_ecr_repository.backend.repository_url
}

output "media_bucket_name" {
  description = "Passed to the task as the plain S3_BUCKET env var -- not a secret."
  value       = aws_s3_bucket.media.bucket
}

output "cloudwatch_log_group" {
  description = "Task stdout/stderr, 30-day retention."
  value       = aws_cloudwatch_log_group.backend.name
}

output "app_secret_arn" {
  description = "Runtime secret. Values are placeholders until rotated by hand; see infra/README.md."
  value       = aws_secretsmanager_secret.app.arn
}

output "ecs_task_execution_role_arn" {
  description = "Pulls images, resolves secrets[], ships logs."
  value       = aws_iam_role.ecs_task_execution.arn
}

output "ecs_task_role_arn" {
  description = "Assumed by the application process. Media objects only."
  value       = aws_iam_role.ecs_task.arn
}

output "github_actions_role_arn" {
  description = "Set as the `role-to-assume` input of aws-actions/configure-aws-credentials. No static keys."
  value       = aws_iam_role.github_actions.arn
}

output "github_oidc_provider_arn" {
  description = "GitHub's OIDC identity provider in this account."
  value       = aws_iam_openid_connect_provider.github.arn
}

# Deliberately NOT output: the secret's value. `terraform output` would render it,
# and outputs are stored in plaintext inside the state file regardless of the
# `sensitive` flag -- which only redacts CLI display, not storage.
